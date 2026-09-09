---
name: workbuddy-compat-check
description: 检查 WorkBuddy 或 CodeBuddy 升级后，CloudCLI 的会话解析器是否仍与实际写入的 JSONL transcript 格式一致。解析最新会话并与项目读取逻辑比对，识别会错误渲染、展示注入上下文或丢失的新结构。用于 WorkBuddy/CodeBuddy 升级、用户提示被注入上下文替代、消息或工具事件缺失/空白，或兼容性复核；不用于新增 AI Provider（见 providers/README.md）或 CodeX、Claude 格式问题。
---

# WorkBuddy / CodeBuddy transcript 格式兼容性检查

cloudcli 只**读取** WorkBuddy（`~/.workbuddy`）与 CodeBuddy CLI（`~/.codebuddy`）写下的历史会话
transcript（`projects/<encoded-cwd>/<session-id>.jsonl`），从不写入。WorkBuddy 引擎升级可能改变
transcript 结构 —— 项目解析器不认识新结构时，消息会**渲染异常、静默消失，或显示注入上下文而非用户输入**。
本 skill 在 WorkBuddy 升级后跑一次，把这类"升级适配点"揪出来。

## Invariants

- 数据源是 `~/.codebuddy/projects/` 与 `~/.workbuddy/projects/` 下的 transcript JSONL，**只读**，绝不修改。
- 检查目标是项目读取逻辑：
  - `server/modules/providers/list/workbuddy/workbuddy-sessions.provider.ts` → `normalizeMessage()` / `readTranscript()` / `extractUserPrompt()`
  - `server/modules/providers/list/workbuddy/workbuddy-session-synchronizer.provider.ts`（索引/会话名/transient workspace 跳过）
  - `server/modules/providers/list/workbuddy/workbuddy-storage.provider.ts`（session roots / env 覆盖）
- 每个顶层 type / content block / 事件字段要么被项目渲染或读取，要么已确认无影响；未分类的就是升级信号。
- 不要为"兼容未来"猜测新格式 —— 以真实 transcript 文件为准。

## 与 CodeX / Claude 的关键差异

- **CodeX**：逐事件重构消息，风险在事件格式迁移（`user_message`→`UserMessage`）。
- **Claude**：`message.role`/`message.content` 子对象映射，风险在新增顶层 type / content block。
- **WorkBuddy**：字段在**顶层**（无 `message` 子对象），`role`/`content` 直接在事件上；
  工具调用走**顶层 `function_call` / `function_call_result` 事件**而非 content block；
  用户输入藏在 `<user_query>…</user_query>` 标签里（前面是 `<system-reminder data-role="user-context">`
  注入）。所以 WorkBuddy 的独特风险点是：**用户输入提取失效 → 历史显示注入上下文**。

## 格式基线（截至当前 WorkBuddy 版本）

**存储**：`~/.codebuddy/projects/<encoded-cwd>/<session-id>.jsonl` + `~/.workbuddy/projects/<encoded-cwd>/<session-id>.jsonl`，
两个 root 都扫（`getWorkbuddySessionRoots`；`WORKBUDDY_PROJECTS_ROOT` / `WORKBUDDY_CONFIG_DIR` /
`CODEBUDDY_CONFIG_DIR` 可覆盖）。`<encoded-cwd>` = `cwd` 去掉开头 `/` 后把 `/` 替换为 `-`
（比 Claude 简单，但别推导，以扫描为准）。子代理 `agent-<id>.jsonl` 在 `<session-id>/subagents/`、
工具结果在 `<session-id>/tool-results/`，同步器跳过这两个目录。`sessionId` = 文件名（不含 `.jsonl`）。

**transient workspace**：cwd 匹配 `/\/WorkBuddy\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/`（`~/WorkBuddy/<时间戳>`）
是桌面端每次打开创建的临时工作区，同步器跳过，不索引展示。

**行结构**：JSONL 每行 `{ id?, timestamp, type, ..., sessionId?, cwd?, role?, content? }`，字段在**顶层**。

**顶层 type 分类**：

| type | 项目处理 |
|---|---|
| `message` | 主消息载体。`role` 顶层（user/assistant），`content` 顶层数组（block 见下） |
| `function_call` | normalizeMessage → tool_use（`name`/`callId`/`arguments`，toolId 兜底 `id`） |
| `function_call_result` | normalizeMessage → tool_result（`callId`/`status`/`output`；status 非空且非 completed → isError） |
| `ai-title` | 同步器取会话名（`aiTitle` + `sessionId` 匹配），从文件末尾往前扫 |
| `reasoning` | 含 `content`/`rawContent`/`providerData`，normalize 返回 []，readTranscript 跳过 |
| `file-history-snapshot` | 文件历史快照，跳过 |
| `resend-fork-notice` | fork 编辑元数据（`editedUserItemId`），normalize 返回 []；所在会话通常是 transient workspace |
| `system` | `subtype` 以 `task_` 开头 → task_notification（`normalizeTaskEvent`）；`subtype=init` 是实时初始化；其他 subtype normalize 返回 [] |

**content block 类型**（`message.content` 数组元素）：
`input_text`（user 真实输入，text 含注入 + `<user_query>`）/ `image_blob_ref`（user 图片附件，按
`blob_path`/`mime`/`original_filename` 还原为 data URL 图片）/ `output_text`（assistant 正文）/
`reasoning_text`（assistant 思考 → thinking）/ `tool_use`（assistant 工具调用）/ `tool_result`（user 工具结果）。

**用户输入提取**（`extractUserPrompt`）：`input_text.text` 里 `<user_query>…</user_query>` 之间的内容才是
用户真正输入。若 input_text 只有 `<system-reminder data-role="user-context">` 注入而无 `<user_query>` 标签，
该 turn 会显示注入上下文而非用户输入 —— 这是 WorkBuddy 特有的升级信号。

