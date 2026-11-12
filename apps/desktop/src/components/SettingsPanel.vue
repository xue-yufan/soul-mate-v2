<template>
    <BaseModal
        :open="open"
        label="设置"
        width="600px"
        max-width="92vw"
        max-height="82vh"
        @update:open="emit('update:open', $event)"
    >
        <template #header>
            <span class="modal-title">设置</span>
        </template>

        <BaseTabs
            v-model="activeTab"
            :items="tabItems"
            id-prefix="settings"
            label="设置分类"
            class="settings-tabs"
        />

        <div
            class="modal-body"
            role="tabpanel"
            :id="`settings-panel-${activeTab}`"
            :aria-labelledby="`settings-tab-${activeTab}`"
        >
            <p v-if="activeTabMeta" class="group-desc">
                {{ activeTabMeta.description }}
            </p>

            <!-- ---------------- 本机设置（前端 localStorage） ---------------- -->
            <template v-if="activeTab === 'local'">
                <BaseField
                    label="本机播放"
                    help='只是这台机器上"要不要出声"。后端语音开关在「语音」页，两者互相独立。'
                >
                    <template #default="{ controlId, helpId }">
                        <label class="switch">
                            <input
                                :id="controlId"
                                type="checkbox"
                                :checked="local.settings.value.ttsEnabled"
                                :aria-describedby="helpId"
                                @change="onTtsEnabledChange"
                            />
                            <span class="slider"></span>
                        </label>
                    </template>
                </BaseField>

                <BaseField
                    :label="`播放音量：${Math.round(local.settings.value.ttsVolume * 100)}%`"
                >
                    <template #default="{ controlId }">
                        <input
                            :id="controlId"
                            type="range"
                            class="slider-input"
                            min="0"
                            max="100"
                            :value="local.settings.value.ttsVolume * 100"
                            @input="onVolumeChange"
                        />
                    </template>
                </BaseField>

                <div class="reset-line">
                    <BaseButton variant="secondary" @click="local.reset()">
                        恢复本机默认
                    </BaseButton>
                </div>
            </template>

            <!-- ---------------- 关于（只读） ---------------- -->
            <template v-else-if="activeTab === 'about'">
                <template v-if="config.config.value">
                    <div class="row">
                        <span class="label">应用</span>
                        <span class="value">
                            {{ config.config.value.app.name }}
                            v{{ config.config.value.app.version }}
                        </span>
                    </div>
                    <div class="row">
                        <span class="label">模型接入</span>
                        <span class="value">
                            {{ config.config.value.model.provider }} /
                            {{ config.config.value.model.adapter }}
                        </span>
                    </div>

                    <!-- 这一行单独做成可写的：关于页是用户最常翻的地方，
                             "看到已设置却改不了"很难受。 -->
                    <BaseField
                        label="API 密钥"
                        :locked-by="apiKeySpec?.locked_by"
                        :help="
                            apiKeyLocked
                                ? '当前由环境变量固定，改这里不会生效。'
                                : '只在点保存时写入，之后不再回显；保存后立刻生效，不用重启。'
                        "
                    >
                        <template #label-extra>
                            <span
                                v-if="!apiKeyLocked"
                                class="key-state"
                                :class="{ set: apiKeySet }"
                            >
                                {{ apiKeySet ? "已设置" : "未设置" }}
                            </span>
                        </template>
                        <template #default="{ controlId, helpId }">
                            <input
                                :id="controlId"
                                v-model="apiKeyDraft"
                                class="control"
                                type="password"
                                autocomplete="new-password"
                                :aria-describedby="helpId"
                                :placeholder="
                                    apiKeySet ? '已设置（留空表示不修改）' : '粘贴你的 API 密钥'
                                "
                                :disabled="apiKeyLocked || apiKeySaving"
                                @keydown.enter="onSaveApiKey"
                            />
                            <BaseButton
                                variant="primary"
                                :disabled="!canSaveApiKey"
                                :loading="apiKeySaving"
                                @click="onSaveApiKey"
                            >
                                {{ apiKeySaving ? "保存中..." : "保存" }}
                            </BaseButton>
                        </template>
                    </BaseField>
                </template>
                <div v-else class="hint">后端未就绪，读不到配置。</div>
            </template>

            <!-- ---------------- 后端可写字段 ---------------- -->
            <template v-else>
                <div v-if="config.loading.value" class="hint">加载中...</div>

                <div v-else-if="config.error.value" class="hint error">
                    读取失败：{{ config.error.value }}
                </div>

                <div v-else-if="!config.config.value" class="hint">
                    后端未就绪，暂时改不了这些设置。
                </div>

                <template v-else>
                    <BaseField
                        v-for="field in visibleFields"
                        :key="field.path"
                        :label="field.label"
                        :help="field.help"
                        :locked-by="field.locked_by"
                        :unit="field.unit"
                    >
                        <template #label-extra>
                            <span v-if="field.locked_by" class="lock">由环境变量固定</span>
                        </template>
                        <template #default="{ controlId, helpId }">
                            <label v-if="field.kind === 'bool'" class="switch">
                                <input
                                    :id="controlId"
                                    v-model="boolDraft[field.path]"
                                    type="checkbox"
                                    :aria-describedby="field.help ? helpId : undefined"
                                    :disabled="isLocked(field)"
                                />
                                <span class="slider"></span>
                            </label>

                            <select
                                v-else-if="field.kind === 'select'"
                                :id="controlId"
                                v-model="textDraft[field.path]"
                                class="control"
                                :aria-describedby="field.help ? helpId : undefined"
                                :disabled="isLocked(field)"
                            >
                                <option
                                    v-for="option in field.options"
                                    :key="option"
                                    :value="option"
                                >
                                    {{ field.option_labels[option] ?? option }}
                                </option>
                            </select>

                            <textarea
                                v-else-if="field.kind === 'lines'"
                                :id="controlId"
                                v-model="textDraft[field.path]"
                                class="control textarea"
                                rows="3"
                                :aria-describedby="field.help ? helpId : undefined"
                                placeholder="每行一个路径，留空表示不限制"
                                :disabled="isLocked(field)"
                            ></textarea>

                            <input
                                v-else-if="field.kind === 'secret'"
                                :id="controlId"
                                v-model="textDraft[field.path]"
                                class="control"
                                type="password"
                                autocomplete="new-password"
                                :aria-describedby="field.help ? helpId : undefined"
                                :placeholder="field.is_set ? '已设置（留空表示不修改）' : '未设置'"
                                :disabled="isLocked(field)"
                            />

                            <input
                                v-else-if="field.kind === 'int' || field.kind === 'float'"
                                :id="controlId"
                                v-model="textDraft[field.path]"
                                class="control num"
                                type="number"
                                :aria-describedby="field.help ? helpId : undefined"
                                :min="field.min ?? undefined"
                                :max="field.max ?? undefined"
                                :step="field.step ?? undefined"
                                :disabled="isLocked(field)"
                            />

                            <input
                                v-else
                                :id="controlId"
                                v-model="textDraft[field.path]"
                                class="control"
                                type="text"
                                :aria-describedby="field.help ? helpId : undefined"
                                :disabled="isLocked(field)"
                            />
                        </template>
                    </BaseField>
                </template>
            </template>
        </div>

        <p
            v-if="message"
            class="message"
            :class="message.kind"
            :role="message.kind === 'error' ? 'alert' : 'status'"
        >
            {{ message.text }}
        </p>

        <template #footer>
            <BaseButton
                variant="secondary"
                :disabled="busy"
                :loading="restarting"
                @click="onRestartOnly"
            >
                {{ restarting ? "重启中..." : "重启后端" }}
            </BaseButton>
            <BaseButton
                variant="primary"
                :disabled="busy || dirtyCount === 0"
                :loading="saving"
                @click="onSave"
            >
                {{ saveLabel }}
            </BaseButton>
            <BaseButton variant="secondary" :disabled="busy" @click="close"> 关闭 </BaseButton>
        </template>
    </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import BaseButton from "@/components/base/BaseButton.vue";
