<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DocumentCopy, Search, Warning } from "@element-plus/icons-vue";
import { message } from "@tauri-apps/plugin-dialog";
import { useRoute, useRouter } from "vue-router";
import type { BlockKind, SessionDetail, SessionSummary } from "../types";
import { loadSessionDetail } from "../services/codex";
import { historyState } from "../historyState";
import HistoryBlock from "./HistoryBlock.vue";

const route = useRoute();
const router = useRouter();
const session = computed<SessionSummary | undefined>(() =>
  historyState.sessions.find((item) => item.id === route.params.id),
);

const loading = ref(false);
const detail = ref<SessionDetail>();
const view = ref<"conversation" | "detail">("conversation");
const query = ref("");
const kind = ref<BlockKind | "all">("all");
let loadVersion = 0;

const kindOptions: Array<{ value: BlockKind | "all"; label: string }> = [
  { value: "all", label: "全部记录" },
  { value: "user", label: "用户" },
  { value: "assistant", label: "Codex" },
  { value: "reasoning", label: "思考" },
  { value: "tool-call", label: "工具调用" },
  { value: "tool-output", label: "工具返回" },
  { value: "context", label: "上下文" },
  { value: "usage", label: "用量" },
  { value: "event", label: "事件" },
];

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : dateFormatter.format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

// 子路由切换会话时重新读取详情，并重置上一次的筛选条件。
watch(
  session,
  async (current) => {
    const version = ++loadVersion;
    if (!current) {
      detail.value = undefined;
      loading.value = false;
      return;
    }
    loading.value = true;
    view.value = "conversation";
    query.value = "";
    kind.value = "all";
    try {
      const result = await loadSessionDetail(current);
      if (version === loadVersion) detail.value = result;
    } catch (error) {
      if (version === loadVersion) {
        detail.value = undefined;
        await message(`读取会话失败：${error instanceof Error ? error.message : String(error)}`, {
          kind: "error",
        });
      }
    } finally {
      if (version === loadVersion) loading.value = false;
    }
  },
  { immediate: true },
);

// 对话视图只保留真实用户消息、助手回复和工具调用，并维持原始事件顺序。
const filteredBlocks = computed(() => {
  const normalized = query.value.trim().toLocaleLowerCase();
  return (detail.value?.blocks ?? []).filter((block) => {
    if (view.value === "conversation") {
      if (!["user", "assistant", "tool-call"].includes(block.kind)) return false;
      if (block.kind === "user" && block.synthetic) return false;
    } else if (kind.value !== "all" && block.kind !== kind.value) return false;
    if (!normalized) return true;
    const searchable =
      view.value === "conversation"
        ? block.kind === "tool-call"
          ? (block.toolCalls ?? [{ name: block.title }])
              .map((call) => `${call.name} ${call.command ?? ""} ${call.expression ?? ""}`)
              .join(" ")
          : `${block.title} ${block.text ?? ""}`
        : `${block.title} ${block.subtitle ?? ""} ${block.text ?? ""}`;
    return searchable.toLocaleLowerCase().includes(normalized);
  });
});

async function copyId() {
  if (!session.value) return;
  try {
    await navigator.clipboard.writeText(session.value.id);
    await message("会话 ID 已复制", { kind: "info" });
  } catch (error) {
    await message(`复制会话 ID 失败：${error instanceof Error ? error.message : String(error)}`, {
      kind: "error",
    });
  }
}
</script>

<template>
  <section class="detail-page">
    <div v-if="session" class="detail-shell">
      <header class="detail-header">
        <div class="detail-header__main">
          <div class="detail-header__eyebrow">
            <span :class="['status-dot', `is-${session.kind}`]" />
            {{ session.kind === "archived" ? "已归档会话" : "活跃会话" }}
          </div>
          <h2>{{ session.title }}</h2>
          <p v-if="session.summary" class="detail-header__summary">{{ session.summary }}</p>
          <dl class="detail-meta">
            <div class="detail-meta__wide">
              <dt>工作目录</dt>
              <dd :title="session.cwd">{{ session.cwd || "未记录" }}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{{ formatDate(session.createdAt) }}</dd>
            </div>
            <div>
              <dt>最后活动</dt>
              <dd>{{ formatDate(session.updatedAt) }}</dd>
            </div>
            <div>
              <dt>模型</dt>
              <dd>{{ session.model || "未记录" }}</dd>
            </div>
            <div>
              <dt>提供方</dt>
              <dd>{{ session.provider || "未记录" }}</dd>
            </div>
            <div>
              <dt>推理强度</dt>
              <dd>{{ session.reasoningEffort || "未记录" }}</dd>
            </div>
            <div>
              <dt>Token 用量</dt>
              <dd>
                {{ session.tokensUsed === undefined ? "未记录" : formatNumber(session.tokensUsed) }}
              </dd>
            </div>
            <div>
              <dt>消息 / 工具块</dt>
              <dd>
                {{ session.sampled ? "≥" : "" }}{{ session.messageCount }} /
                {{ session.sampled ? "≥" : "" }}{{ session.toolCount }}
              </dd>
            </div>
            <div class="detail-meta__wide">
              <dt>会话 ID</dt>
              <dd>
                <button type="button" class="detail-meta__copy" @click="copyId">
                  <span>{{ session.id }}</span
                  ><DocumentCopy />
                </button>
              </dd>
            </div>
            <div class="detail-meta__wide">
              <dt>记录文件</dt>
              <dd :title="session.path">{{ session.path }}</dd>
            </div>
          </dl>
        </div>
      </header>

      <div class="detail-view-switch segmented" role="group" aria-label="会话展示方式">
        <button
          type="button"
          :class="{ active: view === 'conversation' }"
          :aria-pressed="view === 'conversation'"
          @click="view = 'conversation'"
        >
          对话记录
        </button>
        <button
          type="button"
          :class="{ active: view === 'detail' }"
          :aria-pressed="view === 'detail'"
          @click="view = 'detail'"
        >
          详细信息
        </button>
      </div>

      <div class="detail-toolbar">
        <label class="ui-search">
          <Search />
          <input
            v-model="query"
            type="search"
            placeholder="在当前会话中查找"
            aria-label="在当前会话中查找"
          />
        </label>
        <select
          v-if="view === 'detail'"
          v-model="kind"
          class="ui-select detail-toolbar__select"
          aria-label="记录类型"
        >
          <option v-for="option in kindOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>

      <div v-if="view === 'detail' && detail?.malformedLines" class="detail-warning">
        <Warning />忽略了 {{ detail.malformedLines }} 行尚未写完或无法解析的 JSONL 数据
      </div>

      <div class="detail-content" :aria-busy="loading">
        <p v-if="loading" class="ui-empty" role="status">正在读取会话…</p>
        <template v-if="!loading && filteredBlocks.length">
          <HistoryBlock
            v-for="block in filteredBlocks"
            :key="block.id"
            :block="block"
            :compact="view === 'conversation'"
          />
        </template>
        <p v-else-if="!loading" class="ui-empty">没有匹配的记录</p>
      </div>
    </div>
    <div v-else class="ui-empty">
      <p>找不到该会话。请返回历史记录选择其他会话。</p>
      <button
        type="button"
        class="ui-button ui-button--primary"
        @click="router.push({ name: 'history' })"
      >
        返回历史记录
      </button>
    </div>
  </section>
</template>
