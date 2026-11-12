import { EMOTION_INSTRUCTION } from "./emotion.js";

const INFO_ROLE_HINT = `【当前专家：信息查询】
你正在处理一个信息查询请求。
- 简洁、准确，不绕弯子
- 只依据你确实掌握的信息回答，不确定就说不确定，不要编造
- 如果系统提供了工具，优先调用工具获取实时信息；拿到结果后直接回答
- 查不到就直说`;

const VISION_ROLE_HINT = `【当前可用：视觉观察】
当用户询问你眼前看到了什么、用户正在做什么或周围环境，
或只有看一帧当前画面才能准确回答时，可以调用 look_through_camera。
- 普通闲聊、情绪陪伴和不需要当前画面的知识问题不要调用
- 每次用户请求最多看一眼
- 工具没有拿到画面时要直接说明没看清，不要臆测`;

export function buildChatPrompt(
  systemPrompt: string,
  visionAvailable: boolean,
): string {
  return [
    systemPrompt,
    ...(visionAvailable ? [VISION_ROLE_HINT] : []),
    EMOTION_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildInfoPrompt(systemPrompt: string): string {
  return [systemPrompt, INFO_ROLE_HINT, EMOTION_INSTRUCTION]
    .filter(Boolean)
    .join("\n\n");
}
