import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "../config/settings.js";
import { resolveTtsLaunch } from "./index.js";

const temporaryDirs: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-tts-"));
  temporaryDirs.push(directory);
  return directory;
}

function settings(engineDir: string, dataDir: string): Settings {
  return {
    paths: { data_dir: dataDir },
    tts: {
      engine_dir: engineDir,
      base_url: "http://127.0.0.1:9880",
    },
  } as Settings;
}

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveTtsLaunch", () => {
  it("优先直接启动 GPT-SoVITS 虚拟环境命令", () => {
    const root = temporaryDirectory();
    const engineDir = path.join(root, "GPT-SoVITS");
    const scriptsDir = path.join(engineDir, ".venv", "Scripts");
    const configDir = path.join(engineDir, "GPT_SoVITS", "configs");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, "gpt-sovits-api-v2.exe"), "");
    fs.writeFileSync(path.join(configDir, "tts_infer.yaml"), "device: cpu\n");
    const dataDir = path.join(root, "data");

    const launch = resolveTtsLaunch(settings(engineDir, dataDir), {
      platform: "win32",
      baseEnv: { Path: "C:\\Windows\\System32" },
    });

    expect(launch).toMatchObject({
      command: path.join(scriptsDir, "gpt-sovits-api-v2.exe"),
      args: [],
      cwd: engineDir,
      mode: "venv",
    });
    expect(launch.env.VIRTUAL_ENV).toBe(path.join(engineDir, ".venv"));
    expect(launch.env.Path).toContain(scriptsDir);
    const writableConfig = path.join(dataDir, "tts", "tts_infer.yaml");
    expect(launch.env.GPT_SOVITS_TTS_CONFIG).toBe(writableConfig);
    expect(fs.readFileSync(writableConfig, "utf-8")).toBe("device: cpu\n");
  });

  it("uv 回退使用应用数据目录中的可写缓存", () => {
    const root = temporaryDirectory();
    const engineDir = path.join(root, "GPT-SoVITS");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(engineDir, { recursive: true });

    const launch = resolveTtsLaunch(settings(engineDir, dataDir), {
      platform: "win32",
      baseEnv: {
        Path: "C:\\Windows\\System32",
        UV_CACHE_DIR: "Z:\\inaccessible-cache",
      },
      backendRootDir: path.join(root, "backend"),
    });

    const cacheDir = path.join(dataDir, "uv-cache");
    expect(launch.mode).toBe("uv");
    expect(launch.args).toEqual(["run", "--locked", "gpt-sovits-api-v2"]);
    expect(launch.env.UV_CACHE_DIR).toBe(cacheDir);
    expect(fs.existsSync(cacheDir)).toBe(true);
  });

  it("builds a native Rust OpenVINO TTS launch", () => {
    const root = temporaryDirectory();
    const executable = path.join(root, "tts-rust", "soul-mate-tts-rust.exe");
    const modelDir = path.join(root, "models", "qwen3-tts");
    const backendDir = path.join(root, "backend");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(backendDir, { recursive: true });
    fs.writeFileSync(executable, "");
    const value = {
      tts: {
        provider: "openvino",
        model_dir: modelDir,
        base_url: "http://127.0.0.1:9890",
        device: "NPU",
      },
      paths: { data_dir: path.join(root, "data") },
    } as Settings;

    const launch = resolveTtsLaunch(value, {
      backendRootDir: backendDir,
      baseEnv: {},
    });

    expect(launch.mode).toBe("openvino");
    expect(launch.command).toBe(executable);
    expect(launch.args).toContain("--device");
    expect(launch.args).toContain("NPU");
    expect(launch.args).toContain("--model-dir");
    expect(launch.args).toContain(modelDir);
    expect(launch.args).toContain("9890");
  });
});
