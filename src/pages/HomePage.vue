<script setup lang="ts">
import { FolderOpened, Lock } from "@element-plus/icons-vue";
import { message } from "@tauri-apps/plugin-dialog";
import { useRouter } from "vue-router";
import { historyState, selectHistoryDirectory } from "../historyState";

const router = useRouter();

async function selectDirectory() {
  if (historyState.rootHandle) {
    await router.push({ name: "history" });
    return;
  }
  try {
    const result = await selectHistoryDirectory();
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
    await router.push({ name: "history" });
  } catch (error) {
    await message(`无法打开文件夹：${error instanceof Error ? error.message : String(error)}`, {
      kind: "error",
    });
  }
}
</script>

<template>
  <section class="hero">
    <div class="hero__copy">
      <div class="eyebrow"><span />LOCAL · PRIVATE · READ ONLY</div>
      <h1>让每一次与 Codex<br /><em>协作的脉络</em>清晰可见</h1>
      <p>
        选择本机的 CODEX_HOME
        文件夹，在本机浏览所有会话、工具调用与运行记录。文件始终留在你的设备上。
      </p>
      <div class="hero__actions">
        <button
          type="button"
          class="ui-button ui-button--primary ui-button--large"
          @click="selectDirectory"
        >
          <FolderOpened />{{ historyState.rootHandle ? "查看历史记录" : "选择 Codex 文件夹" }}
        </button>
        <span><Lock />仅读取，不上传</span>
      </div>
    </div>
    <div class="hero__visual" aria-hidden="true">
      <div class="orbit orbit--one" />
      <div class="orbit orbit--two" />
      <div class="history-preview">
        <div class="history-preview__header"><i /><i /><i /><span>sessions / 2026 / 09</span></div>
        <div class="preview-item is-active">
          <b>01</b
          ><span><strong>重构数据读取流程</strong><small>typescript/codex-history</small></span
          ><time>刚刚</time>
        </div>
        <div class="preview-item">
          <b>02</b><span><strong>修复登录状态同步</strong><small>apps/dashboard</small></span
          ><time>14:32</time>
        </div>
        <div class="preview-item">
          <b>03</b><span><strong>优化构建产物体积</strong><small>packages/core</small></span
          ><time>昨天</time>
        </div>
      </div>
    </div>
  </section>
</template>
