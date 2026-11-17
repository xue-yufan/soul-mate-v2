import { copyFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(packageDir, "../..");
const targetDir = path.join(workspaceDir, ".cargo-target");
const result = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--manifest-path",
    path.join(packageDir, "Cargo.toml"),
    "--target-dir",
    targetDir,
  ],
  { stdio: "inherit", windowsHide: true },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const names =
  process.platform === "win32"
    ? ["soul_mate_embedding_napi.dll"]
    : process.platform === "darwin"
      ? ["libsoul_mate_embedding_napi.dylib"]
      : ["libsoul_mate_embedding_napi.so"];
const source = names
  .map((name) => path.join(targetDir, "release", name))
  .find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });

if (!source) {
  console.error(`未找到 N-API 构建产物：${names.join(", ")}`);
  process.exit(1);
}

const destinationDir = path.join(packageDir, "dist");
mkdirSync(destinationDir, { recursive: true });
const destination = path.join(destinationDir, "soul-mate-embedding.node");
copyFileSync(source, destination);
console.info(`[Rust 嵌入] N-API 已生成：${destination}`);
