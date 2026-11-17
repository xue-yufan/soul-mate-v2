import { describe, expect, it } from "vitest";

import {
  interactionDuration,
  interactionEmotion,
  type CharacterInteraction,
} from "@/components/character/interactions";

function interaction(
  action: CharacterInteraction["action"],
  part: CharacterInteraction["part"],
): CharacterInteraction {
  return { action, part, at: 0 };
}

describe("character interactions", () => {
  it("头部点击触发害羞反应", () => {
    expect(interactionEmotion(interaction("click", "head"))).toBe("shy");
    expect(interactionDuration(interaction("click", "head"))).toBe(1500);
  });

  it("身体或手部双击触发惊讶反应", () => {
    expect(interactionEmotion(interaction("double-click", "body"))).toBe("surprised");
    expect(interactionEmotion(interaction("double-click", "left-hand"))).toBe("surprised");
  });

  it("拖动不改变表情", () => {
    expect(interactionEmotion(interaction("drag-end", "none"))).toBeNull();
  });
});
