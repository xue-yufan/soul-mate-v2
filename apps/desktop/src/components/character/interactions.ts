import type { Emotion } from "@/types/protocol";

export type CharacterInteractionPart = "head" | "body" | "left-hand" | "right-hand" | "none";

export type CharacterInteractionAction = "click" | "double-click" | "drag-end";

export interface CharacterInteraction {
  action: CharacterInteractionAction;
  part: CharacterInteractionPart;
  at: number;
}

export function interactionEmotion(interaction: CharacterInteraction): Emotion | null {
  if (interaction.action === "drag-end") {
    return null;
  }

  switch (interaction.part) {
    case "head":
      return "shy";
    case "body":
    case "left-hand":
    case "right-hand":
      return interaction.action === "double-click" ? "surprised" : "shy";
    default:
      return null;
  }
}

export function interactionDuration(interaction: CharacterInteraction): number {
  if (interaction.action === "double-click") {
    return 1800;
  }
  return interaction.part === "head" ? 1500 : 1000;
}
