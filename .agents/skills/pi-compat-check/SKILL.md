---
name: pi-compat-check
description: 检查 Pi CLI（pi.dev / @earendil-works/pi-coding-agent）升级后，CloudCLI 的会话解析器是否仍与实际写入的 JSONL transcript 格式一致。解析最新会话并与项目读取逻辑比对，识别会错误渲染、丢失分支或静默丢失消息的新结构。用于 Pi 升级、历史消息缺失/空白、树形 parentId 回溯断裂、compaction 语义变化，或兼容性复核；不用于新增 AI Provider（见 providers/README.md）或 CodeX、Claude、WorkBuddy 格式问题。
---

# Pi transcript 格式兼容性检查

cloudcli 只**读取** Pi CLI（`pi`，npm 包 `@earendil-works/pi-coding-agent`）写下的历史会话
transcript（`~/.pi/agent/sessions/<encoded-cwd>/<ISO时间戳>_<uuid>.jsonl`），从不写入。Pi 引擎升级
可能改变 transcript 结构 —— 项目解析器不认识新结构时，消息会**渲染异常、静默消失，或因树形回溯断裂而
丢失分支/内容**。本 skill 在 Pi 升级后跑一次，把这类"升级适配点"揪出来。

## Invariants

- 数据源是 `getPiSessionsRoot()` 返回目录下的 transcript JSONL，**只读**，绝不修改。
- 检查目标是项目读取逻辑：
  - `server/modules/providers/list/pi/pi-sessions.provider.ts` → `normalizePiAgentMessage()` / `readTranscript()` / `fetchHistory()`
  - `server/modules/providers/list/pi/pi-session-synchronizer.provider.ts`（header 索引 / 会话名）
  - `server/modules/providers/list/pi/pi-models.provider.ts` → `getPiAgentDir()` / `getPiSessionsRoot()`（session roots / env 覆盖）
  - `server/modules/providers/list/pi/pi-runtime.provider.ts`（实时事件词汇表）
- 每个顶层 type / message role / content block / entry 字段要么被项目渲染或读取，要么已确认无影响；未分类的就是升级信号。
- 不要为"兼容未来"猜测新格式 —— 以真实 transcript 文件为准。

## 与其他 harness 的关键差异

- **Claude**：`message.role`/`message.content` 子对象映射，风险在新增顶层 type / content block。
- **WorkBuddy**：字段在**顶层**，用户输入藏在 `<user_query>` 标签里，风险在提取失效显示注入上下文。
- **Pi**：字段在 **`entry.message` 子对象**里（`entry.message.role`/`entry.message.content`），entry 顶层
  是 `id`/`parentId`/`timestamp`/`type`；消息用**树形 `parentId`** 组织（不是单纯线性数组），历史靠
  「从文件最后一条 entry 沿 `parentId` 回溯到根」构建 active path 来跳过弃分支；compaction 用
  `firstKeptEntryId` 决定保留窗口。所以 Pi 的独特风险点是：
  **parentId 树回溯断裂 / compaction 语义变化 → 历史静默丢失分支或内容**。

## 格式基线（截至 Pi 0.85.1）

**存储**：`<sessions>/--<encoded-cwd>--/<ISO时间戳>_<session-id>.jsonl`。
- session root 官方优先级：`--session-dir`（CLI 运行时 flag）> `PI_CODING_AGENT_SESSION_DIR` >
  `sessionDir`（settings.json）> `<PI_CODING_AGENT_DIR>/sessions`（`PI_CODING_AGENT_DIR` 默认 `~/.pi/agent`）。
  `getPiSessionsRoot()` 已覆盖 env 与 `sessionDir`（相对 agent dir / 绝对 / `~`）；仅 `--session-dir`
  （每次运行的 CLI flag）无法被 CloudCLI 感知，与脚本 `sessionRoot()` 同取舍。
- `<encoded-cwd>` = `--` + cwd 去掉开头 `/` 或 `\` 后把 `/`、`\`、`:` 全部替换为 `-` + `--`
  （与 Pi 源码 session-manager.js:245 一致：`.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')`）。
- 文件名 `<ISO时间戳>_<session-id>.jsonl`；`<session-id>` 默认是 header `id`（UUID，= provider_session_id），
  但官方允许 SDK / `--session-id` 传**自定义 id（非 UUID）** —— `resolvePiTranscriptPath` 用通用 suffix
  `_<id>.jsonl` 匹配不受影响，但脚本旧 36 位 UUID 正则已放宽为「任意 id + 非 UUID 提示」。