import BaseField from "@/components/base/BaseField.vue";
import BaseModal from "@/components/base/BaseModal.vue";
import BaseTabs, { type BaseTabItem } from "@/components/base/BaseTabs.vue";
import type { UseConfigResult } from "@/composables/useConfig";
import type { UseLocalSettingsResult } from "@/composables/useLocalSettings";
import type { SettingsField } from "@/types/config";
import type { BackendSnapshot } from "@/types/electron";

const props = defineProps<{
    open: boolean;
    local: UseLocalSettingsResult;
    config: UseConfigResult;
    backend: BackendSnapshot;
}>();

const emit = defineEmits<{
    (e: "update:open", value: boolean): void;
}>();

// ---------- 分组（页签） ----------
//
// 「本机」与「关于」是前端自己的两个页签，其余按后端下发的 groups 渲染，
// 所以后端加一个可写字段不需要动这个组件。

interface Tab {
    id: string;
    title: string;
    description: string;
}

const LOCAL_TAB: Tab = {
    id: "local",
    title: "本机",
    description: "只存在这台机器上，不影响后端，也不用重启。",
};

const ABOUT_TAB: Tab = {
    id: "about",
    title: "关于",
    description: "版本与接入信息；API 密钥可以在这里直接改。",
};

const tabs = computed<Tab[]>(() => [
    LOCAL_TAB,
    ...(props.config.config.value?.settings.groups ?? []),
    ABOUT_TAB,
]);

