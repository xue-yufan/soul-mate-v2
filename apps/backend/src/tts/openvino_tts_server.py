#!/usr/bin/env python3

import argparse
import io
import json
import threading
import unicodedata
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import openvino as ov
import soundfile as sf


class PiperLexicon:
    def __init__(self, model_dir: Path) -> None:
        self.tokens = self._read_tokens(model_dir / "tokens.txt")
        self.words, self.max_word_length = self._read_lexicon(
            model_dir / "lexicon.txt"
        )
        self.bos = self._require_token("^")
        self.eos = self._require_token("$")

    @staticmethod
    def _read_tokens(path: Path) -> dict[str, int]:
        tokens: dict[str, int] = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) >= 2:
                tokens[parts[0]] = int(parts[1])
        return tokens

    def _read_lexicon(self, path: Path) -> tuple[dict[str, list[int]], int]:
        words: dict[str, list[int]] = {}
        max_length = 1
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) < 2:
                continue
            word = parts[0].lower()
            ids = [self.tokens[token] for token in parts[1:] if token in self.tokens]
            if ids:
                words[word] = ids
                max_length = max(max_length, len(word))
        return words, max_length

    def _require_token(self, token: str) -> int:
        if token not in self.tokens:
            raise RuntimeError(f"TTS token file is missing {token!r}")
        return self.tokens[token]

    def tokenize(self, text: str) -> np.ndarray:
        normalized = unicodedata.normalize("NFKC", text).lower()
        ids: list[int] = []
        index = 0
        while index < len(normalized):
            upper = min(len(normalized), index + self.max_word_length)
            for end in range(upper, index, -1):
                word_ids = self.words.get(normalized[index:end])
                if word_ids is not None:
                    ids.extend(word_ids)
                    index = end
                    break
            else:
                char = normalized[index]
                if not char.isspace() and char in self.tokens:
                    ids.append(self.tokens[char])
                index += 1

        if not ids:
            raise ValueError("text does not contain any pronounceable Chinese tokens")
        return np.asarray([[self.bos, *ids, self.eos]], dtype=np.int64)


class SpeechService:
    FRAME_BUCKET = 64
    MAX_FRAMES = 4096

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.model_dir = Path(args.model_dir).resolve()
        self.cache_dir = Path(args.cache_dir).resolve()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.core = ov.Core()
        self.lexicon = PiperLexicon(self.model_dir)
        self.front_model = self.core.read_model(self.model_dir / "front.onnx")
        self.front = self.core.compile_model(self.front_model, "CPU")
        self.decoder_model = self.core.read_model(self.model_dir / "decoder.onnx")
        self.decoders: dict[int, ov.CompiledModel] = {}
        self.scales = np.asarray([0.667, 1.0, 0.8], dtype=np.float32)
        print(
            f"[OpenVINO TTS] ready: front=CPU, decoder={args.device}, "
            f"model={self.model_dir.name}",
            flush=True,
        )

    def _decoder_for(self, frames: int) -> tuple[ov.CompiledModel, int]:
        bucket = max(
            self.FRAME_BUCKET,
            ((frames + self.FRAME_BUCKET - 1) // self.FRAME_BUCKET)
            * self.FRAME_BUCKET,
        )
        if bucket > self.MAX_FRAMES:
            raise ValueError(f"TTS input is too long: {frames} frames")
        decoder = self.decoders.get(bucket)
        if decoder is not None:
            return decoder, bucket

        model = self.decoder_model.clone()
        model.reshape({model.input(0): [1, 192, bucket]})
        config = {
            "CACHE_DIR": str(self.cache_dir),
            "PERFORMANCE_HINT": "LATENCY",
        }
        decoder = self.core.compile_model(model, self.args.device, config)
        self.decoders[bucket] = decoder
        print(
            f"[OpenVINO TTS] decoder ready: frames={bucket}, "
            f"requested={self.args.device}, "
            f"execution={decoder.get_property('EXECUTION_DEVICES')}",
            flush=True,
        )
        return decoder, bucket

    def synthesize(self, payload: dict) -> bytes:
        text = str(payload.get("text", "")).strip()
        if not text:
            raise ValueError("text must not be empty")

        with self.lock:
            token_ids = self.lexicon.tokenize(text)
            lengths = np.asarray([token_ids.shape[1]], dtype=np.int64)
            features = np.asarray(
                self.front([token_ids, lengths, self.scales])[self.front.output(0)],
                dtype=np.float32,
            )
            if features.ndim != 3 or features.shape[0] != 1:
                raise RuntimeError(
                    f"unexpected TTS frontend output shape: {features.shape}"
                )

            frames = int(features.shape[2])
            if frames <= 0:
                raise RuntimeError("TTS frontend returned no audio frames")
            decoder, bucket = self._decoder_for(frames)
            padded = np.zeros((1, features.shape[1], bucket), dtype=np.float32)
            padded[:, :, :frames] = features
            waveform = np.asarray(
                decoder([padded])[decoder.output(0)],
                dtype=np.float32,
            ).reshape(-1)

        expected_samples = frames * 256
        if waveform.size < expected_samples:
            raise RuntimeError(
                f"TTS decoder returned {waveform.size} samples, "
                f"expected at least {expected_samples}"
            )
        samples = waveform[:expected_samples]
        if not np.isfinite(samples).all() or float(samples.std()) <= 1e-5:
            raise RuntimeError("TTS decoder returned an invalid waveform")

        output = io.BytesIO()
        sf.write(
            output,
            samples,
            samplerate=22_050,
            format="WAV",
            subtype="PCM_16",
        )
        return output.getvalue()


def make_handler(service: SpeechService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SoulMateOpenVinoTts/1"

        def log_message(self, format: str, *args) -> None:
            print(f"[OpenVINO TTS] {format % args}", flush=True)

        def do_GET(self) -> None:
            if self.path == "/openapi.json":
                self.send_json(
                    HTTPStatus.OK,
                    {"paths": {"/tts": {"post": {}}}},
                )
                return
            if self.path == "/healthz":
                self.send_json(HTTPStatus.OK, {"status": "ok"})
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/tts":
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 1_000_000:
                    raise ValueError("invalid request size")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("JSON body must be an object")
                audio = service.synthesize(payload)
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
            except Exception as error:
                self.send_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    {"error": str(error)},
                )

        def send_json(self, status: HTTPStatus, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9890)
    parser.add_argument("--device", default="GPU")
    parser.add_argument("--speaker", default="xiao_ya")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--instruct", default="")
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()

    service = SpeechService(args)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