- 解析定位兜底：`resolvePiTranscriptPath` 先按编码目录列后缀 `_<id>.jsonl`，找不到再全根递归搜 suffix。

**首行 header**：`{ type:'session', version:3, id:'<uuid>', timestamp:ISO, cwd:'<path>' }`。
同步器靠 `id`（provider_session_id）与 `cwd`（project_path）索引会话；`id`/`cwd` 任一缺失 → 该文件不索引。
runtime 靠 `id` 发 `session_created`；readTranscript 解析时直接跳过 `session` 行。
- **version 语义**（官方）：v1 = 线性旧格式（无 parentId 树，回溯不适用，加载时自动迁移）；v2 = 树结构但
  role 用 `hookMessage`；v3 = `hookMessage` 改名 `custom`。v1/v2 是历史格式，读到属正常，不是升级信号。
- **`parentSession`**：fork / clone / `newSession({ parentSession })` 产生的会话，header 额外带
  `parentSession:"/path/to/original/session.jsonl"`。同步器当前不索引它（未来 fork 继承标题 / 父子关系的升级点）。

**entry 顶层字段**（非 header 行）：`id`（**通常** 8 位 hex 字符串，官方「may fall back to a full UUID」）、
`parentId`（父 entry id，根为 null/缺省）、`timestamp`（ISO 字符串或 epoch number）、`type`。message entry 额外带 `message` 子对象。

**顶层 type 分类**：

| type | 项目处理 |
|---|---|
| `message` | 主消息载体，`entry.message.role`/`entry.message.content` → `normalizePiAgentMessage` 渲染 |
| `compaction` | active path 上的最新一条决定保留窗口；`summary` → isCompactSummary 文本（渲染）；`firstKeptEntryId` 主路径（0.85.1 无 `retainedTail`，后者仅防御性兼容分支） |
| `branch_summary` | 顶层 `summary` → isCompactSummary 文本（渲染） |
| `session_info` | 同步器取会话名（顶层 `name` 字段），渲染层跳过 |
| `session` | header（首行），解析时跳过 |
| `model_change` / `thinking_level_change` / `label` / `custom` / `custom_message` | 无 UI 行，读取时跳过 |

**树结构（官方）**：entries 通常一棵树（root `parentId:null`，leaf 是当前位置），但 `resetLeaf()` /
`branchWithSummary(null, ...)` 可产生**第二个 root** —— active path 之外除了「弃分支」，还可能存在
**第二棵合法树**（orphan 的另一来源，勿当断裂）。readTranscript 从「文件最后一条 entry」回溯，天然只走
最后一条所在的树，另一棵树的 entries 会被跳过（与弃分支同等待遇）。

**`message.role` 分类（AgentMessage）** —— 官方 union 共 7 个 role，项目已认 6 个：

| role | 处理 |
|---|---|
| `user` | `content` 为 string 或块数组 `{type:'text',text}` / `{type:'image',data,mimeType}`（图像 base64 → data URL） |
| `assistant` | `content` 块数组 `{type:'thinking',thinking}` / `{type:'text',text}` / `{type:'toolCall',id,name,arguments}`；顶层 `provider`/`model`/`usage`/`stopReason`/`errorMessage`（其余官方字段见下「官方 message 子对象字段补全」） |
| `toolResult` | 独立 entry，`toolCallId`/`toolName`/`isError` + content 块（text/image）→ tool_result 行 |
| `custom` | `display !== false` 时渲染文本（`normalizePiAgentMessage` 支持，历史主路径通常不出现） |
| `compactionSummary` / `branchSummary` | `normalizePiAgentMessage` 内部角色（`readTranscript` 把 compaction / branch_summary entry 转成这两个 summary 文本） |
| `bashExecution` | **官方 builtin role（`!`/`!!` 命令产物，字段 `command`/`output`/`exitCode`/`cancelled`/`truncated`，无 `content`）—— 项目不渲染**：落入 assistant 兜底因 content 非数组且为空而返回空数组（静默丢弃），与 Claude/Codex 对 `!` 命令结果不单独成行的一致取向；已知，非升级信号 |
| 其他未知 role | `normalizePiAgentMessage` 走 assistant 分支兜底或返回空 —— 是升级信号 |

**content block 类型**（`message.content` 数组元素，assistant/user/toolResult 共用）：`text` / `thinking` / `toolCall` / `image`。
可选字段（渲染层不读，勿当升级信号）：`textSignature`（text）、`thinkingSignature` + `redacted?: boolean`（thinking，
provider 丢弃 Anthropic thinking 时标红）、`thoughtSignature?` + `namespace?`（toolCall）。

