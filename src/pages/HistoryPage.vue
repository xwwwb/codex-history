<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { FolderOpened, Refresh, Search } from "@element-plus/icons-vue";
import { message } from "@tauri-apps/plugin-dialog";
import SessionCard from "../components/SessionCard.vue";
import { historyState, scanHistory, selectHistoryDirectory } from "../historyState";
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

async function reportScan(result: Awaited<ReturnType<typeof scanHistory>>) {
  if (!result) return;
  if (!result.sessions.length)
    await message("没有找到 rollout 历史记录，请确认选择的是 CODEX_HOME 文件夹", {
      kind: "warning",
    });
  else if (result.warnings.length)
    await message(
      `已读取 ${result.sessions.length} 个会话，另有 ${result.warnings.length} 个警告`,
      { kind: "warning" },
    );
}

async function selectDirectory() {
  try {
    await reportScan(await selectHistoryDirectory());
  } catch (error) {
    await message(`无法打开文件夹：${error instanceof Error ? error.message : String(error)}`, {
      kind: "error",
    });
  }
}

async function scan() {
  try {
    await reportScan(await scanHistory());
  } catch (error) {
    await message(`扫描失败：${error instanceof Error ? error.message : String(error)}`, {
      kind: "error",
    });
  }
}

function openSession(session: SessionSummary) {
  router.push({ name: "history-item", params: { id: session.id } });
}
</script>

<template>
  <main class="history-screen">
    <section v-if="!historyState.rootHandle" class="library directory-prompt">
      <h1>选择 Codex 文件夹</h1>
      <p>浏览历史记录需要读取本机的 CODEX_HOME 文件夹。重新打开应用后需要再次选择。</p>
      <button
        type="button"
        class="ui-button ui-button--primary"
        :disabled="historyState.scanning"
        @click="selectDirectory"
      >
        <FolderOpened />选择 Codex 文件夹
      </button>
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
            <button
              type="button"
              class="ui-button"
              :disabled="historyState.scanning"
              @click="scan()"
            >
              <Refresh />重新扫描
            </button>
            <button type="button" class="ui-button" @click="selectDirectory">
              <FolderOpened />更换文件夹
            </button>
          </div>
          <label class="ui-search">
            <Search />
            <input
              v-model="query"
              type="search"
              placeholder="搜索标题或路径"
              aria-label="搜索标题或路径"
            />
          </label>
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
          <p v-if="historyState.scanned && !filteredSessions.length" class="ui-empty">
            没有匹配的会话
          </p>
        </div>
      </aside>

      <section class="history-detail-pane" aria-label="会话详情">
        <router-view />
        <div v-if="route.name === 'history'" class="history-detail-pane__empty">
          <p class="ui-empty">
            {{ sessions.length ? "选择左侧会话查看详情" : "当前文件夹没有可浏览的会话" }}
          </p>
        </div>
      </section>
    </div>
  </main>
</template>
