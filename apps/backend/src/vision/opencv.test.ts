import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../config/settings.js";
import { OpenCvPreprocessor } from "./opencv.js";

const temporaryDirectories: string[] = [];
const nativeSidecar = path.resolve(
  import.meta.dirname,
  "../../../../packages/vision-opencv/dist/soul-mate-vision-opencv.exe",
);

function settings() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mate-cv-"));
  temporaryDirectories.push(directory);
  const value = loadSettings();
  value.paths = {
    ...value.paths,
    data_dir: directory,
    sqlite_path: path.join(directory, "soul_mate.db"),
    log_dir: path.join(directory, "logs"),
    log_file: path.join(directory, "logs", "backend.log"),
    chroma_dir: path.join(directory, "chroma"),
    documents_dir: path.join(directory, "documents"),
  };
  value.vision.opencv = {
    enabled: false,
    command: "",
    args: [],
    timeout_s: 2,
    max_edge: 1600,
    jpeg_quality: 86,
  };
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenCV preprocessor", () => {
  it("returns the original image when disabled", async () => {
    const config = settings();
    const preprocessor = new OpenCvPreprocessor(config);
    const original = Buffer.from("original");
    await expect(preprocessor.process(original, "image/jpeg")).resolves.toMatchObject({
      image: original,
      mimeType: "image/jpeg",
      used: false,
      fallbackReason: "OpenCV 预处理未启用",
    });
  });

  it("falls back when the sidecar command is missing", async () => {
    const config = settings();
    config.vision.opencv.enabled = true;
    config.vision.opencv.command = path.join(
      os.tmpdir(),
      "missing-soul-mate-vision-opencv.exe",
    );
    const preprocessor = new OpenCvPreprocessor(config);
    const original = Buffer.from("original");
    const result = await preprocessor.process(original, "image/jpeg");
    expect(result.used).toBe(false);
    expect(result.image).toEqual(original);
    expect(result.fallbackReason).toContain("未找到");
  });

  it("accepts a valid sidecar response", async () => {
    const config = settings();
    config.vision.opencv.enabled = true;
    config.vision.opencv.command = process.execPath;
    config.vision.opencv.args = [
      path.join(import.meta.dirname, "opencv.fixture.mjs"),
    ];
    const preprocessor = new OpenCvPreprocessor(config);
    const result = await preprocessor.process(
      Buffer.from("original"),
      "image/jpeg",
    );
    expect(result).toMatchObject({
      used: true,
      mimeType: "image/jpeg",
      metrics: { blur_variance: 120, brightness: 90 },
      applied: ["fixture"],
      elapsedMs: 2,
      fallbackReason: null,
    });
    expect(result.image.toString()).toBe("processed-image");
  });

  it.runIf(fs.existsSync(nativeSidecar))(
    "runs the compiled OpenCV sidecar against a real image",
    async () => {
      const config = settings();
      config.vision.opencv.enabled = true;
      config.vision.opencv.command = "";
      const preprocessor = new OpenCvPreprocessor(config);
      const image = fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../desktop/src/assets/xiadie.png",
        ),
      );
      const result = await preprocessor.process(image, "image/png");
      expect(result.used).toBe(true);
      expect(result.mimeType).toBe("image/jpeg");
      expect(result.metrics?.width).toBeGreaterThan(0);
      expect(result.metrics?.blur_variance).toBeGreaterThan(0);
      expect(result.image.length).toBeGreaterThan(0);
    },
  );
});
