import fs from "node:fs";
import { parse as parseYaml } from "yaml";

interface PersonaDocument {
  name: string;
  aliases?: string[];
  background?: string;
  personality?: {
    core_traits?: string[];
    speech_style?: string[];
  };
  likes?: string[];
  dislikes?: string[];
  taboos?: string[];
  relationship?: {
    default?: string;
    on_touch_request?: string;
    on_affirmation?: string;
  };
  rules?: string[];
  tool_confirm?: {
    prompts?: Record<string, string[]>;
    declined?: string[];
    clarify?: string[];
  };
}

function bullets(items: string[] | undefined): string {
  return (items ?? []).map((item) => `- ${item}`).join("\n");
}

export class Persona {
  readonly document: PersonaDocument;
  readonly prompt: string;

  constructor(file: string) {
    if (!fs.existsSync(file)) {
      throw new Error(`人格文件不存在：${file}`);
    }
    const parsed: unknown = parseYaml(fs.readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`人格文件格式错误：${file}`);
    }
    this.document = parsed as PersonaDocument;
    this.prompt = this.buildPrompt();
  }

  private buildPrompt(): string {
    const p = this.document;
    const parts = [`你是${p.name}。`];
    if (p.aliases?.length) parts.push(`别名：${p.aliases.join("、")}。`);
    if (p.background?.trim()) parts.push(`【背景】\n${p.background.trim()}`);
    if (p.personality?.core_traits?.length) {
      parts.push(`【性格】\n${bullets(p.personality.core_traits)}`);
    }
    if (p.personality?.speech_style?.length) {
      parts.push(`【说话方式】\n${bullets(p.personality.speech_style)}`);
    }
    if (p.likes?.length) parts.push(`【喜好】\n${bullets(p.likes)}`);
    if (p.dislikes?.length) parts.push(`【不喜欢】\n${bullets(p.dislikes)}`);
    if (p.taboos?.length) parts.push(`【禁忌】\n${bullets(p.taboos)}`);
    if (p.relationship?.default?.trim()) {
      parts.push(`【与用户的关系】\n${p.relationship.default.trim()}`);
    }
    if (p.relationship?.on_touch_request?.trim()) {
      parts.push(
        `【被要求肢体接触时】\n${p.relationship.on_touch_request.trim()}`,
      );
    }
    if (p.relationship?.on_affirmation?.trim()) {
      parts.push(`【被肯定时】\n${p.relationship.on_affirmation.trim()}`);
    }
    if (p.rules?.length) parts.push(`【行为准则】\n${bullets(p.rules)}`);
    return parts.join("\n\n");
  }

  confirmPrompt(
    toolName: string,
    args: Record<string, unknown>,
    confirmKey?: string,
  ): string {
    const config = this.document.tool_confirm?.prompts ?? {};
    const candidates = (confirmKey ? config[confirmKey] : undefined) ??
      config[toolName] ??
      config.default ?? ["接下来我想动用「{tool}」，阁下可准许？"];
    const detail = String(
      args.path ?? args.city ?? args.question ?? toolName,
    ).slice(0, 80);
    const template =
      candidates[Math.floor(Math.random() * Math.max(1, candidates.length))] ??
      "接下来我想动用「{tool}」，阁下可准许？";
    return template
      .replaceAll("{tool}", toolName)
      .replaceAll("{detail}", detail);
  }
}