const tabItems = computed<BaseTabItem[]>(() =>
    tabs.value.map((tab) => ({
        id: tab.id,
        label: tab.title,
        badge: dirtyGroups.value.has(tab.id),
    })),
);

const activeTab = ref<string>(LOCAL_TAB.id);

const activeTabMeta = computed<Tab | undefined>(() =>
    tabs.value.find((tab) => tab.id === activeTab.value),
);

/** 当前页签在（可能被后端移除分组后）仍然存在，否则退回第一个 */
watch(tabs, (list) => {
    if (!list.some((tab) => tab.id === activeTab.value)) {
        activeTab.value = list[0]?.id ?? LOCAL_TAB.id;
    }
});

// ---------- 可写字段的草稿 ----------
//
// 拆成两张表：(bool) 给开关，(string) 给其余控件。
// 合成一张 Record<string, string | boolean> 过不了 vue-tsc：
// input / textarea / select 的 value 只接受 string | number。

const fields = computed<SettingsField[]>(() => props.config.config.value?.settings.fields ?? []);

const visibleFields = computed<SettingsField[]>(() =>
    fields.value.filter((field) => field.group === activeTab.value),
);

const textDraft = ref<Record<string, string>>({});
const boolDraft = ref<Record<string, boolean>>({});
/** 灌草稿时的基线，用来算"改了哪些" */
const original = ref<Record<string, string | boolean>>({});

function isLocked(field: SettingsField): boolean {
    return field.locked_by !== null;
}

function toTextDraft(field: SettingsField): string {
    if (field.kind === "bool") {
        return "";
    }
    if (field.kind === "lines") {
        return Array.isArray(field.value) ? field.value.join("\n") : "";
    }
    // 密钥永远不下发，输入框一律留空，留空表示"不修改"
    if (field.kind === "secret") {
        return "";
    }
    return field.value === null || field.value === undefined ? "" : String(field.value);
}

function currentValue(field: SettingsField): string | boolean {
    if (field.kind === "bool") {
        return boolDraft.value[field.path] ?? false;
    }
    return textDraft.value[field.path] ?? "";
}

function coerceForSend(field: SettingsField, raw: string | boolean): unknown {
    switch (field.kind) {
        case "bool":
            return Boolean(raw);
        case "int":
        case "float":
            return Number(raw);
        default:
            return String(raw);
    }
}

function seedDraft() {
    const text: Record<string, string> = {};
    const bool: Record<string, boolean> = {};
    const base: Record<string, string | boolean> = {};

    for (const field of fields.value) {
        if (field.kind === "bool") {
            bool[field.path] = Boolean(field.value);
            base[field.path] = bool[field.path];
        } else {
            text[field.path] = toTextDraft(field);
            base[field.path] = text[field.path];
        }
    }

    textDraft.value = text;
    boolDraft.value = bool;
    original.value = base;
}

const changedValues = computed<Record<string, unknown>>(() => {
    const changed: Record<string, unknown> = {};

    for (const field of fields.value) {
        if (isLocked(field)) {
            continue;
        }

        const now = currentValue(field);
        if (now === original.value[field.path]) {
            continue;
        }
        // 密钥留空 = 不修改，不能当成"清空"
        if (field.kind === "secret" && String(now).trim() === "") {
            continue;
        }

        changed[field.path] = coerceForSend(field, now);
    }

    return changed;
});

const dirtyCount = computed(() => Object.keys(changedValues.value).length);

const dirtyGroups = computed<Set<string>>(() => {
    const groups = new Set<string>();
    for (const path of Object.keys(changedValues.value)) {
        const field = fields.value.find((item) => item.path === path);
        if (field) {
            groups.add(field.group);
        }
    }
    return groups;
});

/**
 * 已灌过草稿的那份配置的指纹；null 表示还没灌过
 *
 * 之前这里用的是 `dirtyCount === 0` 当守门条件，想表达"有未保存改动就别覆盖"，
 * 结果自相矛盾：草稿没灌过时，每个字段的草稿值都是空，跟基线一比全都算"改过"，
 * 于是 dirtyCount 恒为 31（32 个字段减去不回显的密钥），守门条件永远不成立，
 * 草稿一次也灌不进去——按钮上那个（31）就是这么来的，而且所有控件都显示成空值。
 * 改成用配置指纹判断：同一份配置不重复灌，配置真变了才重新灌。
 */
