import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "./config/settings.js";
import { Runtime } from "./runtime.js";

describe("Runtime reload", () => {
  it("can retry after a rejected reload", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-reload-"));
    const settings = loadSettings();
    settings.paths = {
      ...settings.paths,
      data_dir: temp,
      sqlite_path: path.join(temp, "soul_mate.db"),
      log_dir: path.join(temp, "logs"),
      log_file: path.join(temp, "logs", "backend.log"),
      chroma_dir: path.join(temp, "chroma"),
      documents_dir: path.join(temp, "documents"),
    };
    settings.logging.level = "silent";
    const runtime = new Runtime(settings);

    try {
      const invalid = structuredClone(settings);
      invalid.paths.sqlite_path = path.join(temp, "other.db");
      await expect(runtime.reload(invalid)).rejects.toThrow(
        "数据目录变更需要重启后端",
      );

      const valid = structuredClone(settings);
      valid.model.temperature = 0.5;
      await expect(runtime.reload(valid)).resolves.toBeUndefined();
      expect(runtime.settings.model.temperature).toBe(0.5);
    } finally {
      await runtime.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
