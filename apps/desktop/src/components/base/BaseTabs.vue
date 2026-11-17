<template>
    <nav class="base-tabs" role="tablist" :aria-label="label">
        <button
            v-for="item in items"
            :id="tabId(item.id)"
            :key="item.id"
            class="base-tab"
            :class="{ active: item.id === modelValue }"
            role="tab"
            type="button"
            :aria-selected="item.id === modelValue"
            :aria-controls="panelId(item.id)"
            :tabindex="item.id === modelValue ? 0 : -1"
            :data-tab-value="item.id"
            @click="select(item.id)"
            @keydown="onKeydown"
        >
            {{ item.label }}
            <span v-if="item.badge" class="base-tab-badge" aria-hidden="true" />
            <span v-if="item.badge" class="sr-only">有未保存的改动</span>
        </button>
    </nav>
</template>

<script setup lang="ts">
import { nextTick } from "vue";

export interface BaseTabItem {
    id: string;
    label: string;
    badge?: boolean;
}

const props = defineProps<{
    modelValue: string;
    items: BaseTabItem[];
    idPrefix: string;
    label?: string;
}>();

const emit = defineEmits<{
    (event: "update:modelValue", value: string): void;
}>();

function tabId(value: string): string {
    return `${props.idPrefix}-tab-${value}`;
}

function panelId(value: string): string {
    return `${props.idPrefix}-panel-${value}`;
}

function select(value: string): void {
    emit("update:modelValue", value);
}

async function onKeydown(event: KeyboardEvent): Promise<void> {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = props.items.findIndex((item) => item.id === props.modelValue);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = props.items.length - 1;
    else if (event.key === "ArrowLeft") {
        next = (index - 1 + props.items.length) % props.items.length;
    } else {
        next = (index + 1) % props.items.length;
    }
    const target = props.items[next];
    if (!target) return;
    select(target.id);
    await nextTick();
    document.getElementById(tabId(target.id))?.focus();
}

defineExpose({ tabId, panelId });
</script>

<style scoped>
.base-tabs {
    display: flex;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--hairline-soft);
    box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.15);
}

.base-tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 10px 14px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition:
        color var(--duration-fast) ease,
        border-color var(--duration-fast) ease;
}

.base-tab:hover {
    color: var(--text-secondary);
}

.base-tab.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent-surface-hover);
}

.base-tab-badge {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #c4b5fd;
    box-shadow: 0 0 6px rgba(196, 181, 253, 0.8);
}
</style>
