# Codex History

一个完全运行在浏览器中的 Codex CLI 历史记录阅读器。它通过 File System Access API 读取用户选择的 `CODEX_HOME`，不会上传文件，也不会修改本地历史。

主要能力：

- 同时扫描 `sessions/` 与 `archived_sessions/` 中的 rollout JSONL。
- 通过 `session_index.jsonl` 获取自定义标题，并使用 WASM 版 SQLite 只读加载最新的 `state_*.sqlite`，补充工作区、摘要、模型和 token 等信息。
- 按标题、摘要、工作区或会话 ID 搜索，并区分活跃与归档会话。
- 单条会话可切换“对话记录”和“详细信息”：前者展示用户消息、助手回复和工具名称，`exec` 会解析为内部工具名称，shell 调用展示完整命令（动态参数保留原始表达式）；后者逐块展示完整 rollout，包括 reasoning、工具参数与返回、token 用量、上下文、运行事件和未知记录，并可展开原始 JSON。
- 对较大的 rollout 只读取首尾片段来生成列表，打开详情时再读取完整文件。列表中带 `≥` 的块数量表示首尾采样计数。

## 本地运行

要求 Node.js 20.19+ 或 22.12+，并使用支持 File System Access API 的最新版 Chromium 浏览器（Chrome、Edge 等）。

```bash
npm install
npm run dev
```

生产构建与本地预览：

```bash
npm run build
npm run preview
```

项目使用 Vue 3、Vue Router、Vite 8、Element Plus 和 `sql.js`。TypeScript 固定在 6.x 兼容线，不使用尚未被当前 `vue-tsc` 完整适配的 TypeScript 7。

页面使用 History 路由：`/` 是主页，`/history` 是历史记录列表，`/history/:id` 是会话详情子路由。页面切换时会保留已读取的会话；刷新后浏览器需要重新授权本地文件夹，选择后可继续查看当前详情链接。生产部署时，请将这些页面路径的请求回退到 `index.html`。

历史记录页采用双栏布局：左侧展示标题、工作目录和活动时间，右侧显示所选会话的元信息与记录内容，并可切换“对话记录”和“详细信息”。

浏览器目录选择器中应选择 Codex 的根目录，即包含 `sessions/`、`session_index.jsonl` 和 `state_*.sqlite` 的目录。默认通常为 `~/.codex`；本机也可能通过 `CODEX_HOME` 指向其他位置。

> File System Access API 需要安全上下文。开发环境的 `http://localhost` 可直接使用；部署时需要 HTTPS。SQLite 主文件可能落后于仍在 WAL 中的实时写入，因此列表元数据以“尽力读取”为原则，完整对话始终以 rollout JSONL 为准。

---

# Codex CLI 历史记录存储方式

## 结论

Codex CLI 的“历史记录”不是一个单独文件，而是以 **rollout JSONL 为完整会话事件流，再配合若干索引和 SQLite 投影** 组成的本地存储。

```text
CODEX_HOME（默认 ~/.codex）
├── sessions/YYYY/MM/DD/rollout-<time>-<thread-id>.jsonl  # 活跃会话的完整追加事件流
├── archived_sessions/*.jsonl                           # 已归档的 rollout
├── history.jsonl                                      # 用户输入历史，不是完整对话
├── session_index.jsonl                                # 线程 ID 与自定义标题的追加索引
├── state_5.sqlite[/-wal/-shm]                          # 线程元数据与状态
└── thread_history_1.sqlite[/-wal/-shm]                 # 面向分页读取的 turn/item 投影
```

因此：

- 要还原一段完整对话，核心数据是 `sessions/` 或 `archived_sessions/` 中的 rollout JSONL。
- `history.jsonl` 只能视为用户 prompt 历史，不能单独用来恢复助手回复、工具调用和 token 数据。
- `state_5.sqlite` 和 `session_index.jsonl` 主要让 CLI/上层应用快速列出、命名和筛选线程。
- `thread_history_1.sqlite` 保存按 turn/item 分页的结构化投影。从其 `rollout_ordinal`、`rollout_byte_offset` 和 `thread_history_projection_state` 可以看出，它是从 rollout 同步出的读模型，不应取代 rollout 作为备份中的会话事实源。

