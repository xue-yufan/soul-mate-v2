import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../config/settings.js";
import { LocalAsr, resolveEnginePlan } from "./asr.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalAsr", () => {
  it("prefers sherpa-onnx when both native engines are discoverable", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-asr-plan-"));
    cleanups.push(temp);
    const models = path.join(temp, "models");
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, "model.onnx"), "");
    fs.writeFileSync(path.join(models, "tokens.txt"), "");
    fs.writeFileSync(path.join(models, "ggml-small.bin"), "");
    fs.writeFileSync(path.join(temp, "sherpa-onnx"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(temp, "whisper-cli"), "#!/bin/sh\n");
    const settings = loadSettings();
    settings.features.voice = true;
    settings.voice.engine = "auto";
    settings.voice.command = "";
    settings.voice.args = [];
    settings.voice.model_dir = models;

    const resolved = resolveEnginePlan(settings, {
      pathValue: temp,
      platform: "linux",
    });

    expect(resolved.plan?.engine).toBe("sherpa");
    expect(resolved.plan?.command).toContain("sherpa-onnx");
  });

  it("uses the FP32 model and provider config for OpenVINO", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-asr-npu-"));
    cleanups.push(temp);
    const models = path.join(temp, "models");
    fs.mkdirSync(models);
    fs.writeFileSync(path.join(models, "model.onnx"), "");
    fs.writeFileSync(path.join(models, "model.int8.onnx"), "");
    fs.writeFileSync(path.join(models, "tokens.txt"), "");
    fs.writeFileSync(path.join(temp, "sherpa-onnx"), "#!/bin/sh\n");
    const providerConfig = path.join(temp, "npu.config");
    fs.writeFileSync(providerConfig, "device_type=NPU\n");
    const settings = loadSettings();
    settings.features.voice = true;
    settings.voice.engine = "sherpa";
    settings.voice.command = "";
    settings.voice.args = [];
    settings.voice.model_dir = models;
    settings.voice.provider = "openvino";
    settings.voice.provider_config = providerConfig;

    const resolved = resolveEnginePlan(settings, {
      pathValue: temp,
      platform: "linux",
    });

    expect(resolved.plan?.model?.endsWith("model.onnx")).toBe(true);
    expect(resolved.plan?.args).toContain(
      `--provider=openvino:${providerConfig}`,
    );
  });

  it("runs an explicitly configured native engine and reads its transcript", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-asr-run-"));
    cleanups.push(temp);
    const fixture = fileURLToPath(new URL("./asr.fixture.mjs", import.meta.url));
    const settings = loadSettings();
    settings.features.voice = true;
    settings.voice.engine = "whisper";
    settings.voice.command = process.execPath;
    settings.voice.args = [fixture, "--output", "{output}"];
    settings.voice.model_dir = "";
    const asr = new LocalAsr(settings);

    const result = await asr.transcribe(makeWav(1_600));

    expect(asr.status()).toMatchObject({
      enabled: true,
      available: true,
      engine: "whisper",
    });
    expect(result).toMatchObject({
      text: "你好，这是本地语音识别。",
      engine: "whisper.cpp",
    });
  });
});

function makeWav(samples: number): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}
