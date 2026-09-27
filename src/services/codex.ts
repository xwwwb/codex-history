import type {
  BlockKind,
  HistoryBlock,
  ScanResult,
  SessionDetail,
  SessionKind,
  SessionSummary,
  StateThread,
} from "../types";
import { readStateThreads } from "./sqlite";
import { summarizeToolCalls } from "./toolCalls";

type JsonRecord = Record<string, unknown>;

// 扫描时保存 rollout 文件句柄及其在所选目录中的相对位置。
interface RolloutFile {
  handle: FileSystemFileHandle;
  path: string;
  kind: SessionKind;
}

// 列表只采样大型文件的首尾，详情页再读取完整内容。
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 384 * 1024;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

// 逐行解析 JSONL，并容忍会话仍在写入时出现的不完整行。
function parseLines(text: string) {
  const records: JsonRecord[] = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(record(JSON.parse(line)));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

// 从消息内容数组中提取可读文本，其余内容仍可通过原始 JSON 查看。
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      return string(item.text) || string(item.input_text) || string(item.output_text);
    })
    .filter(Boolean)
    .join("\n");
}

function messageText(payloadValue: unknown) {
  const payload = record(payloadValue);
  return contentText(payload.content) || string(payload.message) || string(payload.text);
}

function concise(value: string, max = 180) {
  const result = value.replace(/\s+/g, " ").trim();
  return result.length > max ? `${result.slice(0, max).trimEnd()}…` : result;
}

// 排除注入的环境说明，避免它被当作真正的首条用户提问。
function isSynthetic(text: string) {
  const normalized = text.trim();
  return (
    normalized.startsWith("# AGENTS.md instructions") ||
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("<INSTRUCTIONS>") ||
    normalized.startsWith("<permissions instructions>")
  );
}

