import { computed, onUnmounted, readonly, ref, watch, type ComputedRef } from "vue";

import type { UseWebSocketResult } from "./useWebSocket";
import type { AudioInputPayload } from "@/types/protocol";

const TARGET_SAMPLE_RATE = 16_000;
const SILENCE_STOP_MS = 1_200;
const MIN_RECORDING_MS = 300;
const MAX_RECORDING_MS = 30_000;
const VOICE_RMS_THRESHOLD = 0.012;
const VOICE_WORKLET_NAME = "soul-mate-voice-capture";
const VOICE_WORKLET_URL = "voice-capture-worklet.js";

export interface UseVoiceInputResult {
  supported: Readonly<ReturnType<typeof ref<boolean>>>;
  recording: Readonly<ReturnType<typeof ref<boolean>>>;
  transcribing: Readonly<ReturnType<typeof ref<boolean>>>;
  error: Readonly<ReturnType<typeof ref<string | null>>>;
  statusText: ComputedRef<string>;
  toggle: () => Promise<void>;
}

export function useVoiceInput(
  ws: UseWebSocketResult,
  onText: (text: string) => void,
): UseVoiceInputResult {
  const supported = ref(
    typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined",
  );
  const recording = ref(false);
  const transcribing = ref(false);
  const error = ref<string | null>(null);

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let chunks: Float32Array[] = [];
  let inputSampleRate = TARGET_SAMPLE_RATE;
  let startedAt = 0;
  let lastVoiceAt = 0;
  let heardVoice = false;
  let stopping = false;
  let requestId: string | null = null;

  const statusText = computed(() => {
    if (!supported.value) return "语音输入不可用";
    if (recording.value) return "正在聆听，停顿后自动结束";
    if (transcribing.value) return "正在本地识别";
    return "语音输入";
  });

  async function start(): Promise<void> {
    if (!supported.value || recording.value || transcribing.value) return;
    error.value = null;
    stopping = false;
    chunks = [];
    heardVoice = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      await context.resume();
      await context.audioWorklet.addModule(VOICE_WORKLET_URL);
      inputSampleRate = context.sampleRate;
      source = context.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context, VOICE_WORKLET_NAME);
      sink = context.createGain();
      sink.gain.value = 0;
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!recording.value) return;
        const samples = new Float32Array(event.data);
        chunks.push(samples);
        const now = performance.now();
        const rms = rootMeanSquare(samples);
        if (rms >= VOICE_RMS_THRESHOLD) {
          heardVoice = true;
          lastVoiceAt = now;
        }
        if (
          (heardVoice && now - lastVoiceAt >= SILENCE_STOP_MS) ||
          now - startedAt >= MAX_RECORDING_MS
        ) {
          void stopAndTranscribe();
        }
      };
      source.connect(worklet);
      worklet.connect(sink);
      sink.connect(context.destination);
      startedAt = performance.now();
      lastVoiceAt = startedAt;
      recording.value = true;
    } catch (err) {
      cleanupAudio();
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function stopAndTranscribe(): Promise<void> {
    if (!recording.value || stopping) return;
    stopping = true;
    const durationMs = performance.now() - startedAt;
    const capturedRate = inputSampleRate;
    const captured = mergeChunks(chunks);
    recording.value = false;
    cleanupAudio();

    if (durationMs < MIN_RECORDING_MS || captured.length === 0) {
      error.value = "录音太短，请再说一次";
      stopping = false;
      return;
    }
    const samples = resampleLinear(captured, capturedRate, TARGET_SAMPLE_RATE);
    const wav = encodePcm16Wav(samples, TARGET_SAMPLE_RATE);
    requestId = crypto.randomUUID().replaceAll("-", "");
    transcribing.value = true;
    const payload: Omit<AudioInputPayload, "v"> = {
      type: "audio_input",
      request_id: requestId,
      data: {
        audio: bytesToBase64(wav),
        mime_type: "audio/wav",
        sample_rate: TARGET_SAMPLE_RATE,
        duration_ms: Math.round(durationMs),
      },
    };
    if (!ws.send(payload)) {
      requestId = null;
      transcribing.value = false;
      error.value = "连接已断开，语音未发送";
    }
    stopping = false;
  }

  function cleanupAudio(): void {
    if (worklet) {
      worklet.port.onmessage = null;
      try {
        worklet.disconnect();
      } catch {
        // 已断开
      }
    }
    try {
      source?.disconnect();
    } catch {
      // 已断开
    }
    try {
      sink?.disconnect();
    } catch {
      // 已断开
    }
    worklet = null;
    source = null;
    sink = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (context) {
      void context.close().catch(() => undefined);
      context = null;
    }
  }

  function cancel(): void {
    recording.value = false;
    stopping = false;
    cleanupAudio();
    if (transcribing.value) {
      transcribing.value = false;
      requestId = null;
    }
  }

  async function toggle(): Promise<void> {
    if (recording.value) {
      await stopAndTranscribe();
    } else {
      await start();
    }
  }

  const unsubscribeStarted = ws.on("transcription_started", (event) => {
    if (event.type === "transcription_started" && event.request_id === requestId) {
      error.value = null;
    }
  });
  const unsubscribeResult = ws.on("transcription_result", (event) => {
    if (event.type !== "transcription_result" || event.request_id !== requestId) {
      return;
    }
    transcribing.value = false;
    requestId = null;
    const text = event.data.text.trim();
    if (text) onText(text);
  });
  const unsubscribeError = ws.on("transcription_error", (event) => {
    if (event.type !== "transcription_error" || event.request_id !== requestId) {
      return;
    }
    transcribing.value = false;
    requestId = null;
    error.value = event.data.message;
  });

  const stopStatusWatch = watch(
    ws.status,
    (status) => {
      if (status === "connected") return;
      if (recording.value) {
        cancel();
        error.value = "连接已断开，录音已取消";
      } else if (transcribing.value) {
        transcribing.value = false;
        requestId = null;
        error.value = "连接已断开，语音识别已取消";
      }
    },
    { flush: "sync" },
  );

  onUnmounted(() => {
    stopStatusWatch();
    unsubscribeStarted();
    unsubscribeResult();
    unsubscribeError();
    cancel();
  });

  return {
    supported: readonly(supported),
    recording: readonly(recording),
    transcribing: readonly(transcribing),
    error: readonly(error),
    statusText,
    toggle,
  };
}

export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (input.length === 0 || inputRate === outputRate) {
    return new Float32Array(input);
  }
  const outputLength = Math.max(1, Math.round((input.length * outputRate) / inputRate));
  const output = new Float32Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return wav;
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function rootMeanSquare(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    target[offset + index] = text.charCodeAt(index);
  }
}
