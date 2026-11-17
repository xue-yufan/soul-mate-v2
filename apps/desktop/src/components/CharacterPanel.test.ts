import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import CharacterPanel from "@/components/CharacterPanel.vue";

const CharacterStageStub = defineComponent({
  name: "CharacterStage",
  emits: ["interact", "ready", "failed"],
  setup(_, { emit }) {
    return () =>
      h("button", {
        class: "stage-stub",
        onClick: () =>
          emit("interact", {
            action: "click",
            part: "head",
            at: Date.now(),
          }),
      });
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CharacterPanel", () => {
  it("点击模型头部后临时切换到害羞表情，再回到聊天情绪", async () => {
    vi.useFakeTimers();
    const wrapper = mount(CharacterPanel, {
      props: {
        speaking: false,
        emotion: "happy",
        mouth: { open: 0 },
      },
      global: {
        stubs: { CharacterStage: CharacterStageStub },
      },
    });

    await wrapper.get(".stage-stub").trigger("click");
    expect(wrapper.get(".character-image").classes()).toContain("emotion-shy");

    vi.advanceTimersByTime(1500);
    await nextTick();
    expect(wrapper.get(".character-image").classes()).toContain("emotion-happy");
  });
});
