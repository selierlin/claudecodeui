---
name: codex-compat-check
description: 检查 CodeX CLI 升级后，CloudCLI 的会话解析器是否仍与实际写入的 rollout JSONL 格式一致。解析最新 rollout 并与项目读取逻辑比对，识别会静默丢失消息的格式迁移。用于 CodeX 升级、用户或子代理消息缺失/空白，或兼容性复核；不用于新增 AI Provider（见 providers/README.md）或 WorkBuddy、Claude 格式问题。
---

# CodeX rollout 格式兼容性检查

cloudcli 只**读取** CodeX CLI 写下的历史会话文件（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`），从不写入。
CodeX CLI 升级可能改变 rollout 的 JSONL 事件结构 —— 若项目解析器不认识新结构，**旧逻辑会静默丢弃消息**
（例：CodeX 0.150 把用户消息从 `event_msg.user_message` 迁到 `item_completed.UserMessage`，用户消息全部消失，
直到本项目加了 `UserMessage` 分支才修复）。本 skill 在 CodeX 升级后跑一次，把这类"升级适配点"揪出来。

## Invariants

- 数据源是 `~/.codex/sessions/` 下的 rollout JSONL，**只读**，绝不修改。
- 检查目标是项目读取逻辑：`server/modules/providers/list/codex/codex-sessions.provider.ts`
  的 `getCodexSessionMessages()`，以及搜索服务 `session-conversations-search.service.ts`。
- 每个事件类型要么被项目读取（`PROJECT_READS`），要么已确认无影响（`KNOWN_NOT_READ`）；
  未分类的事件类型就是需要评估的候选信号。
- 不要为了"兼容未来"猜测新格式 —— 以真实 rollout 文件为准。

## 格式基线（截至 CodeX 0.150.1）

外层 `type` 分两类：

| 外层 type | 含义 |
|---|---|
| `event_msg` | 会话事件流。`payload.type` 再细分（`user_message`/`token_count`/`item_completed`/`sub_agent_activity`/`task_started`…） |
| `response_item` | 模型侧响应条目。`payload.type` = `message`/`reasoning`/`agent_message`/`function_call`/`function_call_output`/`custom_tool_call`/`custom_tool_call_output`/`todo_list` |

新格式核心变化（0.150，8/29 起全面生效）：**item_completed** 携带 `payload.item`（`{ type, id, ... }`）。

| 事件 | 旧格式（≤0.146） | 新格式（≥0.150） |
|---|---|---|
| 用户消息 | `event_msg` + `payload.type=user_message`（content 为 `{type:'text',text}`） | `event_msg` + `item_completed` + `item.type=UserMessage`（content 为 `[{type:'text',text}]`） |
| 子任务活动 | `event_msg` + `sub_agent_activity` | `event_msg` + `item_completed` + `item.type=SubAgentActivity`（`kind=started` 时含 `agent_path`，`id` = spawn call_id） |
| 子任务消息 | `event_msg` + `agent_message`（旧） | `response_item` + `agent_message` |
| 子任务 agent path | `sub_agent_activity` 内 | `SubAgentActivity.agent_path`；另有 `function_call_output` 的 `task_name` 兜底 |

**会话类型判定（synchronizer 据此决定是否索引）**：`session_meta` 是顶层 `type`（非 `event_msg`），
payload 含 `session_id`/`id`/`source`/`thread_source`。`thread_source==='user'` 且 `source` 为字符串
（`exec`/`cli`）是**主会话**（会被索引展示）；`thread_source==='subagent'` 或 `source` 为对象且含
`subagent` 键是**子代理线程**（`codex-session-synchronizer.provider.ts:158` 直接跳过，不索引）。
子代理线程（如 spawn/协作 fork 出的 `01a04ac3-*`、`01a04723-*`）里用户消息只存在于
`response_item.message.role==='user'`，**无 UserMessage item** —— 属正常，不要当成用户消息丢失。

**新旧冗余 & 已知无影响（勿当回归）**：

- 待办列表：项目读 `response_item:todo_list`（`codex-sessions.provider.ts:423`），但全部会话（新旧）都未产生该事件，
  当前无数据来源 —— 非迁移非回归。**若未来出现 `item_completed:TodoList`，需按 UserMessage 模式适配**
  （TodoList item 的 `items` 结构与旧 `response_item` 的 `items` 是否一致要实测确认）。
- reasoning 的 `summary` 可能是非空 `summary_text` 数组；项目读取 `summary[].text` 并归一化为 thinking。旧会话 summary 为空、内容在 `encrypted_content` 时 thinking 不展示。
- exec 命令参数键新旧都是 `cmd`（项目按 `command` 提取，提取率新旧都低，见 `translateCodexExecInput`）。
- 文件编辑新旧都不展示（旧 `patch_apply_end`、新 `FileChange` item 项目都不读）。
- `item_completed:Reasoning`/`CommandExecution`/`AgentMessage` 与对应 `response_item` 冗余，项目已读后者。
- `task_started`/`task_complete`/`thread_settings_applied`/`CollabAgentToolCall` 是元数据，无展示价值。

## 项目读取位置

- `codex-sessions.provider.ts` → `getCodexSessionMessages()`：
  - `isVisibleCodexUserMessage()` 只认旧格式 `payload.type === 'user_message'`（0.150 修复点在它之后新增了 `item_completed.UserMessage` 分支）。
  - `extractCodexTextContent()` 处理 `input_text`/`output_text`/`text` 类型（不处理大写 `Text`，那是 `item_completed.AgentMessage` 的内容块）。
  - `parseCodexSubagentMessage()` / spawn_agent function_call 分支 / SubAgentActivity 分支 → 子任务生命周期与 agent path 关联（`subagentsByCallId`/`subagentsByPath`）。
- `session-conversations-search.service.ts` → `parseCodexSessionMatches()`：通过 `response_item.message.role==='user'` 读新格式用户消息（有指纹去重）；`isInternalCodexContent()` 的前缀列表只覆盖 `<environment_context>`/`<cwd>`，覆盖不到 `# AGENTS.md instructions…` 系统注入。

