import initSqlJs, { type Database, type SqlValue } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { StateThread } from "../types";
import type { HistoryDirectoryHandle, HistoryFileHandle } from "./files";

let sqlPromise: ReturnType<typeof initSqlJs> | undefined;

// 只初始化一次 SQLite WASM，后续读取复用同一个加载结果。
function getSql() {
  sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl });
  return sqlPromise;
}

// 选择根目录中版本号最高的 state_*.sqlite 文件。
async function findStateFile(root: HistoryDirectoryHandle) {
  const candidates: Array<{ name: string; handle: HistoryFileHandle; version: number }> = [];
  for await (const [name, handle] of root.entries()) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (handle.kind === "file" && match) {
      candidates.push({ name, handle, version: Number(match[1]) });
    }
  }
  return candidates.sort((a, b) => b.version - a.version)[0];
}

// 查询实际表结构，避免数据库版本变化时引用不存在的列。
function columns(db: Database) {
  const result = db.exec("PRAGMA table_info(threads)");
  if (!result[0]) return new Set<string>();
  const nameIndex = result[0].columns.indexOf("name");
  return new Set(result[0].values.map((row) => String(row[nameIndex])));
}

function value(row: Record<string, SqlValue>, key: string) {
  const result = row[key];
  return result === null || result === undefined ? undefined : result;
}

// 兼容 SQLite 中以秒或毫秒保存的 Unix 时间戳。
function epoch(valueToConvert: SqlValue | undefined) {
  if (typeof valueToConvert !== "number") return undefined;
  const millis = valueToConvert > 10_000_000_000 ? valueToConvert : valueToConvert * 1000;
  return new Date(millis).toISOString();
}

// 在前端内存中只读加载状态库，并提取 threads 表的列表元数据。
export async function readStateThreads(root: HistoryDirectoryHandle): Promise<{
  threads: Map<string, StateThread>;
  fileName?: string;
}> {
  const candidate = await findStateFile(root);
  if (!candidate) return { threads: new Map() };

  const SQL = await getSql();
  const file = await candidate.handle.getFile();
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));

  try {
    const available = columns(db);
    if (!available.has("id")) return { threads: new Map(), fileName: candidate.name };
    const wanted = [
      "id",
      "title",
      "name",
      "cwd",
      "preview",
      "first_user_message",
      "created_at_ms",
      "created_at",
      "updated_at_ms",
      "updated_at",
      "model",
      "model_provider",
      "reasoning_effort",
      "tokens_used",
      "archived",
    ].filter((column) => available.has(column));
    const statement = db.prepare(
      `SELECT ${wanted.map((column) => `"${column}"`).join(", ")} FROM threads`,
    );
    const threads = new Map<string, StateThread>();

    while (statement.step()) {
      const row = statement.getAsObject();
      const id = String(value(row, "id") ?? "");
      if (!id) continue;
      const stringValue = (key: string) => {
        const current = value(row, key);
        return current === undefined ? undefined : String(current);
      };
      const tokenValue = value(row, "tokens_used");
      threads.set(id, {
        id,
        title: stringValue("title"),
        name: stringValue("name"),
        cwd: stringValue("cwd"),
        preview: stringValue("preview"),
        firstUserMessage: stringValue("first_user_message"),
        createdAt: epoch(value(row, "created_at_ms")) ?? epoch(value(row, "created_at")),
        updatedAt: epoch(value(row, "updated_at_ms")) ?? epoch(value(row, "updated_at")),
        model: stringValue("model"),
        modelProvider: stringValue("model_provider"),
        reasoningEffort: stringValue("reasoning_effort"),
        tokensUsed: typeof tokenValue === "number" ? tokenValue : undefined,
        archived: Boolean(value(row, "archived")),
      });
    }
    statement.free();
    return { threads, fileName: candidate.name };
  } finally {
    db.close();
  }
}
