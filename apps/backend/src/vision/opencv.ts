import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../config/settings.js";
import { backendRoot } from "../config/settings.js";

const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 8_192;

export interface VisionPreprocessResult {
  image: Buffer;
  mimeType: string;
  used: boolean;
  metrics: Record<string, number> | null;
  applied: string[];
  elapsedMs: number | null;
  fallbackReason: string | null;
}

interface SidecarResponse {
  v?: unknown;
  ok?: unknown;
  image?: unknown;
  mime_type?: unknown;
  metrics?: unknown;
  applied?: unknown;
  elapsed_ms?: unknown;
  error?: unknown;
}

export class OpenCvPreprocessor {
  constructor(private readonly settings: Settings) {}

  get enabled(): boolean {
    return this.settings.vision.opencv.enabled;
  }

  command(): string | null {
    return resolveCommand(this.settings.vision.opencv.command);
  }

  async process(
    image: Buffer,
    mimeType: string,
  ): Promise<VisionPreprocessResult> {
    if (!this.enabled) {
      return fallback(image, mimeType, "OpenCV 预处理未启用");
    }
    const command = this.command();
    if (!command) {
      return fallback(image, mimeType, "未找到 OpenCV sidecar 可执行文件");
    }

    const options = this.settings.vision.opencv;
    try {
      const response = await runSidecar(
        command,
        options.args,
        {
          v: 1,
          image: image.toString("base64"),
          mime_type: mimeType,
          options: {
            max_edge: options.max_edge,
            jpeg_quality: options.jpeg_quality,
          },
        },
        options.timeout_s * 1000,
      );
      if (response.ok !== true) {
        throw new Error(
          typeof response.error === "string"
            ? response.error
            : "OpenCV sidecar 返回失败",
        );
      }
      if (typeof response.image !== "string" || !response.image) {
        throw new Error("OpenCV sidecar 没有返回图片");
      }
      const processed = Buffer.from(response.image, "base64");
      if (processed.length === 0) {
        throw new Error("OpenCV sidecar 返回了空图片");
      }
      if (processed.length > this.settings.vision.max_image_bytes) {
        throw new Error("OpenCV 处理后的图片超过视觉上限");
      }
      const outputMime =
        typeof response.mime_type === "string"
          ? response.mime_type
          : "image/jpeg";
      if (!outputMime.startsWith("image/")) {
        throw new Error("OpenCV sidecar 返回了非图片类型");
      }
      return {
        image: processed,
        mimeType: outputMime,
        used: true,
        metrics: numberRecord(response.metrics),
        applied: stringArray(response.applied),
        elapsedMs:
          typeof response.elapsed_ms === "number"
            ? response.elapsed_ms
            : null,
        fallbackReason: null,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[视觉] OpenCV 预处理失败，回退原图：${reason}`);
      return fallback(image, mimeType, reason);
    }
  }
}

function resolveCommand(configured: string): string | null {
  const executable =
    process.platform === "win32"
      ? "soul-mate-vision-opencv.exe"
      : "soul-mate-vision-opencv";
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  const explicit =
    configured.trim() ||
    process.env.SOUL_MATE_VISION_OPENCV_COMMAND?.trim() ||
    "";
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const candidates = [
    path.resolve(
      backendRoot(),
      "..",
      "..",
      "packages",
      "vision-opencv",
      "dist",
      executable,
    ),
    resourcesPath
      ? path.join(resourcesPath, "vision-opencv", executable)
      : "",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runSidecar(
  command: string,
  args: string[],
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<SidecarResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, response?: SidecarResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response ?? {});
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`OpenCV sidecar 超时（${timeoutMs} ms）`));
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS) {
        child.kill();
        finish(new Error("OpenCV sidecar 输出过大"));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
      if (!line) {
        finish(
          new Error(
            `OpenCV sidecar 没有输出（退出码 ${String(code)}）${
              stderr ? `：${stderr.trim()}` : ""
            }`,
          ),
        );
        return;
      }
      try {
        finish(null, JSON.parse(line) as SidecarResponse);
      } catch {
        finish(new Error("OpenCV sidecar 返回了非法 JSON"));
      }
    });

    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function fallback(
  image: Buffer,
  mimeType: string,
  reason: string,
): VisionPreprocessResult {
  return {
    image,
    mimeType,
    used: false,
    metrics: null,
    applied: [],
    elapsedMs: null,
    fallbackReason: reason,
  };
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) output[key] = raw;
  }
  return output;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
