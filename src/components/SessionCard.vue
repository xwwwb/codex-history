<script setup lang="ts">
import type { SessionSummary } from "../types";

defineProps<{ session: SessionSummary; selected: boolean }>();
defineEmits<{ select: [session: SessionSummary] }>();

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : dateFormatter.format(date);
}
</script>

<template>
  <button
    type="button"
    class="session-card"
    :class="{ 'is-selected': selected }"
    :aria-current="selected ? 'page' : undefined"
    @click="$emit('select', session)"
  >
    <span class="session-card__heading">
      <span class="session-card__status" :class="`is-${session.kind}`" />
      <strong :title="session.title">{{ session.title }}</strong>
    </span>
    <span class="session-card__path" :title="session.cwd || session.path">
      {{ session.cwd || session.path }}
    </span>
    <time class="session-card__date" :datetime="session.updatedAt">{{
      formatDate(session.updatedAt)
    }}</time>
  </button>
</template>