**官方 message 子对象字段补全（已评估无影响）**：
- assistant 顶层：`api` / `responseModel` / `responseId` / `providerThinkingLevel` / `diagnostics` /
  `rawStopReason` / `endTurn` / `deferred`（deferred 是「稍后完成」的终端态，项目未区分）。
- `stopReason` 官方 7 值：`pending` / `stop` / `length` / `toolUse` / `error` / `aborted` / `deferred`。
  `pending` 不应出现在持久化 JSONL（官方）；runtime 目前只把 `error` 当失败终态，其余（含 `deferred`）都当成功。
- toolResult：`details` / `usage`（嵌套 LLM 用量）/ `addedToolNames` / `timestamp`。
- `usage` 额外字段：`cacheWrite1h?` / `reasoning?`（assistant / toolResult 共用）。
- compaction 顶层：`firstKeptEntryId` 官方标 **required**；另有 `tokensBefore` / `usage` / `details` / `fromHook`
  （extension 生成时为 true）。`retainedTail` 是项目自己的防御分支，官方无（保留）。
- branch_summary 顶层：`fromId`（被总结废弃分支的叶子）+ `summary` + 可选 `usage`/`details`/`fromHook`。
  项目只渲染 `summary`，`fromId` 未来做分支可视化有用。
- `custom` entry（`customType`/`data`）官方**不参与** LLM context；`custom_message` entry
  （`customType`/`content`/`display`/`details`）**参与** context，`display:true` 时 TUI 显示。项目 readTranscript
  两者都无 UI 行跳过 —— `custom_message` 的 `display:true` 上下文会丢，可再评估是否渲染。
- `label` entry：`targetId`（指向目标 entry）/`label`（设 `undefined` 清除）。项目跳过。

**实时事件词汇表**（runtime 认知，历史 transcript 通常不出现）：
- 消费：`session`（提取 UUID）、`message_end`（跳过 `role:user` 回显；`role:assistant` 渲染；`stopReason:'error'` → error 终态）、`agent_end` / `agent_settled`（运行结束标记，不覆盖 error 终态）。
- 忽略（不做打字机，`message_end` 一次性渲染）：`agent_start`、`turn_start`、`turn_end`、`message_start`、`message_update`、`tool_execution_start` / `tool_execution_update` / `tool_execution_end`、`queue_update`、`compaction_start`、`compaction_end`。
- 未知 type → `console.warn` 跳过。

## 项目读取位置

- `pi-sessions.provider.ts` → `normalizeMessage(raw, sessionId)`：接受标准 message entry
  （`entry.message` 子对象）或裸 AgentMessage；有 `message` 字段则 `normalizePiAgentMessage(entry.message, entry.id)`，
  否则按裸 AgentMessage 处理。
- `pi-sessions.provider.ts` → `readTranscript()`（历史主链路）：
  1. 逐行 parse，坏行跳过，`type==='session'` 跳过。
  2. `byId` 建索引（`id` 为字符串的 entry），从**文件最后一条 entry** 沿 `parentId` 回溯到根，
     reverse 得到 active path（天然跳过弃分支）。
  3. active path 上最新的 `compaction` 决定保留窗口：有 `retainedTail` 走防御分支；
     否则取 `firstKeptEntryId` 在 active path 上定位起始下标。
  4. 无 compaction → 顺序遍历整个 path；有 compaction → 依官方 `buildContextEntries` 顺序
     （summary 在前 → firstKeptEntryId 到 compaction 之间 → compaction 之后）。
  5. `processEntry`：`message` → normalize 渲染；`branch_summary` → summary 文本；其余 type 无 UI。
  6. usage = active path 上最后一条 assistant message 的 `message.usage`。
- `pi-session-synchronizer.provider.ts`：读 header 拿 `id`/`cwd`；`session_info.name` 取显式名，
  兜底第一个 user prompt 的 text（string 或块数组）；首扫全量、后续用增量 cursor；归档会话不复活。
- `pi-models.provider.ts` → `getPiSessionsRoot()`：优先级 `PI_CODING_AGENT_SESSION_DIR` >
  `sessionDir`(settings.json) > `<agentDir>/sessions`（`sessionDir` 相对 agent dir / 绝对 / `~`）；
  `--session-dir` CLI flag 不可观测，忽略。见「格式基线」。

## Workflow

1. 确认本次针对 Pi（CodeX 用 `codex-compat-check`，Claude 用 `claude-compat-check`，WorkBuddy 用 `workbuddy-compat-check`，DSH 用 `dsh-compat-check`）。
2. 运行检查脚本（在仓库根目录）：