function validDate(value: string | undefined, fallback: string) {
  if (!value || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function workspaceName(cwd: string) {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || "未知工作区";
}

async function directory(root: FileSystemDirectoryHandle, name: string) {
  try {
    return await root.getDirectoryHandle(name);
  } catch {
    return undefined;
  }
}

// 递归收集活跃或归档目录下的 rollout JSONL 文件。
async function collectJsonl(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  kind: SessionKind,
  output: RolloutFile[],
) {
  for await (const [name, handle] of dir.entries()) {
    const path = `${prefix}/${name}`;
    if (handle.kind === "directory") await collectJsonl(handle, path, kind, output);
    else if (name.endsWith(".jsonl") && name.startsWith("rollout-"))
      output.push({ handle, path, kind });
  }
}

async function readOptionalFile(root: FileSystemDirectoryHandle, name: string) {
  try {
    return await (await root.getFileHandle(name)).getFile();
  } catch {
    return undefined;
  }
}

// 标题索引为追加日志，同一会话以后出现的名称覆盖旧名称。
async function readTitleIndex(root: FileSystemDirectoryHandle) {
  const result = new Map<string, string>();
  const file = await readOptionalFile(root, "session_index.jsonl");
  if (!file) return result;
  const { records } = parseLines(await file.text());
  for (const item of records) {
    const id = string(item.id);
    const title = string(item.thread_name);
    if (id && title) result.set(id, title);
  }
  return result;
}

// 大文件只解析完整的首尾行，以降低列表生成时的读取量。
async function readEdges(file: File) {
  if (file.size <= HEAD_BYTES + TAIL_BYTES) return parseLines(await file.text());
  const head = await file.slice(0, HEAD_BYTES).text();
  const tail = await file.slice(file.size - TAIL_BYTES).text();
  const headSafe = head.slice(0, head.lastIndexOf("\n") + 1);
  const firstTailBreak = tail.indexOf("\n");
  const tailSafe = firstTailBreak >= 0 ? tail.slice(firstTailBreak + 1) : "";
  return parseLines(`${headSafe}\n${tailSafe}`);
}

// 合并 rollout、标题索引和 SQLite 元数据，生成一个列表项。
function inspectSummary(
  source: RolloutFile,
  file: File,
  records: JsonRecord[],
  malformed: number,
  state: StateThread | undefined,
  indexedTitle: string | undefined,
): SessionSummary | undefined {
  const metaRecord = records.find((item) => item.type === "session_meta");
  const meta = record(metaRecord?.payload);
  const sourceInfo = record(meta.source);
  if ("subagent" in sourceInfo) return undefined;

  const fileId = /([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(file.name)?.[1] ?? "";
  const id = string(meta.id) || fileId;
  if (!id) return undefined;

  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  let messageCount = 0;
  let toolCount = 0;
  let latestModel = state?.model ?? "";
  let latestProvider = state?.modelProvider ?? string(meta.model_provider);
  let latestReasoning = state?.reasoningEffort ?? "";
  let latestTokens = state?.tokensUsed;

  for (const item of records) {
    const payload = record(item.payload);
    if (item.type === "turn_context") {
      latestModel = string(payload.model) || latestModel;
      latestProvider = string(payload.model_provider) || latestProvider;
      latestReasoning =
        string(payload.effort) || string(payload.reasoning_effort) || latestReasoning;
    }
    if (item.type === "response_item" && payload.type === "message") {
      const text = messageText(payload);
      if (text) {
        messageCount += 1;
        if (payload.role === "user" && !isSynthetic(text)) userTexts.push(text);
        if (payload.role === "assistant") assistantTexts.push(text);
      }
    }
    if (
      item.type === "response_item" &&
      [
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
      ].includes(string(payload.type))
    ) {
      toolCount += 1;
    }
    if (item.type === "event_msg" && payload.type === "token_count") {
      const usage = record(payload.info);
      const totals = record(usage.total_token_usage);
      if (typeof totals.total_tokens === "number") latestTokens = totals.total_tokens;
    }
  }

  const firstUser = state?.firstUserMessage || userTexts[0] || "";
  const cwd = state?.cwd || string(meta.cwd);
  const fallbackDate = file.lastModified
    ? new Date(file.lastModified).toISOString()
    : new Date(0).toISOString();
  const timestamps = records.map((item) => string(item.timestamp)).filter(Boolean);
  const explicitTitle =
    state?.title && concise(state.title) !== concise(firstUser) ? state.title : undefined;
  const title = concise(
    explicitTitle || state?.name || indexedTitle || firstUser || workspaceName(cwd),
    100,
  );
  const summary = concise(
    state?.preview || assistantTexts.at(-1) || userTexts.at(-1) || "暂无可显示的文本摘要",
  );

  return {
    id,
    title: title || "未命名会话",
    cwd,
    workspace: workspaceName(cwd),
    createdAt: validDate(state?.createdAt || timestamps[0], fallbackDate),
    updatedAt: validDate(state?.updatedAt || timestamps.at(-1), fallbackDate),
    summary,
    model: latestModel,
    provider: latestProvider,
    reasoningEffort: latestReasoning,
    tokensUsed: latestTokens,
    kind: state?.archived ? "archived" : source.kind,
    path: source.path,
    fileName: file.name,
    size: file.size,
    messageCount,
    toolCount,
    sampled: file.size > HEAD_BYTES + TAIL_BYTES,
    parseWarnings: malformed,
    fileHandle: source.handle,
  };
}

// 扫描所选 CODEX_HOME，读取会话并按最后活动时间去重排序。
export async function scanCodexDirectory(
  root: FileSystemDirectoryHandle,
  onProgress?: (done: number, total: number) => void,
): Promise<ScanResult> {
  const files: RolloutFile[] = [];
  const sessionsDir = await directory(root, "sessions");
  const archivedDir = await directory(root, "archived_sessions");
  if (sessionsDir) await collectJsonl(sessionsDir, "sessions", "active", files);
  if (archivedDir) await collectJsonl(archivedDir, "archived_sessions", "archived", files);

  const warnings: string[] = [];
  const titlesPromise = readTitleIndex(root);
  let stateThreads = new Map<string, StateThread>();
  let sqliteFile: string | undefined;
  let sqliteError: string | undefined;
  try {
    const state = await readStateThreads(root);
    stateThreads = state.threads;
    sqliteFile = state.fileName;
  } catch (error) {
    sqliteError = error instanceof Error ? error.message : String(error);
    warnings.push("SQLite 元数据读取失败，已回退到 rollout 与标题索引。");
  }
  const titles = await titlesPromise;
  const sessions: SessionSummary[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const source = files[index];
    try {
      const file = await source.handle.getFile();
      const parsed = await readEdges(file);
      const metaRecord = parsed.records.find((item) => item.type === "session_meta");
      const id =
        string(record(metaRecord?.payload).id) ||
        /([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(file.name)?.[1];
      const summary = inspectSummary(
        source,
        file,
        parsed.records,
        parsed.malformed,
        id ? stateThreads.get(id) : undefined,
        id ? titles.get(id) : undefined,
      );
      if (summary) sessions.push(summary);
    } catch (error) {
      warnings.push(
        `无法读取 ${source.path}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    onProgress?.(index + 1, files.length);
  }

  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const byThread = new Map<string, SessionSummary>();
  for (const session of sessions) {
    if (!byThread.has(session.id)) byThread.set(session.id, session);
  }
  const deduplicated = [...byThread.values()];
  return { sessions: deduplicated, sqliteFile, sqliteError, warnings };
}

function pretty(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

// 将单条 rollout 事件映射成可读块，未知类型也保留原始内容。
function blockFromRecord(item: JsonRecord, index: number): HistoryBlock {
  const topType = string(item.type) || "unknown";
  const payload = record(item.payload);
  const payloadType = string(payload.type);
  const timestamp = string(item.timestamp);
  let kind: BlockKind = "unknown";
  let title = payloadType || topType;
  let subtitle = topType;
  let text = "";
  let language: string | undefined;
  let synthetic = false;
  let toolCalls: HistoryBlock["toolCalls"];

  if (topType === "session_meta") {
    kind = "context";
    title = "会话元数据";
    subtitle = string(payload.id);
    text = [
      string(payload.cwd),
      string(payload.cli_version) && `Codex ${string(payload.cli_version)}`,
    ]
      .filter(Boolean)
      .join("\n");
  } else if (topType === "turn_context") {
    kind = "context";
    title = "Turn 上下文";
    subtitle = [string(payload.model), string(payload.effort) || string(payload.reasoning_effort)]
      .filter(Boolean)
      .join(" · ");
  } else if (topType === "token_usage_record" || payloadType === "token_count") {
    kind = "usage";
    title = "Token 用量";
    text = pretty(payload.info ?? payload);
  } else if (topType === "world_state") {
    kind = "context";
    title = "环境状态";
    text = pretty(payload);
  } else if (topType === "response_item") {
    if (payloadType === "message") {
      const role = string(payload.role);
      kind = role === "user" ? "user" : role === "assistant" ? "assistant" : "event";
      title =
        role === "user" ? "用户" : role === "assistant" ? "Codex" : `消息 · ${role || "未知角色"}`;
      text = messageText(payload);
      synthetic = role === "user" && isSynthetic(text);
    } else if (payloadType === "reasoning") {
      kind = "reasoning";
      title = "思考过程";
      text =
        contentText(payload.summary) ||
        contentText(payload.content) ||
        (payload.encrypted_content ? "内容已加密，无法在本地展示。" : "");
    } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      kind = "tool-call";
      title =
        string(payload.name) ||
        (payloadType === "custom_tool_call" ? "自定义工具调用" : "函数调用");
      subtitle = string(payload.call_id);
      text = pretty(payload.arguments ?? payload.input ?? "");
      toolCalls = summarizeToolCalls(title, payload.arguments ?? payload.input);
      language = "json";
    } else if (
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output"
    ) {
      kind = "tool-output";
      title = "工具返回";
      subtitle = string(payload.call_id);
      text = pretty(payload.output ?? "");
    } else {
      kind = "event";
      title = payloadType || "响应项目";
      text = pretty(payload);
    }
  } else if (topType === "event_msg") {
    kind = "event";
    const labels: Record<string, string> = {
      agent_message: "助手事件",
      user_message: "用户事件",
      task_started: "任务开始",
      task_complete: "任务完成",
      item_started: "项目开始",
      item_completed: "项目完成",
      turn_aborted: "Turn 已中止",
      context_compacted: "上下文已压缩",
    };
    title = labels[payloadType] || payloadType || "运行事件";
    text = messageText(payload) || pretty(payload);
  } else {
    text = pretty(payload);
  }

  return {
    id: `${index}-${timestamp}`,
    timestamp,
    kind,
    title,
    subtitle,
    text,
    language,
    synthetic,
    toolCalls,
    raw: item,
  };
}

// 用户打开详情时才读取整个 rollout 文件并转换全部事件。
export async function loadSessionDetail(session: SessionSummary): Promise<SessionDetail> {
  const file = await session.fileHandle.getFile();
  const { records, malformed } = parseLines(await file.text());
  return { blocks: records.map(blockFromRecord), malformedLines: malformed };
}