const seededSignature = ref<string | null>(null);

const configSignature = computed(() =>
    fields.value.map((field) => `${field.path}=${JSON.stringify(field.value)}`).join("|"),
);

watch(
    () => [props.open, configSignature.value] as const,
    ([open, signature]) => {
        if (!open || fields.value.length === 0) {
            return;
        }
        if (seededSignature.value === signature) {
            // 同一份配置：保留用户正在编辑的草稿（关掉面板再打开也不会丢）
            return;
        }
        seedDraft();
        seededSignature.value = signature;
    },
    { immediate: true },
);

// ---------- 保存与重启 ----------

const saving = ref(false);
const restarting = ref(false);
const message = ref<{ kind: "ok" | "error"; text: string } | null>(null);

const busy = computed(() => saving.value || restarting.value);

const saveLabel = computed(() => {
    if (saving.value) {
        return "保存中...";
    }
    if (restarting.value) {
        return "重启中...";
    }
    return dirtyCount.value > 0 ? `保存（${dirtyCount.value}）` : "保存";
});

// 用 host/port 拼地址，而不是用"就绪状态"派生的地址：
// 重启过程中状态会变成 starting，派生地址会一度为空。
const apiBase = computed(() => `http://${props.backend.host}:${props.backend.port}`);

async function doRestart(pending: string): Promise<void> {
    restarting.value = true;
    message.value = { kind: "ok", text: pending };

    try {
        const result = await window.soulMate.restartBackend();
        if (!result.ok) {
            message.value = {
                kind: "error",
                text: `重启失败：${result.error ?? "未知错误"}`,
            };
            restarting.value = false;
            return;
        }
    } catch (err) {
        message.value = {
            kind: "error",
            text: `重启失败：${err instanceof Error ? err.message : String(err)}`,
        };
        restarting.value = false;
        return;
    }

    // restartBackend 内部已经等到 /health 就绪，这里可以直接重新拉配置
    await props.config.refresh(apiBase.value);
    // 重新灌草稿：重启后生效值可能被后端校验成别的数，以磁盘上的实际值为准
    seedDraft();
    seededSignature.value = configSignature.value;
    message.value = { kind: "ok", text: "后端已重启，新配置已生效" };
    restarting.value = false;
}

async function onSave() {
    const values = changedValues.value;
    if (Object.keys(values).length === 0) {
        return;
    }

    saving.value = true;
    message.value = null;

    // 不写 = false：catch 里直接 return，这个初值永远不会被读到
    let restartRequired: boolean;
    try {
        const result = await props.config.save(apiBase.value, values);
        restartRequired = result.restart_required;
    } catch (err) {
        message.value = {
            kind: "error",
            text: err instanceof Error ? err.message : String(err),
        };
        saving.value = false;
        return;
    }

    saving.value = false;

    if (restartRequired) {
        // 功能开关、TTS 音色这类由后端启动时装配，必须重启才生效
        await doRestart("配置已保存，正在重启后端…");
        return;
    }

    // 其余配置后端已经即时重建运行时：用响应里的快照重灌草稿，不必重启
    seedDraft();
    seededSignature.value = configSignature.value;
    message.value = { kind: "ok", text: "配置已生效" };
}

async function onRestartOnly() {
    if (
        dirtyCount.value > 0 &&
        !confirm("还有未保存的改动，重启后端不会带上它们。确定只重启吗？")
    ) {
        return;
    }
    await doRestart("正在重启后端…");
}

// ---------- 关于页里的 API 密钥 ----------
//
// 关于页原本整页只读，但"密钥到底配没配"是用户最想确认的一件事，
// 所以这一行单独做成可写。值本身后端永不下发，输入框永远是空的：
// 填了才写入，留空就是不动。

const apiKeyDraft = ref("");
const apiKeySaving = ref(false);

/** schema 里对应的字段描述；后端没下发 settings 时为空 */
const apiKeySpec = computed(() => fields.value.find((field) => field.path === "model.api_key"));

const apiKeySet = computed(() => props.config.config.value?.model.api_key_set ?? false);

/** 被环境变量固定时不可写，和 schema 表单里的处理保持一致 */
const apiKeyLocked = computed(() => apiKeySpec.value?.locked_by != null);