```bash title=运行-pi-格式检查
node .claude/skills/pi-compat-check/check-pi-format.mjs          # 最新会话
node .claude/skills/pi-compat-check/check-pi-format.mjs --all    # 最近 5 个
node .claude/skills/pi-compat-check/check-pi-format.mjs <路径>    # 指定会话
```

3. 解读报告：
   - 顶层 type 标 `需评估` → 新 type，确认它是否被 readTranscript / normalizeMessage 处理。
   - message role 标 `需评估` → 新 role（user/assistant/toolResult/custom/compactionSummary/branchSummary 之外）。
     未识别 role 会被 assistant 分支兜底或返回空，历史可能渲染错。`bashExecution` 显示「官方存在但未渲染」，属已知，不需改。
   - content block 标 `需评估` → 新 block 类型（text/thinking/toolCall/image 之外），normalize 不渲染。
   - **`树形 parentId 回溯 ⚠️`** → Pi 最关键的信号：leaf 缺失或在文件中间、回溯断链、parentId 字段消失 —— readTranscript 会静默丢失分支/内容。
   - **`compaction 字段 ⚠️`** → summary/firstKeptEntryId/retainedTail 全缺失，或出现新字段 —— compaction 无法生效或语义漂移。
   - **`header 字段 ⚠️`** → 首行 `session` 缺 `id`/`cwd`，或文件名 uuid ≠ header id —— 同步器索引失败 / fetchHistory 定位错位。
   - **`message 子对象 ⚠️`** → message entry 缺 `entry.message`，或 role/content 不在预期位置 —— normalize 返回空。
   - `已评估` / `已适配` → 已知无影响，忽略。
   - 空文件 / 坏行 → readTranscript 本就不读这些行，跳过后续对照。
4. 若发现真实变化：按「适配指引」改 `normalizePiAgentMessage` / `readTranscript` / 同步器，加单测验证。
5. 把新确认的类型更新进本 SKILL.md 的「格式基线」，并同步脚本的 KNOWN_* 常量。

## 适配指引（参考现有读取模式）

1. **新顶层 type**：判断它出现在历史还是仅实时。历史 → 在 `readTranscript` 的 `processEntry` 补分支
   （渲染型仿 `branch_summary`，元数据型仿 `session_info` 交给同步器）；仅实时 → 在 `pi-runtime.provider.ts`
   的 `processLine` 加分支或忽略。
2. **新 content block 类型**：确认字段，在 `normalizePiAgentMessage` 对应 role 分支加 `else if`，
   前端 `normalizedToChatMessages` 补渲染。
3. **parentId 树回溯断裂**：改 `readTranscript` 的回溯逻辑（leaf 选择 / parentId 字段名 / 断链容错），
   并把新语义反映到 `pi-sessions.test.ts` 的分支用例。
4. **compaction 语义变化**：改 `readTranscript` 的 compaction 分支
   （`firstKeptEntryId` 定位 / `retainedTail` 兼容 / `summary` 字段名）。
5. **header 字段变化**：改同步器 `processSessionFile` 的 `extractFirstValidJsonlData` 提取逻辑，
   以及 `resolvePiTranscriptPath` 的 suffix 匹配；文件名 uuid ≠ header id 时要核对 provider_session_id 语义。
6. 测试：在 `server/modules/providers/tests/pi-sessions.test.ts` / `pi-session-synchronizer.test.ts` 加用例
   （构造新格式 transcript，断言 normalize 结果）；`npm run typecheck && npm test` 全绿后再收工。
7. **保留既有分支** —— 老 transcript 仍是旧格式，移除旧分支会导致历史会话回归。

## 相关资产

- 代码基线：`pi-sessions.provider.ts` 的 `normalizePiAgentMessage`(line 149+) / `readTranscript`(line 555+) /
  `resolvePiTranscriptPath`(line 26+) / `encodePiCwd`(line 16+)；`pi-session-synchronizer.provider.ts` 的
  `processSessionFile`(line 116+) / `extractSessionName`(line 155+)；`pi-models.provider.ts` 的
  `getPiSessionsRoot`(line 47+)；`pi-runtime.provider.ts` 的 `processLine`(line 251+)。
- 测试基线：`pi-sessions.test.ts`（normalize 各块 / 树分支 / compaction 两种形态 / 分页 / usage）、
  `pi-session-synchronizer.test.ts`（header 索引 / session_info 名 / 首条 user 兜底 / 坏行 / 归档复活 / cursor）。
- 真实样例：`~/.pi/agent/sessions/` 下运行过 `pi` 的会话（若本机安装了 `pi`）。