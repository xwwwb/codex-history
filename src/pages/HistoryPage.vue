<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { FolderOpened, Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import SessionCard from "../components/SessionCard.vue";
import {
  directoryPickerSupported,
  historyState,
  scanHistory,
  selectHistoryDirectory,
} from "../historyState";
import type { SessionKind, SessionSummary } from "../types";

type KindFilter = "all" | SessionKind;

const route = useRoute();
const router = useRouter();
const sessions = computed(() => historyState.sessions);
const query = ref("");
const kind = ref<KindFilter>("all");

const filteredSessions = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return sessions.value.filter((item) => {
    if (kind.value !== "all" && item.kind !== kind.value) return false;
    if (!needle) return true;
    return [item.title, item.cwd, item.path, item.id].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    );
  });
});

function reportScan(result: Awaited<ReturnType<typeof scanHistory>>) {
  if (!result) return;
  if (!result.sessions.length)
    ElMessage.warning("没有找到 rollout 历史记录，请确认选择的是 CODEX_HOME 文件夹");
  else if (result.warnings.length)
    ElMessage.warning(
      `已读取 ${result.sessions.length} 个会话，另有 ${result.warnings.length} 个警告`,
    );
}

async function selectDirectory() {
  if (!directoryPickerSupported) return;
  try {
    reportScan(await selectHistoryDirectory());
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    ElMessage.error(`无法打开文件夹：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function scan() {
  try {
    reportScan(await scanHistory());
  } catch (error) {
    ElMessage.error(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function openSession(session: SessionSummary) {
  router.push({ name: "history-item", params: { id: session.id } });
}
</script>

<template>
  <main class="history-screen">
    <nav class="page-nav" aria-label="主导航">
      <router-link to="/">主页</router-link>
      <router-link to="/history">历史记录</router-link>
    </nav>

    <section v-if="!historyState.rootHandle" class="library directory-prompt">
      <h1>选择 Codex 文件夹</h1>
      <p>浏览历史记录需要读取本机的 CODEX_HOME 文件夹。刷新页面后，浏览器需要重新授权。</p>
      <el-button
        type="primary"
        :icon="FolderOpened"
        :disabled="!directoryPickerSupported"
        :loading="historyState.scanning"
        @click="selectDirectory"
        >选择 Codex 文件夹</el-button
      >
      <el-alert
        v-if="!directoryPickerSupported"
        type="warning"
        :closable="false"
        show-icon
        title="当前浏览器不支持 File System Access API，请使用 Chrome 或 Edge。"
      />
    </section>

    <div v-else class="history-workspace">
      <aside class="history-sidebar" aria-label="历史记录列表">
        <header class="history-sidebar__header">
          <div class="eyebrow"><span />YOUR LOCAL ARCHIVE</div>
          <h1>
            历史记录 <small>{{ sessions.length }}</small>
          </h1>
          <p :title="historyState.rootName">{{ historyState.rootName }}</p>
          <div class="history-sidebar__actions">
            <el-button :icon="Refresh" :loading="historyState.scanning" @click="scan()"
              >重新扫描</el-button
            >
            <el-button
              :icon="FolderOpened"
              :disabled="!directoryPickerSupported"
              @click="selectDirectory"
              >更换文件夹</el-button
            >
          </div>
          <el-input v-model="query" clearable placeholder="搜索标题或路径">
            <template #prefix
              ><el-icon><Search /></el-icon
            ></template>
          </el-input>
          <div class="segmented history-sidebar__filter" role="group" aria-label="会话状态筛选">
            <button :class="{ active: kind === 'all' }" @click="kind = 'all'">全部</button>
            <button :class="{ active: kind === 'active' }" @click="kind = 'active'">活跃</button>
            <button :class="{ active: kind === 'archived' }" @click="kind = 'archived'">
              归档
            </button>
          </div>
          <div
            v-if="historyState.warnings.length"
            class="warning-strip"
            :title="historyState.warnings.join('\n')"
          >
            {{ historyState.warnings.length }} 个读取警告
          </div>
        </header>
        <div class="history-sidebar__list">
          <SessionCard
            v-for="session in filteredSessions"
            :key="`${session.id}-${session.path}`"
            :session="session"
            :selected="route.params.id === session.id"
            @select="openSession"
          />
          <el-empty
            v-if="historyState.scanned && !filteredSessions.length"
            description="没有匹配的会话"
            :image-size="64"
          />
        </div>
      </aside>

      <section class="history-detail-pane" aria-label="会话详情">
        <router-view />
        <div v-if="route.name === 'history'" class="history-detail-pane__empty">
          <el-empty
            :description="sessions.length ? '选择左侧会话查看详情' : '当前文件夹没有可浏览的会话'"
          />
        </div>
      </section>
    </div>
  </main>
</template>
