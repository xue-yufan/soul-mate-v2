# TTS Rust sidecar

Native replacement for the previous Python TTS service. It loads a Piper VITS
model split into `front.onnx` and `decoder.onnx`, runs the acoustic frontend on
CPU and the vocoder on the configured OpenVINO device, and serves the existing
`/healthz`, `/openapi.json`, and `/tts` HTTP endpoints.

The build script copies `soul-mate-tts-rust` into `dist/`. Set
`OPENVINO_RUNTIME_DIR` to an OpenVINO Runtime `bin` directory; in this workspace
it defaults to `.voice-asr/openvino-runtime-2026.4/libs`, with the sherpa NPU
runtime as a fallback. Required OpenVINO and ONNX Runtime provider DLLs are
copied beside the executable for packaged deployment.

The vocoder graph has dynamic output length, so on first use the sidecar creates
a fixed 64-frame-bucket ONNX model under the application data `tts-cache`
directory. This avoids sharing model files with user-owned model directories.
