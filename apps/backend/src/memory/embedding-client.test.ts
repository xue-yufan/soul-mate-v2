import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backendRoot, loadSettings } from "../config/settings.js";
import { RustEmbeddingClient } from "./embedding-client.js";

const executable = [
  path.resolve(
    backendRoot(),
    "../../.tmp-cargo-target/release",
    process.platform === "win32"
      ? "soul-mate-agent-rust.exe"
      : "soul-mate-agent-rust",
  ),
  path.resolve(
    backendRoot(),
    "../../packages/agent-rust/target/release",
    process.platform === "win32"
      ? "soul-mate-agent-rust.exe"
      : "soul-mate-agent-rust",
  ),
].find((candidate) => fs.existsSync(candidate));
const modelDir = "D:/my_local_model/paraphrase-multilingual-MiniLM-L12-v2";
const hasRustModel = Boolean(executable) && fs.existsSync(modelDir);

describe.runIf(hasRustModel)("RustEmbeddingClient", () => {
  it("loads the local model and ranks related text above unrelated text", async () => {
    const settings = loadSettings();
    settings.features.memory = true;
    settings.features.rag = false;
    settings.paths.embed_model_dir = modelDir;
    settings.embedding.rust_command = executable!;
    const client = new RustEmbeddingClient(settings);
    try {
      await client.start();
      expect(client.status()).toMatchObject({
        loaded: true,
        dimension: 384,
      });
      const scores = await client.semanticScores("我喜欢和你聊天", [
        "和遐蝶交流让我很开心",
        "服务器硬盘容量是两TB",
      ]);
      expect(scores).not.toBeNull();
      expect(scores![0]!).toBeGreaterThan(scores![1]!);
    } finally {
      await client.close();
    }
  }, 120_000);
});
