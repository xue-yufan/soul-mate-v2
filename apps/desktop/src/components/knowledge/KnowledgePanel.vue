<template>
    <BaseModal
        :open="open"
        label="知识管理"
        width="720px"
        height="560px"
        max-width="90vw"
        max-height="85vh"
        @update:open="emit('update:open', $event)"
    >
        <template #header>
            <BaseTabs
                v-model="activeTab"
                :items="tabItems"
                id-prefix="knowledge"
                label="知识管理分类"
            />
        </template>

        <div
            :id="`knowledge-panel-${activeTab}`"
            class="modal-body"
            role="tabpanel"
            :aria-labelledby="`knowledge-tab-${activeTab}`"
        >
            <MemoryTab v-if="activeTab === 'memory'" :enabled="features.memory" />
            <DocumentsTab v-else-if="activeTab === 'documents'" :enabled="features.rag" />
            <WorldbookTab v-else-if="activeTab === 'worldbook'" :enabled="features.rag" />
            <AuditTab v-else-if="activeTab === 'audit'" :enabled="features.memory" />
        </div>
    </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

import BaseModal from "@/components/base/BaseModal.vue";
import BaseTabs, { type BaseTabItem } from "@/components/base/BaseTabs.vue";
import AuditTab from "./AuditTab.vue";
import DocumentsTab from "./DocumentsTab.vue";
import MemoryTab from "./MemoryTab.vue";
import WorldbookTab from "./WorldbookTab.vue";

type TabKey = "memory" | "documents" | "worldbook" | "audit";

const props = defineProps<{
    open: boolean;
    features: {
        memory: boolean;
        rag: boolean;
    };
}>();

const emit = defineEmits<{
    (e: "update:open", value: boolean): void;
}>();

const tabItems: BaseTabItem[] = [
    { id: "memory", label: "记忆" },
    { id: "documents", label: "文档" },
    { id: "worldbook", label: "设定" },
    { id: "audit", label: "审计" },
];

const activeTab = ref<TabKey>("memory");

// 每次打开时根据功能开关选择默认 Tab
watch(
    () => props.open,
    (open) => {
        if (!open) {
            return;
        }
        if (props.features.memory) {
            activeTab.value = "memory";
        } else if (props.features.rag) {
            activeTab.value = "documents";
        } else {
            // 两个功能都关时，唯一有意义的是空审计页（虽然也会显示"未开启"）
            activeTab.value = "audit";
        }
    },
);
</script>

<style scoped>
.modal-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}
</style>