const canSaveApiKey = computed(
    () => !apiKeySaving.value && !apiKeyLocked.value && apiKeyDraft.value.trim() !== "",
);

async function onSaveApiKey() {
    const value = apiKeyDraft.value.trim();
    if (!value || !canSaveApiKey.value) {
        return;
    }

    apiKeySaving.value = true;
    message.value = null;

    try {
        // model.api_key 是请求期读取的，后端 PATCH 时会重建 adapter，
        // 不需要像功能开关那样重启进程。
        await props.config.save(apiBase.value, { "model.api_key": value });
        apiKeyDraft.value = "";
        message.value = {
            kind: "ok",
            text: "API 密钥已保存，后面的对话就会用新密钥。",
        };
    } catch (err) {
        message.value = {
            kind: "error",
            text: err instanceof Error ? err.message : String(err),
        };
    } finally {
        apiKeySaving.value = false;
    }
}

// ---------- 本机设置 ----------

function onTtsEnabledChange(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    props.local.update({ ttsEnabled: checked });
}

function onVolumeChange(e: Event) {
    const value = Number((e.target as HTMLInputElement).value);
    props.local.update({ ttsVolume: value / 100 });
}

// ---------- 其它 ----------

function close() {
    emit("update:open", false);
}
</script>

<style scoped>
.modal-title {
    font-size: 16px;
    font-weight: 600;
}

/* ---------- 主体 ---------- */

.modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px 20px;
}

.group-desc {
    margin-bottom: 14px;
    color: #8888aa;
    font-size: 12px;
    line-height: 1.6;
}

.row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 7px 0;
    font-size: 13px;
}

.label {
    color: #b0b0c0;
}

.value {
    color: #e8e8ec;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    text-align: right;
    word-break: break-all;
}

.hint {
    color: #8888aa;
    font-size: 13px;
    padding: 8px 0;
}

.hint.error {
    color: #e08080;
}

.lock {
    font-size: 10px;
    color: #d0a040;
    border: 1px solid rgba(208, 160, 64, 0.35);
    background: rgba(208, 160, 64, 0.12);
    border-radius: 4px;
    padding: 1px 6px;
}

.control {
    flex: 1;
    min-width: 0;
    background: var(--surface-sunken);
    color: #e8e8ec;
    border: 1px solid var(--hairline);
    border-radius: 6px;
    padding: 7px 10px;
    font-family: inherit;
    font-size: 13px;
    outline: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    transition:
        border-color 0.15s,
        box-shadow 0.15s;
}

.control:focus {
    border-color: var(--accent-soft);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 0 0 3px rgba(167, 139, 250, 0.12);
}

.control:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.control.num {
    flex: 0 0 120px;
}

.control.textarea {
    resize: vertical;
    line-height: 1.5;
    font-family: ui-monospace, monospace;
    font-size: 12px;
}

/* 密钥状态徽标（关于页） */

.key-state {
    font-size: 10px;
    color: #8888aa;
    border: 1px solid var(--hairline);
    border-radius: 4px;
    padding: 1px 6px;
}

.key-state.set {
    color: #a0e0a0;
    border-color: rgba(128, 208, 128, 0.35);
    background: var(--tint-success);
}

/* 开关 */

.switch {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
    flex: 0 0 auto;
}

.switch input {
    opacity: 0;
    width: 0;
    height: 0;
}

.slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: var(--surface-strong);
    border-radius: 22px;
    transition: 0.2s;
}

.slider::before {
    content: "";
    position: absolute;
    height: 16px;
    width: 16px;
    left: 3px;
    bottom: 3px;
    background: #e8e8ec;
    border-radius: 50%;
    transition: 0.2s;
}

.switch input:checked + .slider {
    background: var(--accent-surface);
}

.switch input:checked + .slider::before {
    transform: translateX(18px);
}

.switch input:disabled + .slider {
    opacity: 0.45;
    cursor: not-allowed;
}

.switch input:focus-visible + .slider {
    outline: 2px solid rgba(167, 139, 250, 0.8);
    outline-offset: 2px;
}

.slider-input {
    width: 220px;
    accent-color: #8b6ce8;
}

.reset-line {
    margin-top: 16px;
}

/* ---------- 提示与按钮 ---------- */

.message {
    margin: 0 20px 10px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.6;
}

.message.ok {
    background: var(--tint-success);
    border: 1px solid rgba(128, 208, 128, 0.35);
    color: #a0e0a0;
}

.message.error {
    background: var(--tint-danger);
    border: 1px solid rgba(224, 128, 128, 0.35);
    color: #e0a0a0;
}
</style>