## Workflow

1. 确认本次针对 CodeX（WorkBuddy/Claude 的格式问题不要用本 skill）。
2. 运行检查脚本（在仓库根目录）：

```bash
node .claude/skills/codex-compat-check/check-codex-format.mjs          # 最新会话
node .claude/skills/codex-compat-check/check-codex-format.mjs --all    # 最近 5 个
node .claude/skills/codex-compat-check/check-codex-format.mjs <路径>    # 指定会话
```

3. 解读报告：
   - `⚠️ 项目读取但缺失 + 需确认` → 项目读的旧格式本会话没有，需查证是否被新格式替代（报告会给 `预期迁移` 标注，属正常）。
   - `🆕 需评估` → 本会话有、项目不读、也不在 `KNOWN_NOT_READ` 里的事件，**这是升级信号**，重点分析。
   - `ℹ️ 已评估` → 已知冗余/元数据，无需处理。
4. 若发现真实迁移：按下方「适配指引」补分支，加单测，跑 `npm test -- codex-sessions` 验证。
5. 把新确认的格式更新进本 SKILL.md 的「格式基线」，并把已适配类型加进 `PROJECT_READS`。

## 适配指引（参考 0.150 修复）

新格式事件大多走"在外层 `event_msg` 分支里按 `payload.item.type` 分流"模式，在 `getCodexSessionMessages()` 里
对应旧格式分支之后新增一个并分支：

1. 在旧分支之后新增 `item_completed` 匹配条件，读 `payload.item.type`。
2. 复用 `extractCodexTextContent()` 提取文本；`trim()` 后为空则跳过（过滤 AGENTS.md 等系统注入）。
3. 若事件带 `id`，用它关联既有 map（如 SubAgentActivity 的 `id` = spawn `call_id`，可直接写入 `subagentsByCallId`）。
4. **保留旧格式分支** —— 老会话文件（8/10、8/28 等）仍是旧格式，移除会导致历史会话回归。
5. 在 `server/modules/providers/tests/codex-sessions.test.ts` 加测试：用 `writeCodexTranscript` 构造新格式
   transcript + `patchHomeDir` + `withIsolatedDatabase`，断言消息数/关联正确。测试用例参考现有
   「Codex history restores UserMessage items」与「links SubAgentActivity items to spawned sub-agents」两条。
6. `npm run typecheck && npm test` 全绿后再收工。

## 相关资产

- 真实样例：问题会话 `~/.codex/sessions/2026/08/29/rollout-...01a04a39...jsonl`（新格式）；8/28 会话（旧格式，4527 行）。
- 修复提交对应的测试：`server/modules/providers/tests/codex-sessions.test.ts` 中 `UserMessage` / `SubAgentActivity` 两条用例。
