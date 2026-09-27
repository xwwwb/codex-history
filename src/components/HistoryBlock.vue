<script setup lang="ts">
import { computed } from "vue";
import {
  ChatLineRound,
  Coin,
  Cpu,
  Document,
  InfoFilled,
  MagicStick,
  Monitor,
  Service,
  Tools,
  User,
} from "@element-plus/icons-vue";
import type { HistoryBlock, ToolCallSummary } from "../types";

const props = defineProps<{ block: HistoryBlock; compact?: boolean }>();
const toolCalls = computed<ToolCallSummary[]>(
  () => props.block.toolCalls ?? [{ name: props.block.title }],
);

// 依据事件类别选择图标，未知类别使用通用文档图标。
const icon = computed(
  () =>
    ({
      user: User,
      assistant: Service,
      reasoning: MagicStick,
      "tool-call": Tools,
      "tool-output": Monitor,
      context: Cpu,
      usage: Coin,
      event: ChatLineRound,
      unknown: InfoFilled,
    })[props.block.kind] ?? Document,
);

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const formattedTime = computed(() => {
  const date = new Date(props.block.timestamp);
  return Number.isNaN(date.getTime()) ? props.block.timestamp : timeFormatter.format(date);
});

// 原始 JSON 让非文本内容和未识别字段也可以被完整查阅。
const rawJson = computed(() => JSON.stringify(props.block.raw, null, 2));
</script>

<template>
  <article class="history-block" :class="`history-block--${block.kind}`">
    <div class="history-block__rail">
      <span class="history-block__icon"><component :is="icon" /></span>
      <span class="history-block__line" />
    </div>
    <div class="history-block__body">
      <template v-if="compact && block.kind === 'tool-call'">
        <div v-for="(call, index) in toolCalls" :key="index" class="history-tool-call">
          <header>
            <strong>{{ call.name }}</strong>
          </header>
          <pre v-if="call.command" class="is-code">{{ call.command }}</pre>
          <template v-else-if="call.expression">
            <p class="history-tool-call__hint">动态参数 · 原始调用表达式</p>
            <pre class="is-code">{{ call.expression }}</pre>
          </template>
        </div>
      </template>
      <template v-else>
        <header>
          <div>
            <strong>{{ block.title }}</strong>
            <span v-if="!compact && block.subtitle" class="history-block__subtitle">{{
              block.subtitle
            }}</span>
          </div>
          <time v-if="!compact">{{ formattedTime }}</time>
        </header>
        <pre
          v-if="block.text"
          :class="{
            'is-code': block.language || ['tool-call', 'tool-output', 'usage'].includes(block.kind),
          }"
          >{{ block.text }}</pre>
        <p v-else class="history-block__empty">此记录没有可展示的文本内容</p>
        <details v-if="!compact" class="history-block__raw">
          <summary>原始 JSON</summary>
          <pre>{{ rawJson }}</pre>
        </details>
      </template>
    </div>
  </article>
</template>
