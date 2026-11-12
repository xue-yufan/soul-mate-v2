import type { Settings } from "../config/settings.js";

export class SentenceSplitter {
  private buffer = "";

  constructor(
    private readonly options: Pick<
      Settings["tts"],
      "sentence_min_len" | "sentence_max_len"
    >,
  ) {}

  feed(text: string): string[] {
    this.buffer += text;
    const output: string[] = [];

    while (true) {
      const boundary = this.findBoundary();
      if (boundary < 0) break;
      const sentence = this.buffer.slice(0, boundary + 1).trim();
      this.buffer = this.buffer.slice(boundary + 1);
      if (sentence) output.push(sentence);
    }

    if (this.buffer.length >= this.options.sentence_max_len) {
      const sentence = this.buffer
        .slice(0, this.options.sentence_max_len)
        .trim();
      this.buffer = this.buffer.slice(this.options.sentence_max_len);
      if (sentence) output.push(sentence);
    }
    return output;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  private findBoundary(): number {
    const lower = Math.max(0, this.options.sentence_min_len - 1);
    for (let index = lower; index < this.buffer.length; index += 1) {
      const char = this.buffer[index] ?? "";
      if ("。！？!?\n".includes(char)) {
        if (char === "." && /\d/.test(this.buffer[index - 1] ?? "")) {
          continue;
        }
        return index;
      }
      if ("；;，,".includes(char)) {
        const rest = this.buffer.slice(index + 1);
        if (rest.length >= this.options.sentence_min_len) return index;
      }
    }
    return -1;
  }
}
