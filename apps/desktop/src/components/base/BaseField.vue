<template>
    <div class="base-field" role="group" :aria-labelledby="labelId">
        <div class="base-field-head">
            <label :id="labelId" class="base-field-label" :for="controlId">
                {{ label }}
            </label>
            <slot name="label-extra" />
        </div>
        <div class="base-field-control">
            <slot :control-id="controlId" :help-id="helpId" />
            <span v-if="unit" class="base-field-unit">{{ unit }}</span>
        </div>
        <p v-if="lockedBy" :id="helpId" class="base-field-help locked">
            当前由环境变量 <code>{{ lockedBy }}</code> 固定，改这里不会生效。
        </p>
        <p v-else-if="help" :id="helpId" class="base-field-help">
            {{ help }}
        </p>
    </div>
</template>

<script setup lang="ts">
import { useId } from "vue";

withDefaults(
    defineProps<{
        label: string;
        help?: string;
        lockedBy?: string | null;
        unit?: string;
    }>(),
    {
        help: "",
        lockedBy: null,
        unit: "",
    },
);

const id = useId();
const labelId = `${id}-label`;
const controlId = `${id}-control`;
const helpId = `${id}-help`;
</script>

<style scoped>
.base-field {
    padding: 10px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.045);
}

.base-field:last-child {
    border-bottom: 0;
}

.base-field-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: 7px;
}

.base-field-label {
    color: var(--text-primary);
    font-size: var(--text-sm);
}

.base-field-control {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.base-field-unit {
    flex: 0 0 auto;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
}

.base-field-help {
    margin-top: 6px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.6;
}

.base-field-help.locked {
    color: var(--status-warning);
}

.base-field-help code {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--surface-sunken);
    color: var(--status-warning);
}
</style>
