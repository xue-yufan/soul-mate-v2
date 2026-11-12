import fs from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "./types.js";
import { toolResult } from "./types.js";

const WEATHER_MOCK: Record<string, string> = {
  北京: "晴，气温 18~26°C，微风",
  上海: "多云，气温 20~27°C，东南风 3 级",
  广州: "阵雨，气温 24~30°C，南风 2 级",
  深圳: "阴，气温 25~31°C，无持续风向",
  杭州: "晴转多云，气温 19~28°C，微风",
};

export const getTimeTool: Tool = {
  name: "get_time",
  description: "获取当前本地时间和 UTC 时间。用户问时间、日期时调用。",
  parameters: { type: "object", properties: {}, required: [] },
  riskLevel: "safe",
  displayName: "时间",
  async run(): Promise<ToolResult> {
    const now = new Date();
    return toolResult(
      true,
      `本地时间：${now.toLocaleString("zh-CN")}\nUTC 时间：${now.toISOString()}`,
    );
  },
};

export const getWeatherTool: Tool = {
  name: "get_weather",
  description: "查询指定城市的当前天气。用户问天气时调用。",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称，例如北京、上海" },
    },
    required: ["city"],
  },
  riskLevel: "safe",
  displayName: "天气",
  async run(args): Promise<ToolResult> {
    const city = typeof args.city === "string" ? args.city.trim() : "";
    if (!city) return toolResult(false, "", "city 参数缺失");
    return toolResult(
      true,
      `${city}：${WEATHER_MOCK[city] ?? "暂无数据（mock 模式）"}`,
    );
  },
};

function isUnder(target: string, base: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取本地 UTF-8 文本文件。只在用户明确要求查看文件时调用，需要用户确认，最大 64KB。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件的绝对路径" },
    },
    required: ["path"],
  },
  riskLevel: "confirm",
  displayName: "读取文件",
  confirmKey: "read_file",
  async run(args, context): Promise<ToolResult> {
    const raw = typeof args.path === "string" ? args.path.trim() : "";
    if (!raw) return toolResult(false, "", "path 参数缺失");
    const requested = path.resolve(raw);
    if (!fs.existsSync(requested)) {
      return toolResult(false, "", `文件不存在：${requested}`);
    }
    let target: string;
    try {
      target = fs.realpathSync.native(requested);
    } catch (error) {
      return toolResult(
        false,
        "",
        error instanceof Error ? error.message : String(error),
      );
    }
    const allowed = context.settings.tools.allowed_dirs;
    if (allowed.length > 0) {
      let bases: string[];
      try {
        bases = allowed
          .map((item) => path.resolve(item))
          .filter((item) => fs.existsSync(item))
          .map((item) => fs.realpathSync.native(item));
      } catch (error) {
        return toolResult(
          false,
          "",
          `允许目录无效：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!bases.some((base) => isUnder(target, base))) {
        return toolResult(false, "", `路径不在允许范围内：${target}`);
      }
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (error) {
      return toolResult(
        false,
        "",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!stat.isFile()) return toolResult(false, "", `不是文件：${target}`);
    if (stat.size > 64 * 1024) {
      return toolResult(false, "", `文件过大（${stat.size} 字节），上限 65536`);
    }
    try {
      const content = fs.readFileSync(target, "utf-8");
      return toolResult(true, `文件：${target}\n\n${content}`, null, {
        path: target,
        size: stat.size,
      });
    } catch (error) {
      return toolResult(
        false,
        "",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};

export const lookThroughCameraTool: Tool = {
  name: "look_through_camera",
  description:
    "当用户询问眼前看到什么、当前动作或环境，或必须看一帧当前画面才能回答时调用。普通闲聊不要调用，每次请求最多一次，不能用于身份识别。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "希望从当前画面确认的具体问题" },
      reason: { type: "string", description: "为什么必须看当前画面" },
    },
    required: ["question"],
  },
  riskLevel: "confirm",
  displayName: "观察画面",
  async run(args, context): Promise<ToolResult> {
    const question =
      typeof args.question === "string" ? args.question.trim() : "";
    if (!question) return toolResult(false, "", "question 参数缺失");
    if (!context.settings.features.vision) {
      return toolResult(false, "", "视觉能力未开启");
    }
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    try {
      const frame = await context.cameraBroker.requestCapture({
        requestId: context.requestId,
        sessionId: context.sessionId,
        question,
        reason,
        timeoutMs: context.settings.vision.capture_timeout_s * 1000,
        signal: context.signal,
      });
      const { observeImage } = await import("../vision/observer.js");
      const observation = await observeImage(
        context.settings,
        frame.image,
        frame.mimeType,
        question,
        context.signal,
      );
      return toolResult(true, observation, null, {
        mime_type: frame.mimeType,
        image_bytes: frame.image.length,
      });
    } catch (error) {
      return toolResult(
        false,
        "",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};

export function builtinTools(includeVision: boolean): Tool[] {
  return includeVision
    ? [getTimeTool, getWeatherTool, readFileTool, lookThroughCameraTool]
    : [getTimeTool, getWeatherTool, readFileTool];
}