OpenAI 官方文档说明了 `CODEX_HOME` 默认为 `~/.codex`，并列出 `history.jsonl` 等常见本地状态文件；也可通过 `history.persistence` 关闭历史持久化，或用 `history.max_bytes` 限制历史文件大小。参见 [OpenAI Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#history-persistence)。

## 核心文件

### 1. rollout JSONL：完整会话事件流

活跃会话按日期分区存放：

```text
$CODEX_HOME/sessions/YYYY/MM/DD/
  rollout-YYYY-MM-DDTHH-MM-SS-<thread-id>.jsonl
```

归档后的文件位于：

```text
$CODEX_HOME/archived_sessions/*.jsonl
```

JSONL 表示“每行一个 JSON 对象”。Codex 在会话进行时持续追加，所以文件末尾可能暂时存在一条尚未写完的 JSON。

顶层通用结构是：

```json
{ "timestamp": "<RFC3339>", "type": "<event-type>", "payload": {} }
```

本机 Codex CLI 0.155.1 的样本中观察到以下主要类型：

| 顶层 `type`          | 作用                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `session_meta`       | 会话根元数据：`id`、`cwd`、`cli_version`、`source`、`model_provider`、`history_mode` 等 |
| `turn_context`       | 当前 turn 的模型、配置和上下文                                                          |
| `response_item`      | 用户/助手消息、reasoning、函数或自定义工具调用及返回值                                  |
| `event_msg`          | turn 状态、item 完成、`token_count` 等运行事件                                          |
| `token_usage_record` | token 用量记录                                                                          |
| `world_state`        | 会话运行环境状态                                                                        |

`response_item.payload` 中会根据子类型出现 `role`、`content`、`name`、`input`、`output`、`summary`、`encrypted_content` 等字段。这些文件不只包含聊天文本，还可能包含工具参数、命令输出、工作目录和对话时注入的指令，应当按敏感数据处理。

会话 ID 主要来自 `session_meta.payload.id`，并出现在文件名中。`cc-switch` 还兼容 revert 产生的双 UUID 文件名：

```text
rollout-<time>-<thread-id>_<rollout-id>.jsonl
```

其中前一个 UUID 是稳定的逻辑 thread ID，后一个用于标识替换后的物理 rollout。fork/子代会话还可通过 `forked_from_id` 或 `source.subagent.thread_spawn.parent_thread_id` 指向父线程。

### 2. `history.jsonl`：prompt 输入历史

本机每行的实际结构为：

```json
{ "session_id": "<thread-id>", "ts": 1234567890, "text": "<user input>" }
```

它是一个追加的用户输入列表，可用 `session_id` 回指所属线程。它不包含完整的助手消息和工具事件，所以不是 rollout 的替代品。

官方文档把该文件纳入 `[history]` 配置：

```toml
[history]
persistence = "none"        # 禁用本地历史持久化
max_bytes = 104857600       # 超限后删除最旧条目并压紧
```

对于“关闭该设置是否同时影响 rollout”，本次阅读的官方页面和 `cc-switch` 源码没有给出足够证据，因此不做延伸推断。

### 3. `session_index.jsonl`：线程标题索引

本机实际格式为：

```json
{ "id": "<thread-id>", "thread_name": "<title>", "updated_at": "<RFC3339>" }
```

同一 `id` 可以有多条记录；按文件顺序读取时，后出现的标题覆盖前者。该文件是标题索引，不存放消息正文。

### 4. `state_5.sqlite`：线程元数据

当前版本的 `threads` 表主要包含：

- 标识与定位：`id`、`rollout_path`、`cwd`、`project_id`。
- 时间与状态：`created_at[_ms]`、`updated_at[_ms]`、`recency_at[_ms]`、`archived`、`archived_at`、`is_pinned`。
- 展示与搜索：`title`、`name`、`first_user_message`、`preview`。
- 运行上下文：`source`、`thread_source`、`model_provider`、`model`、`reasoning_effort`、`sandbox_policy`、`approval_mode`、`tokens_used`、`history_mode`。

其他表记录项目、附件、动态工具、线程父子边等状态。SQLite 文件名带版本号，未来可能从 `state_5.sqlite` 升级为新名称，不应在工具中把它当作永久不变的 API。

Codex 运行时可能通过 WAL 写入；备份时不应在进程运行中只拷贝 `.sqlite` 主文件。应先退出 Codex，或使用 SQLite 的 backup 机制，否则可能遗漏 `-wal` 中尚未 checkpoint 的变更。

`state_5.sqlite` 默认在 `CODEX_HOME` 下，但可由 `config.toml` 中的 `sqlite_home` 或 `CODEX_SQLITE_HOME` 环境变量改到其他目录。

### 5. `thread_history_1.sqlite`：分页历史投影

本机数据库包含以下表：

- `thread_turns`：每个 turn 的状态、时间、首个用户 item、最终助手 item，以及 rollout 字节偏移。
- `thread_items`：按 `rollout_ordinal` 排序的 item，实体保存在 `item_json`。
- `thread_realtime_items`：实时会话 item。
- `thread_history_projection_state`：每个线程已投影到的 rollout 字节偏移和序号。

这套结构适合快速分页，但 `cc-switch` 3.20.3 当前不依赖它来枚举或展示 Codex 会话，而是直接解析 rollout。

## 这些数据如何关联

同一个 thread ID 是各层之间的主要关联键：

```text
history.jsonl.session_id
             │
             ├──> rollout.session_meta.payload.id
             │             └── response_item / event_msg / token usage
             │
             ├──> session_index.jsonl.id
             │             └── thread_name
             │
             ├──> state_5.sqlite.threads.id
             │             └── title / cwd / provider / archived / rollout_path
             │
             └──> thread_history_1.sqlite.thread_*
                           └── turns / items / projection cursor
```

一次典型写入过程可以理解为：

1. 创建线程时，Codex 创建 rollout，先写入 `session_meta`。
2. 每个 turn 持续向同一 rollout 追加上下文、消息、工具和 token 事件。
3. 用户输入另外追加到 `history.jsonl`，用于 prompt 历史。
4. 线程标题和列表所需元数据写入 `session_index.jsonl` / `state_5.sqlite`。
5. 在本机使用的 `history_mode = "paginated"` 下，rollout 内容被投影到 `thread_history_1.sqlite` 的 turn/item 表中。

## `cc-switch` 如何读取 Codex 历史

本次阅读的 `cc-switch` 版本为 3.20.3（commit `c7ce3a85`）。关键逻辑在：

- `../cc-switch/src-tauri/src/session_manager/providers/codex.rs`
- `../cc-switch/src-tauri/src/services/session_usage_codex.rs`
- `../cc-switch/src-tauri/src/codex_state_db.rs`
- `../cc-switch/src-tauri/src/codex_history_migration.rs`
- `../cc-switch/src-tauri/src/codex_config.rs`

### 会话列表

`cc-switch` 递归扫描 `sessions/` 和 `archived_sessions/` 下的所有 `.jsonl` 文件，从每个文件的前 10 行和后 30 行快速提取：

- `session_meta.payload.id` → 会话 ID。
- `session_meta.payload.cwd` → 项目目录。
- 首部时间戳 → 创建时间。
- 尾部时间戳 → 最后活动时间。
- 尾部最后一条非空 message → 摘要。

它会过滤 `session_meta.payload.source` 中带 `subagent` 对象的子代 rollout，避免把内部子任务当成独立的顶层会话。

标题选择顺序为：

1. `state_5.sqlite` 中与首条用户消息不同的显式 `title`。
2. `session_index.jsonl` 中的 `thread_name`。
3. rollout 中的第一条真实用户消息。
4. `cwd` 的最后一段目录名。

最后生成的恢复命令是 `codex resume <thread-id>`。

### 消息详情

`cc-switch` 逐行解析 rollout，但会话详情页只转换 `response_item` 中的：

- `message`：按原 `role` 展示 `content`。
- `function_call`：显示为助手的 `[Tool: <name>]`。
- `function_call_output`：显示为 tool 输出。

它会忽略 reasoning、token 事件和其他不识别的 payload 类型。值得注意的是，本机 0.155.1 样本已出现 `custom_tool_call` / `custom_tool_call_output`，而该读取器当前只显式处理 `function_call` / `function_call_output`；因此在 `cc-switch` 详情页看不到某些工具记录，不代表 rollout 中没有这些记录。

### token 与用量

`cc-switch` 的用量导入器同时扫描活跃和归档 rollout，主要使用：

- `session_meta` 确定 thread 及父子关系。
- `turn_context` 确定当前模型。
- `event_msg.payload.type = "token_count"` 取累计与单次 token 用量。

它优先使用 `last_token_usage` 作为单次调用用量；否则由 `total_token_usage` 累计值计算差分。同步游标按文件路径、修改时间、字节大小和行偏移记录，对正在追加的文件会留下未完整的最后一行，等下一轮再试。

### 标题和供应商迁移

`cc-switch` 会读取 `session_index.jsonl` 与 `state_5.sqlite.threads` 的标题。它的“统一 Codex 会话历史”迁移还会在备份后，同时改写：

- rollout `session_meta.payload.model_provider`。
- `state_5.sqlite.threads.model_provider`。

这说明 provider 分组同时存在事件流和元数据库两处；只改其中一处会造成视图不一致。

### 删除语义

`cc-switch` 的 Codex 会话删除操作会：

1. 校验目标路径位于 `sessions/` 或 `archived_sessions/` 内。
2. 解析 rollout，确认其 thread ID 与请求一致。
3. 删除该 rollout JSONL 文件。

当前代码没有在同一操作中删除 `history.jsonl`、`session_index.jsonl`、`state_5.sqlite` 或 `thread_history_1.sqlite` 中的对应记录。所以这是“删除会话事件文件”，不是对所有本地副本的完整擦除。

## 本机实际情况

检查日期：2026-09-20。

- Codex CLI：`0.155.1`。
- npm 包仅包含 Node.js 启动器，它再执行平台对应的 Rust 原生二进制。
- 当前 `CODEX_HOME=/Users/xwwwb/Env/CodexEnv`，因此数据不在默认的 `~/.codex`。
- 本机样本有 2 个 thread，rollout 的 `history_mode` 为 `paginated`；`state_5.sqlite` 和 `thread_history_1.sqlite` 中也有对应的线程/投影记录。
- `config.toml` 未显式设置 `[history]`、`sqlite_home`，当前 shell 也未设置 `CODEX_SQLITE_HOME`，因此 SQLite 仍在 `CODEX_HOME` 内。

一个对本机尤其重要的兼容性细节是：`cc-switch` 3.20.3 的 `get_codex_config_dir()` **不会自动读取 `CODEX_HOME`**。它的选择顺序是：

1. `cc-switch` 设置中的 `codex_config_dir` 自定义目录。
2. 如果没设置，回退到 `~/.codex`。

因此，若要让 `cc-switch` 读到当前 Codex CLI 的会话，需在 `cc-switch` 中把 Codex 配置目录显式设为：

```text
/Users/xwwwb/Env/CodexEnv
```

`CODEX_SQLITE_HOME` 则是另一件事：在 `cc-switch` 已经确定 Codex 配置目录后，它会继续检查 `sqlite_home` / `CODEX_SQLITE_HOME` 以寻找可能外置的 `state_5.sqlite`。

## 备份与隐私建议

要完整备份可恢复的对话，至少保留：

```text
$CODEX_HOME/sessions/
$CODEX_HOME/archived_sessions/        # 若存在
$CODEX_HOME/history.jsonl
$CODEX_HOME/session_index.jsonl
$CODEX_HOME/state_5.sqlite*
$CODEX_HOME/thread_history_1.sqlite*
```

其中 rollout 是最重要的会话事实源。SQLite 建议在 Codex 退出后备份，并把对应的 `-wal` / `-shm` 视为同一组运行状态。

不要把整个 `CODEX_HOME` 直接提交到 Git：除了对话和工具输出，其中还可能有 `auth.json`、日志、shell snapshot 和其他敏感状态。本次调查只读取了历史文件的结构、事件类型和 SQLite schema，没有把实际对话正文或认证内容写入本文档。

## 证据边界

本文的结论来自三类证据：

1. OpenAI 官方文档中关于 `CODEX_HOME`、`history.jsonl` 和 `[history]` 配置的说明。
2. 本机 Codex CLI 0.155.1 的安装文件、历史 JSONL 字段和 SQLite schema。
3. `cc-switch` 3.20.3 对 Codex 会话的扫描、解析、用量导入、迁移和删除代码。

这些文件属于 Codex 的本地实现细节，并非承诺永久稳定的公开数据 API。特别是 SQLite 文件名、schema 版本和 rollout 事件类型，都可能随 CLI 版本变化；编写解析器时应容忍未知字段、未知事件、部分写入的末行和新的数据库版本。
