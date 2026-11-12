<template>
    <button
        class="base-button"
        :class="[`variant-${variant}`, `size-${size}`, { loading }]"
        :type="type"
        :disabled="disabled || loading"
        :aria-label="ariaLabel || undefined"
        :aria-busy="loading || undefined"
    >
        <span v-if="loading" class="base-button-spinner" aria-hidden="true" />
        <slot />
    </button>
</template>

<script setup lang="ts">
withDefaults(
    defineProps<{
        variant?: "primary" | "secondary" | "danger" | "ghost";
        size?: "small" | "medium";
        type?: "button" | "submit" | "reset";
        disabled?: boolean;
        loading?: boolean;
        ariaLabel?: string;
    }>(),
    {
        variant: "secondary",
        size: "medium",
        type: "button",
        disabled: false,
        loading: false,
        ariaLabel: "",
    },
);
</script>

<style scoped>
.base-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: 8px 16px;
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    transition:
        background var(--duration-fast) ease,
        border-color var(--duration-fast) ease,
        opacity var(--duration-fast) ease;
}

.base-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.size-small {
    padding: 5px 10px;
    font-size: var(--text-xs);
}

.variant-primary {
    background: var(--accent-surface);
    color: var(--text-primary);
}

.variant-primary:hover:not(:disabled) {
    background: var(--accent-surface-hover);
}

.variant-secondary {
    background: var(--surface-strong);
    color: var(--text-secondary);
}

.variant-secondary:hover:not(:disabled) {
    background: var(--surface-stronger);
}

.variant-danger {
    background: var(--tint-danger);
    border-color: rgba(224, 128, 128, 0.35);
    color: var(--status-danger);
}

.variant-ghost {
    background: transparent;
    color: var(--text-tertiary);
}

.variant-ghost:hover:not(:disabled) {
    background: var(--surface-strong);
    color: var(--text-primary);
}

.base-button-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: base-button-spin 0.8s linear infinite;
}

@keyframes base-button-spin {
    to {
        transform: rotate(360deg);
    }
}
</style>
