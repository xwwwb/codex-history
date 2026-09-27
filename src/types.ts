export type SessionKind = "active" | "archived";

// SQLite threads 表中的可选元数据，用于补充 rollout 会话信息。
export interface StateThread {
  id: string;
  title?: string;
  name?: string;
  cwd?: string;
  preview?: string;
  firstUserMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  tokensUsed?: number;
  archived?: boolean;
}

// 列表页使用的会话摘要，保留文件句柄供详情页按需读取。
export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  model: string;
  provider: string;
  reasoningEffort: string;
  tokensUsed?: number;
  kind: SessionKind;
  path: string;
  fileName: string;
  size: number;
  messageCount: number;
  toolCount: number;
  sampled: boolean;
  parseWarnings: number;
  fileHandle: FileSystemFileHandle;
}

// 将不同来源的 rollout 事件归类为详情页可筛选的块类型。
export type BlockKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool-call"
  | "tool-output"
  | "context"
  | "usage"
  | "event"
  | "unknown";

// 对话视图中的实际工具调用；动态参数保留表达式供查阅。
export interface ToolCallSummary {
  name: string;
  command?: string;
  expression?: string;
}

// 单条 rollout 记录转换后的展示数据，同时保留完整原始对象。
export interface HistoryBlock {
  id: string;
  timestamp: string;
  kind: BlockKind;
  title: string;
  subtitle?: string;
  text?: string;
  language?: string;
  synthetic?: boolean;
  toolCalls?: ToolCallSummary[];
  raw: unknown;
}

// 完整会话详情及无法解析的 JSONL 行数。
export interface SessionDetail {
  blocks: HistoryBlock[];
  malformedLines: number;
}

// 一次目录扫描的会话列表、SQLite 来源和非致命警告。
export interface ScanResult {
  sessions: SessionSummary[];
  sqliteFile?: string;
  sqliteError?: string;
  warnings: string[];
}
