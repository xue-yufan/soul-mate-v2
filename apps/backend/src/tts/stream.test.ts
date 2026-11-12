import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../config/settings.js";
import {
  TtsAdapter,
  TtsStream,
  type AudioChunk,
} from "./index.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("TtsStream", () => {
  it("waits for an in-flight synthesis before finish returns", async () => {
    const gate = deferred<AudioChunk>();
    const synthesize = vi.fn(() => gate.promise);
    const adapter = {
      available: true,
      synthesize,
    } as unknown as TtsAdapter;
    const settings = {
      tts: {
        sentence_min_len: 1,
        sentence_max_len: 100,
        max_chars_per_turn: 1000,
      },
    } as Settings;
    const emitted: AudioChunk[] = [];
    const stream = new TtsStream(
      settings,
      adapter,
      (chunk) => emitted.push(chunk),
      new AbortController().signal,
    );

    stream.feed("你好。");
    const finishing = stream.finish();
    expect(emitted).toHaveLength(0);

    const chunk = {
      audio: Buffer.from("wav"),
      format: "wav",
      text: "你好。",
      chars: 3,
    };
    gate.resolve(chunk);

    await expect(finishing).resolves.toEqual({ chunks: 1, chars: 3 });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(emitted).toEqual([chunk]);
  });
});