**TodoList**：`function_call_result.output` 里 `_meta.rawResponse.todos` 或 `_meta.rawResponse.task`
→ 归一化为 TodoList tool（`normalizeWorkbuddyTodoItems`）。本地真实存在 todo（transcript 里 `"type":"todo"`）。

**实时链路（normalizeMessage 支持，历史 transcript 通常不出现）**：`system` + `task_*` 事件
（task_notification 卡片，`normalizeTaskEvent`）、`system` + `init`。历史文件里出现 `system` 是罕见情况。

## 项目读取位置

- `workbuddy-sessions.provider.ts` → `normalizeMessage(raw, sessionId)`：
  1. `normalizeTaskEvent`：`type==='system'` + `subtype.startsWith('task_')` → task_notification
  2. `type==='function_call'`（有 `name`）→ tool_use（toolId 取 callId 或 id）
  3. `type==='function_call_result'` → tool_result（`callId`/`status`/`output`）
  4. `assistant` / `user` 事件：content 数组里 `thinking`/`text`/`tool_use`/`tool_result` block
  5. 其他 → `[]`
- `workbuddy-sessions.provider.ts` → `readTranscript()`（历史主链路）：
  - `type!=='message'` → 交给 normalizeMessage（function_call 等）
  - `type==='message'`：`role==='user'` 取 `input_text`（`extractUserPrompt` 提取 `<user_query>`）+
    `image_blob_ref`（读取 blob 文件还原图片）+ `tool_result`；
    `role==='assistant'` 取 `reasoning_text`（thinking）/`output_text`（text）/`tool_use`
  - 坏行 `JSON.parse` 失败跳过；`ai-title`/`file-history-snapshot`/`reasoning` 被跳过
- `workbuddy-session-synchronizer.provider.ts`：sessionId 取文件名；cwd 从 message 事件顶层取；
  跳过 `subagents/`、`tool-results/` 目录；跳过 transient workspace；会话名 `ai-title` → 兜底第一个
  user 的 `input_text`（`<user_query>` 提取）。

## Workflow

1. 确认本次针对 WorkBuddy / CodeBuddy（CodeX 用 `codex-compat-check`，Claude 用 `claude-compat-check`）。
2. 运行检查脚本（在仓库根目录）：

```bash
node .claude/skills/workbuddy-compat-check/check-workbuddy-format.mjs          # 最新会话
node .claude/skills/workbuddy-compat-check/check-workbuddy-format.mjs --all    # 最近 5 个
node .claude/skills/workbuddy-compat-check/check-workbuddy-format.mjs <路径>    # 指定会话
```

3. 解读报告：
   - 顶层 type 标 `需评估` → 新 type，确认它是否被 normalizeMessage / readTranscript 处理。
   - content block 标 `需评估` → 新 block 类型（input_text/output_text/reasoning_text/tool_use/tool_result 之外）。
   - `用户输入提取 ⚠️` → `<user_query>` 标签结构变化，历史会显示注入上下文，**这是 WorkBuddy 最关键的信号**。
   - `事件字段或 system subtype 变化 ⚠️` → function_call 缺 name/callId、function_call_result 缺 status、system 未知 subtype。
   - `已评估` / `已适配` → 已知无影响，忽略。
   - 空文件 / transient workspace / 子代理文件 → 同步器本就不索引，跳过后续对照。
4. 若发现真实变化：按「适配指引」改 `readTranscript` / `normalizeMessage` / `extractUserPrompt`，加单测验证。
5. 把新确认的类型更新进本 SKILL.md 的「格式基线」，并同步脚本的 KNOWN_* 常量。

## 适配指引（参考现有读取模式）

1. **新顶层 type**：判断它出现在历史还是仅实时。历史 → 在 `readTranscript` 的非 message 分支补处理；
   若 normalizeMessage 已有分支（如 function_call）则确认字段映射。
2. **新 content block 类型**：确认字段（`part.text`? `part.name`+`part.input`?），在 `readTranscript`
   对应 role 分支加 `else if (record.type === '...')`，前端 `normalizedToChatMessages` 补渲染。
3. **`<user_query>` 提取失效**：改 `extractUserPrompt`（和同步器的 `extractSessionName` 两处同逻辑），
   让标签结构变化后仍能提取真实输入；提取不到时兜底原样返回。
4. **function_call / function_call_result 字段改名**：改 `normalizeMessage` 的字段读取
   （`name`/`callId`/`arguments`、`callId`/`status`/`output`）。
5. **system 新 subtype**：以 `task_` 开头则确认 `normalizeTaskEvent` 的字段映射；其他 subtype 加进
   `KNOWN_NOT_READ_TYPES` 记录即可。
6. 测试：在 `server/modules/providers/tests/workbuddy-sessions.test.ts` 加用例（构造新格式 transcript，
   `fetchHistory` 断言 normalize 结果）；`npm run typecheck && npm test` 全绿后再收工。
7. **保留既有分支** —— 老 transcript 仍是旧格式，移除旧分支会导致历史会话回归。

## 相关资产

- 真实样例：`~/.workbuddy/projects/Users-selier-dotfiles/9e2a982b-….jsonl`（228 行，含
  function_call/function_call_result/reasoning/ai-title，10/10 `<user_query>` 提取成功）。
- 代码基线：`workbuddy-sessions.provider.ts` 的 `normalizeMessage`（line 347+）/ `readTranscript`（line 483+）/
  `extractUserPrompt`（line 54+）；`workbuddy-storage.provider.ts` 的 `getWorkbuddySessionRoots`。
