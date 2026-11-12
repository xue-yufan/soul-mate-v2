<template>
    <Teleport to="body">
        <Transition name="base-modal">
            <div v-if="open" class="base-modal-mask" @click.self="onBackdrop" @keydown="onKeydown">
                <div
                    ref="panel"
                    class="base-modal-panel glass-surface"
                    role="dialog"
                    aria-modal="true"
                    :aria-label="label"
                    tabindex="-1"
                    :style="panelStyle"
                >
                    <header class="base-modal-header">
                        <div class="base-modal-header-content">
                            <slot name="header" />
                        </div>
                        <button
                            class="base-modal-close"
                            type="button"
                            aria-label="关闭"
                            @click="close"
                        >
                            <span aria-hidden="true">×</span>
                        </button>
                    </header>
                    <slot />
                    <footer v-if="$slots.footer" class="base-modal-footer">
                        <slot name="footer" />
                    </footer>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(
    defineProps<{
        open: boolean;
        label: string;
        width?: string;
        maxWidth?: string;
        height?: string;
        maxHeight?: string;
        closeOnBackdrop?: boolean;
        closeOnEscape?: boolean;
    }>(),
    {
        width: "600px",
        maxWidth: "92vw",
        height: "auto",
        maxHeight: "85vh",
        closeOnBackdrop: true,
        closeOnEscape: true,
    },
);

const emit = defineEmits<{
    (event: "update:open", value: boolean): void;
}>();

const panel = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
let previousOverflow = "";

const panelStyle = computed(() => ({
    "--base-modal-width": props.width,
    "--base-modal-max-width": props.maxWidth,
    "--base-modal-height": props.height,
    "--base-modal-max-height": props.maxHeight,
}));

watch(
    () => props.open,
    async (open) => {
        if (open) {
            previousFocus =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
            previousOverflow = document.body.style.overflow;
            document.body.style.overflow = "hidden";
            await nextTick();
            focusFirst();
        } else {
            document.body.style.overflow = previousOverflow;
            previousFocus?.focus();
            previousFocus = null;
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    if (props.open) document.body.style.overflow = previousOverflow;
});

function close(): void {
    emit("update:open", false);
}

function onBackdrop(): void {
    if (props.closeOnBackdrop) close();
}

function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && props.closeOnEscape) {
        event.preventDefault();
        close();
        return;
    }
    if (event.key !== "Tab") return;
    const focusable = getFocusable();
    if (focusable.length === 0) {
        event.preventDefault();
        panel.value?.focus();
        return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function focusFirst(): void {
    const target = getFocusable()[0] ?? panel.value;
    target?.focus();
}

function getFocusable(): HTMLElement[] {
    if (!panel.value) return [];
    return [
        ...panel.value.querySelectorAll<HTMLElement>(
            [
                "button:not([disabled])",
                "a[href]",
                "input:not([disabled])",
                "select:not([disabled])",
                "textarea:not([disabled])",
                '[tabindex]:not([tabindex="-1"])',
            ].join(","),
        ),
    ].filter((element) => element.offsetParent !== null);
}
</script>

<style scoped>
.base-modal-mask {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal, 1000);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4, 16px);
    background: rgba(0, 0, 0, 0.52);
}

.base-modal-panel {
    width: var(--base-modal-width);
    max-width: var(--base-modal-max-width);
    height: var(--base-modal-height);
    max-height: var(--base-modal-max-height);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
    --glass-radius: var(--radius-lg, 16px);
    --glass-blur: 26px;
    --glass-tint: rgba(26, 20, 44, 0.68);
}

.base-modal-header {
    display: flex;
    align-items: center;
    gap: var(--space-3, 12px);
    min-height: 52px;
    padding: 0 var(--space-3, 12px) 0 var(--space-5, 20px);
}

.base-modal-header-content {
    min-width: 0;
    flex: 1;
}

.base-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--hairline-soft);
}

.base-modal-close {
    width: 34px;
    height: 34px;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 8px);
    background: transparent;
    color: var(--text-tertiary);
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
}

.base-modal-close:hover {
    color: var(--text-primary);
    background: var(--surface-strong);
    border-color: var(--hairline);
}

.base-modal-enter-active,
.base-modal-leave-active {
    transition:
        opacity var(--duration-normal, 0.18s) ease,
        transform var(--duration-normal, 0.18s) ease;
}

.base-modal-enter-from,
.base-modal-leave-to {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
}
</style>
