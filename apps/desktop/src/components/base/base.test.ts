import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { h, nextTick } from "vue";

import BaseButton from "./BaseButton.vue";
import BaseField from "./BaseField.vue";
import BaseModal from "./BaseModal.vue";
import BaseTabs from "./BaseTabs.vue";

afterEach(() => {
    document.body.innerHTML = "";
    document.body.style.overflow = "";
});

describe("前端基础组件", () => {
    it("BaseModal 提供 dialog 语义、Esc 关闭和焦点恢复", async () => {
        const trigger = document.createElement("button");
        trigger.textContent = "打开";
        document.body.append(trigger);
        trigger.focus();

        const wrapper = mount(BaseModal, {
            props: {
                open: false,
                label: "测试弹窗",
            },
            slots: {
                default: '<button class="inside">内部按钮</button>',
            },
        });
        await wrapper.setProps({ open: true });
        await nextTick();

        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog?.getAttribute("aria-modal")).toBe("true");
        expect(dialog?.getAttribute("aria-label")).toBe("测试弹窗");
        expect(document.body.style.overflow).toBe("hidden");

        dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await nextTick();
        expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);

        await wrapper.setProps({ open: false });
        await nextTick();
        expect(document.activeElement).toBe(trigger);
        expect(document.body.style.overflow).toBe("");
        wrapper.unmount();
    });

    it("BaseTabs 支持方向键切换并暴露 tab/panel 关系", async () => {
        const wrapper = mount(BaseTabs, {
            props: {
                modelValue: "one",
                idPrefix: "demo",
                items: [
                    { id: "one", label: "第一" },
                    { id: "two", label: "第二", badge: true },
                ],
            },
        });

        const first = wrapper.get('[role="tab"]');
        expect(first.attributes("aria-selected")).toBe("true");
        expect(first.attributes("aria-controls")).toBe("demo-panel-one");
        await first.trigger("keydown", { key: "ArrowRight" });
        expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["two"]);
    });

    it("BaseButton loading 状态不可重复点击", () => {
        const wrapper = mount(BaseButton, {
            props: { loading: true, ariaLabel: "保存" },
            slots: { default: "保存" },
        });
        expect(wrapper.attributes("disabled")).toBeDefined();
        expect(wrapper.attributes("aria-busy")).toBe("true");
        expect(wrapper.attributes("aria-label")).toBe("保存");
    });

    it("BaseField 将 label、帮助文本和控件关联", () => {
        const wrapper = mount(BaseField, {
            props: {
                label: "名称",
                help: "请输入名称",
            },
            slots: {
                default: ({ controlId, helpId }: { controlId: string; helpId: string }) =>
                    h("input", {
                        id: controlId,
                        "aria-describedby": helpId,
                    }),
            },
        });
        const input = wrapper.get("input");
        const label = wrapper.get("label");
        expect(label.attributes("for")).toBe(input.attributes("id"));
        expect(input.attributes("aria-describedby")).toBe(
            wrapper.get(".base-field-help").attributes("id"),
        );
    });
});
