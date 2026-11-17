import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(packageDir, "../..");
const targetDir = path.join(workspaceRoot, ".cargo-target");
const releaseDir = path.join(targetDir, "release");
const distDir = path.join(packageDir, "dist");
const executableName =
  process.platform === "win32"
    ? "soul-mate-tts-rust.exe"
    : "soul-mate-tts-rust";

const build = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--manifest-path",
    path.join(packageDir, "Cargo.toml"),
    "--target-dir",
    targetDir,
  ],
  { cwd: workspaceRoot, stdio: "inherit", shell: false },
);
if (build.status !== 0) {
  throw new Error(`TTS Rust sidecar build failed with exit code ${build.status}`);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(path.join(releaseDir, executableName), path.join(distDir, executableName));
for (const name of fs.readdirSync(releaseDir)) {
  if (!/^onnxruntime.*\.dll$/i.test(name)) continue;
  fs.copyFileSync(path.join(releaseDir, name), path.join(distDir, name));
}

const candidates = [
  process.env.OPENVINO_RUNTIME_DIR,
  path.join(workspaceRoot, ".voice-asr", "openvino-runtime-2026.4", "libs"),
  path.join(
    workspaceRoot,
    ".voice-asr",
    "openvino-ort",
    "extracted-intel",
    "runtimes",
    "win-x64",
    "native",
  ),
  path.join(workspaceRoot, ".voice-asr", "sherpa-onnx-npu-129", "bin"),
].filter(Boolean);
const runtimeDir = candidates.find((candidate) => fs.existsSync(path.join(candidate, "openvino_c.dll")));
if (runtimeDir) {
  for (const name of fs.readdirSync(runtimeDir)) {
    if (/^tbb.*_debug\.dll$/i.test(name)) continue;
    if (!/^(openvino.*\.dll|tbb.*\.dll)$/i.test(name)) continue;
    fs.copyFileSync(path.join(runtimeDir, name), path.join(distDir, name));
  }
  console.log(`tts-rust: ${path.join(distDir, executableName)} + OpenVINO Runtime`);
} else {
  console.warn("tts-rust: OpenVINO Runtime not found; set OPENVINO_RUNTIME_DIR for packaging");
}
