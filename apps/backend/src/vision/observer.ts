import type { Settings } from "../config/settings.js";

export async function observeImage(
  settings: Settings,
  image: Buffer,
  mimeType: string,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  if (image.length > settings.vision.max_image_bytes) {
    throw new Error(
      `图片过大（${image.length} 字节），上限 ${settings.vision.max_image_bytes}`,
    );
  }
  const response = await fetch(
    `${settings.vision.base_url.replace(/\/$/, "")}/api/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.vision.model,
        messages: [
          {
            role: "user",
            content: `观察当前摄像头画面：${question}\n只输出不超过 80 个汉字的可见事实，不猜身份、年龄、健康等敏感信息。图片类型：${mimeType}`,
            images: [image.toString("base64")],
          },
        ],
        stream: false,
        think: false,
        keep_alive: settings.vision.keep_alive,
        options: {
          num_ctx: settings.vision.num_ctx,
          num_predict: settings.vision.num_predict,
          temperature: 0.1,
        },
      }),
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(settings.vision.timeout_s * 1000),
          ])
        : AbortSignal.timeout(settings.vision.timeout_s * 1000),
    },
  );
  if (!response.ok) {
    throw new Error("本机视觉模型暂时不可用，请确认 Ollama 已启动且模型已下载");
  }
  const body = (await response.json()) as {
    message?: { content?: unknown };
  };
  const content = body.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("视觉模型没有返回最终观察内容");
  }
  return content.trim().slice(0, 1200);
}
