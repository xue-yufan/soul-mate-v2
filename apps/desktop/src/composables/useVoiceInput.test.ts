import { effectScope, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodePcm16Wav, resampleLinear, useVoiceInput } from "./useVoiceInput";
import { createFakeWebSocket, serverEvent } from "@/test/helpers";

describe("voice input audio encoding", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resamples microphone audio to 16 kHz", () => {
    const input = new Float32Array(480);
    const output = resampleLinear(input, 48_000, 16_000);
    expect(output).toHaveLength(160);
  });

  it("encodes mono 16-bit PCM as a valid WAV container", () => {
    const wav = encodePcm16Wav(new Float32Array([-1, -0.5, 0, 0.5, 1]), 16_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
  });

  it("records WAV, sends it, and forwards the transcript", async () => {
    vi.useFakeTimers();
    const ws = createFakeWebSocket();
    const onText = vi.fn();
    const tracks = [{ stop: vi.fn() }];
    const workletPort = {
      onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
    };
    const gain = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    class FakeAudioContext {
      sampleRate = 48_000;
      destination = {};
      audioWorklet = {
        addModule: vi.fn(async () => {}),
      };
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {});
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createGain() {
        return gain;
      }
    }
    class FakeAudioWorkletNode {
      port = workletPort;
      connect = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => tracks,
        })),
      },
    });

    const scope = effectScope();
    const voice = scope.run(() => useVoiceInput(ws.result, onText))!;
    await voice.toggle();
    expect(voice.recording.value).toBe(true);
    vi.advanceTimersByTime(500);
    workletPort.onmessage?.({
      data: new Float32Array(480).fill(0.1),
    } as MessageEvent<Float32Array>);
    await voice.toggle();

    const audio = ws.sent.find((message) => message.type === "audio_input");
    expect(audio).toMatchObject({
      type: "audio_input",
      data: {
        mime_type: "audio/wav",
        sample_rate: 16_000,
      },
    });
    expect(voice.transcribing.value).toBe(true);

    ws.emit(
      serverEvent(
        "transcription_result",
        {
          text: "语音转写结果",
          engine: "sherpa-onnx",
          elapsed_ms: 20,
        },
        { request_id: audio?.request_id ?? "" },
      ),
    );
    await nextTick();
    expect(onText).toHaveBeenCalledWith("语音转写结果");
    expect(voice.transcribing.value).toBe(false);
    expect(tracks[0]?.stop).toHaveBeenCalled();
    scope.stop();
  });
});
