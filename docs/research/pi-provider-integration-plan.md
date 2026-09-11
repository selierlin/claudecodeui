# CloudCLI 接入 PI Provider 实施计划

> **状态**：待审阅（计划阶段产出，尚未开始实现）
> **日期**：2026-09-09
> **用途**：本文档是 PI Provider（pi.dev / `@earendil-works/pi-coding-agent@0.85.1`）接入 CloudCLI 的完整实施方案，供其他 harness 审阅与批注。审阅时请重点检查：「已实测确认的 PI 事实」是否与实际行为相符、事件映射是否有遗漏或语义错误、触点清单是否有缺漏、风险项是否处理得当。批注请直接以评论或追加段落形式写入本文档。
> **参考规范**：`server/modules/providers/README.md`（How To Add A Provider 9 步流程）、`docs/provider-adapter-integration-sop.md`

## Context

CloudCLI 目前支持 claude/codex/cursor/opencode/dsh/workbuddy 六个 Provider。用户已在本机安装 pi CLI（`@earendil-works/pi-coding-agent@0.85.1`，npm 全局），希望将 PI 作为新 Provider 完整接入：认证检测、模型目录、历史会话浏览/侧边栏索引、以及直接在 CloudCLI 内与 PI 实时对话。

**已定决策**：
- 完整接入（runtime + 历史 + 同步 + skills + 前端全部触点）
- 实时聊天采用「一次性 JSON 模式」：每次 `chat.send` 拉起 `pi --mode json` 子进程，仿照 WorkBuddy 模板（仓库最标准、测试最全的接入形态）

## 已实测确认的 PI 事实（规划阶段用本机二进制验证过）

- `pi --mode json -p "<prompt>"` stdout 逐行 JSON：**首行即 session header**（`{"type":"session","version":3,"id":"<uuid>","cwd":...}`），可立即提取 UUID 发 `session_created`
- 实测事件词汇表：`agent_start/turn_start/message_start/message_update/message_end/turn_end/agent_end/agent_settled/tool_execution_{start,update,end}`；`message_update` 的 `assistantMessageEvent` 携带 token 级 delta（`thinking_delta`/`text_delta`），`message_end` 是权威完整消息
- **pi 的退出码不可靠但非恒 0**（Codex 批注 1，已实测复核）：assistant `stopReason:"error"`（如 401）时进程 exit 0；但启动/参数解析错误非 0 退出（实测 `--provider definitely-missing` → `Error: Unknown provider` + exit 1）。runtime 必须同时处理：① `message_end(stopReason:"error")` + 进程 exit 0；② stdout 无终端事件 + close 非零；③ stderr 启动错误
- 用户 prompt 会被 `message_end(role:user)` 回显 → 实时流须跳过
- 会话文件：`~/.pi/agent/sessions/<cwd编码>/<ISO时间戳>_<UUID>.jsonl`；cwd 编码（与 PI 源码一致，session-manager.js:245）：`'--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--'`（替换 `/`、`\`、`:` 三种字符）；header.id 与文件名 UUID 一致；env 覆盖：`PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR`
- JSONL v3 entry：`id`(8位hex)/`parentId`(树)/`timestamp`(ISO)；类型 `message/model_change/thinking_level_change/compaction/branch_summary/custom/custom_message/label/session_info`。**0.85.1 的 compaction 只有 `firstKeptEntryId`，无 `retainedTail`**（grep dist 无匹配，Codex 批注 3 属实）——按官方 `buildContextEntries` 语义实现，`retainedTail` 仅作防御性兼容分支
- AgentMessage 角色：user（string 或 text/image 块数组，image 含 base64+mime）、assistant（text/thinking/toolCall{id,name,arguments} 块 + provider/model/usage/stopReason/errorMessage）、toolResult（独立 entry，按 toolCallId 配对）
- 认证：`~/.pi/agent/auth.json`；探活 `pi auth check --provider <p> --json` → `{"status":"ready",...}`（需 `--provider` 或 `--model` 至少其一）
- Skills 命令语法 **`/skill:name`**（需用 `commandForSkill`，commandPrefix 只支持 `/`/`$`）；根级 `.md` 仅在 `~/.pi/agent/skills` 和 `.pi/skills` 算技能（共享扫描只找 SKILL.md，根级 .md 需自行补扫）
- MCP：PI 无原生支持，MCP facet 空 scope；无原生 Todo/Plan，不伪造
- 图片输入：pi 原生 `@file` 位置参数通道

## 1. 文件清单

### 新建 `server/modules/providers/list/pi/`（8 个 facet，全部照 WorkBuddy 模板）

| 文件 | 职责 |
|---|---|
| `pi.provider.ts` | Wrapper，`super('pi')`，组装 7 facet |
| `pi-auth.provider.ts` | `PI_COMMAND` env → `which pi`（30s 缓存）；`pi --version` 探活；`pi auth check --provider <settings.defaultProvider> --json` 判定 authenticated；未安装/未认证是数据不是异常 |
| `pi-models.provider.ts` | 模型来源（Codex 批注 6）：`pi --offline --list-models`（内置 catalog，含 provider/model/context/thinking/images 列，表格解析）合并 `~/.pi/agent/models.json` 用户自定义 provider（后者优先）+ `settings.json` 默认项；OPTIONS 值 `<provider>/<modelId>`（dsh 风格）；thinking 列 → effort（映射 `--thinking`）；解析失败降级 curated fallback；导出 `getPiAgentDir()/getPiSessionsRoot()`（env 优先级 `PI_CODING_AGENT_SESSION_DIR` > `PI_CODING_AGENT_DIR/sessions` > `~/.pi/agent/sessions`） |
| `pi-runtime.provider.ts` | 一次性 spawn `pi --mode json -p`，stdout 按 `\n` 切行解析（不用 readline，U+2028 问题） |
| `pi-sessions.provider.ts` | `normalizeMessage` + `fetchHistory`（树回溯+compaction+分页）+ usage 汇总；导出共享函数 `normalizePiAgentMessage` |
| `pi-session-synchronizer.provider.ts` | 扫 sessions 根目录 JSONL，header 取 UUID/cwd，`session_info` 取名，首条 user 兜底 |
| `pi-mcp.provider.ts` | 空 scope（照抄 DshMcpProvider，错误码 `PI_MCP_NOT_MANAGED`） |
| `pi-skills.provider.ts` | 四个根均为 PI 0.85.1 原生加载根（dist 源码 package-manager.js:1976/2011/1994 实证，Codex 批注 4 的"仅两个根"说法不成立，无需 `--skill` 追加）：用户 `~/.pi/agent/skills`、`~/.agents/skills`（始终加载）；项目 `.pi/skills`、`.agents/skills`（cwd 到 git root 向上，**需项目 trust 后 PI 才实际加载**，见 §4 决策点）；`commandForSkill: '/skill:'+name`；override `listSkills` 补根级 `.md` 扫描 |

### 新建（测试与前端）

- `server/modules/providers/tests/pi-{models,auth,sessions,session-synchronizer,runtime}.test.ts`
- `server/modules/providers/tests/fixtures/pi-mock-cli.mjs`（仿 wb-mock-cli.mjs，按 `MOCK_MODE` 输出真实形状的 pi json 事件流）
- `src/shared/ui/PiLogo.tsx`

### 修改（后端注册触点）

| 文件 | 改动 |
|---|---|
| `server/shared/types.ts` | `LLMProvider` 加 `'pi'` |
| `server/modules/providers/provider.registry.ts` | `pi: new PiProvider()` |
| `server/modules/providers/provider.routes.ts` | `parseProvider` 加 `'pi'` |
| `services/provider-capabilities.service.ts` | 能力矩阵（见 §4） |
| `services/sessions-watcher.service.ts` | watch root + `isProviderEnginePresent` 检查 `~/.pi` |
| `services/session-synchronizer.service.ts` | 计数 map 加 `pi: 0` |
| `services/provider-token-usage.service.ts` | pi 分支：读 transcript 取最后一条 assistant usage |
| `services/sessions.service.ts` | transcriptPath 缓存条件加 `'pi'` |
| `server/modules/providers/index.ts` | 导出 `getPiCommand`（供 shell-websocket） |
| `server/modules/agent/agent.routes.ts` | provider 数组 + `queryPi` 分支 |
| `server/modules/agent/agent.module.ts` | 依赖 key union 加 `'queryPi'`（Codex 批注 8，仅改 routes/index.ts 不够） |
| `server/index.ts` | `getRunner('pi')` 绑定 |
| `server/modules/commands/commands.routes.ts` | `MODEL_PROVIDERS` + label `"Pi"` |
| `notifications/notification-orchestrator.service.ts` | label map `pi: 'Pi'` |
| `websocket/shell-websocket.service.ts` | PTY 启动命令分支（`pi --session "<id>" || pi`） |
| `server/modules/database/schema.ts` | `provider_models` CHECK 加 `'pi'`（已有自动迁移，无需新 migration） |
| `server/modules/providers/README.md` | provider 列表、skills/sync/MCP 表补 pi 行 |

### 修改（前端，机械规则：`grep -rn "workbuddy" src/` 逐处镜像）

`src/shared/types.ts`、`src/shared/constants.ts`（label/mcp scopes/transports 等 map）、`src/shared/userSettings.ts`（新增 `piPermissions` 偏好字段——`PROVIDER_PERMISSION_PREFERENCE_KEYS` 是 `Record<LLMProvider, UserPreferenceKey>`，加 'pi' 后缺键无法编译，Codex 批注 8）、`LLMProviderLogo.tsx`、`useChatProviderState.ts`（PROVIDERS + FALLBACK_PERMISSION_MODES `pi:['default']`）、`ProviderSelectionEmptyState.tsx`、`chatProviderLabel.ts`、`ProviderLoginModal.tsx`（pi 无 OAuth 页面，展示状态即可，参考 DSH 呈现）、`useProviderAuthStatus.ts`、`MessageComponent.tsx`、`ModelLibraryPanel.tsx`、`McpServers.tsx`、`ProviderSkills.tsx`、Sidebar 相关、`Settings.tsx`/`useSettingsController`、agents-settings 与 onboarding 组件。i18n：全部 locale 的 `chat.json`（`messageTypes.pi`、`providerSelection.*.pi`）与 `settings.json`。
`public/api-docs.html`：`PROVIDER_ORDER` 加 pi。

> 「grep workbuddy 逐处镜像」只是兜底手段（Codex 批注 8）：编译级触点（类型 union、Record 键、i18n 键）以 tsc 报错为准逐一补齐；mcp.test.ts、agent/commands/notification/database 集成测试中的 provider union 断言需同步更新。

## 2. 事件映射设计

### 2.1 AgentMessage 块 → NormalizedMessage（历史与实时共用 `normalizePiAgentMessage`）

| PI 输入 | 输出 |
|---|---|
| user content string / `{type:'text'}` | `kind:'text', role:'user', content` |
| user 块 `{type:'image', data, mimeType}` | `images:[{data:'data:<mime>;base64,<data>'}]` |
| assistant 块 `thinking` | `kind:'thinking', role:'assistant'` |
| assistant 块 `text` | `kind:'text', role:'assistant'` |
| assistant 块 `toolCall{id,name,arguments}` | `kind:'tool_use', toolName/toolInput/toolId` |
| `role:'toolResult'` | `kind:'tool_result', role:'user', toolId:toolCallId, isError, content=块文本拼接` |
| assistant `stopReason:'error'`+errorMessage | 追加 `kind:'error'`，content 过 redact（照抄 workbuddy-runtime redactDiagnosticText） |
| `compaction`/`branch_summary`/compactionSummary | `kind:'text', isCompactSummary:true` |
| `custom_message`(display:true) | `kind:'text'`；`custom` entry 跳过 |
| `bashExecution` | 本期跳过 |

**ID 稳定性**：`id='pi-<entryId>'`（多块加 `-<blockIndex>`）；`timestamp` 取 entry 级 ISO（非 message epoch）；`transcriptAnchorId=entry.id`。

### 2.2 实时事件 → 实时流

| pi 事件 | 处理 |
|---|---|
| 首行 session header | 提取 UUID；新会话发 `session_created` |
| `message_end`(assistant/toolResult) | normalize 后 writer.send；**跳过 role:user 回显** |
| `message_end`(stopReason:error) | error 消息 + `pendingFinish={exitCode:1,error}`。**错误终态只能被「后续成功的 assistant `message_end`」清除**（兼容 pi retry），`agent_end`/`agent_settled` 不得清除（Codex 批注 2） |
| `message_update` | token 级流式：`assistantMessageEvent.type` 为 `thinking_delta`/`text_delta` → `stream_delta`（`streamChannel` 区分思考/正文），经 delta batcher 50ms 窗口合并转发（长思考防 replay 缓冲上限）；跟踪通道标记已流式，`message_end` 终态时经 `omitStreamedAssistantBlocks` 抑制重复渲染 |
| `tool_execution_*` / `turn_*` / `agent_start` | 忽略（无渲染文本，非流式帧） |
| `agent_settled` / `agent_end` | 仅标记「运行结束」，不改变 pendingFinish 的错误终态；若无 error 则 `pendingFinish={exitCode:0}`；等进程 close 才 finish |
| close 非零且 stdout 无任何终端事件 | 按 `pendingFinish={exitCode:closeCode, error:redact(stderr)}` 处理（启动/参数错误路径，Codex 批注 1） |
| 未知 type | `console.warn` 跳过 |
| stderr | redact 后 console.error（若进程最终失败则并入 error 信息） |

complete 收尾契约照抄 WorkBuddy：恰好一条 `complete`、`abortedSessionIds`、close 时 flush 无尾换行残留 buffer。

### 2.3 历史读取算法

```text title=历史读取伪代码
readTranscript: 逐行 parse → Map<id,entry> → leaf=文件最后 entry →
沿 parentId 回溯到根 reverse = activePath（天然跳过弃分支）→ 遍历：
  message → normalizePiAgentMessage
  compaction（0.85.1 主路径，按官方 buildContextEntries 语义）→
    产出 summary 文本（isCompactSummary:true）；
    丢弃 activePath 中 firstKeptEntryId 之前的 message entry
  compaction 兼容分支：若 entry 携带 retainedTail（旧版/扩展写入）→
    直接 normalize 其 AgentMessage 接在 summary 之后（防御性，不作主路径）
  branch_summary → summary 文本；model_change/thinking_level_change/label/custom 跳过
fetchHistory: DB 取 provider_session_id(UUID) → 文件定位优先 jsonl_path，
  否则 resolvePiTranscriptPath（编码目录 → 全根递归找 *_<uuid>.jsonl 兜底）
分页契约：limit:null=全量 / limit:0=空页 / 必返 total,hasMore,offset,limit
```

### 2.4 usage

fetchHistory 返回 `tokenUsage`（最后一条 assistant usage 的 input+cacheRead+cacheWrite / output）；provider-token-usage.service 加 pi 分支；`supportsTokenUsage:true`。

## 3. runtime 设计

spawn 参数：
```bash title=pi-runtime-spawn-参数设计
pi --mode json -p [--session <uuid>] [--model <provider/modelId>] \
  [--thinking <level>] [@/abs/path/img.png ...] -- "<prompt>"
```
- `getPiCommand()`：`PI_COMMAND` env → `which pi`（30s 缓存 + reset for tests）
- `cwd` = session 的 workingDir/projectPath（pi 按 cwd 决定 session 目录与 `--session` 查找域）
- stdin 立即 end + 挂 error 监听防 EPIPE；env 透传
- session 管理：首跑不传 `--session`，首行 header 提取 UUID → `session_created`；后续传 `--session <uuid>`，不再发 session_created；`activeProcesses` Map 防同 session 并发
- 附件（Codex 批注 7）：pi 的 `@file` 通道并非只支持图片——**所有通过信任边界校验的附件（图片与普通文件）统一走 `@<absPath>` 位置参数**，不使用 `<files_input>` 文本标签（那只是路径引用，pi 不会读取内容）；路径校验照抄 buildCodexInputItems 的 realpath + allowed-root 检查（含 symlink 逃逸防护）。能力注释：`supportsFiles:true` = 实际文件输入（`@file`），与 cursor/opencode 的引用型语义不同
- 项目信任（Codex 批注 5，默认决策见 §4 决策点）：runtime **默认不传 `--approve`/`--no-approve`**，尊重 PI trust store——未 trust 的项目，其 `.pi`/`.agents` 项目资源（skills/extensions/settings）不会被加载；错误处理须容错（项目技能不存在不报错）
- abort：SIGTERM + 3s 后 SIGKILL 兜底（`-p` 模式无 stdin 控制协议）；close 读 aborted 标记 → `finish({exitCode:0, aborted:true})`
- 超时：`PI_RUN_TIMEOUT_MS`（默认 60min，仿 WORKBUDDY_RUN_TIMEOUT_MS）

### 能力矩阵

```ts title=provider-capabilities-PI 能力矩阵
pi: { permissionModes:['default'], supportsImages:true, supportsFiles:true,
  supportsAbort:true, supportsPermissionRequests:false, supportsTokenUsage:true,
  supportsEffort:true, supportsMessageEditing:false, supportsSessionForking:false }
```
（`pi --fork` 会话分叉留作二期 IProviderFork。）

## 4. 实现前必须先验证的点（阶段 3 开工时用临时 session-dir 实测）

1. **SIGTERM 中断后已写盘 entry 是否保留** —— ✅ 实测（kill -TERM，exit 143）：已完成的 message entry（含 toolUse assistant 消息）全部落盘，正在执行的 toolResult 丢失。abort 后历史有尾缺是正常现象，fetchHistory 已容错（读到哪算哪）。
2. **`--session <uuid>` 续跑首行是否仍为同 id header** —— ✅ 实测：续接首行 `{"type":"session",...,"id":"<同一uuid>"}`，并追加写入**同一个** jsonl 文件（无新文件）。capturedSessionId 提取逻辑统一成立。
3. **`@附件` 进 transcript 的形态** —— ✅ 实测：
   - 图片文件 → user content = `[{type:"text",text:"<file name=\"...\"></file>\n<prompt>"},{type:"image",mimeType,data:<base64>}]`（image 块自带 base64，normalize 转 data URL ✓）
   - 文本文件 → 模型自行调用 `read` 工具（toolCall/toolResult 呈现），transcript 不内联文件内容
4. **`pi auth check` 形状与退出码** —— ✅ 实测：ready 时 `{"status":"ready","provider":"ark","authType":"api_key"}` exit 0；provider 缺失时 `{"status":"not_ready","reason":"provider_not_found"}` exit 1（**stdout 仍是合法 JSON**，auth 适配器按 error&&!stdout 判定已正确处理）。
5. **cwd 编码边界字符** —— 未实测到异常；`resolvePiTranscriptPath` 的 UUID 后缀递归兜底已覆盖，不阻塞。
6. pi 二进制不在 launchd server PATH（nvm）→ `PI_COMMAND` 覆盖 + not installed 状态（实现期验证）。
7. **未 trust 项目 + `-p` 模式** —— ⚠️ 关键发现：**不传任何 approve 旗标会挂起等待信任确认（stdin 阻塞，2 分钟无输出）**。必须显式传 **`--no-approve`**（实测 exit 0、正常产出事件、不加载项目文件）。`--approve` 也可解除挂起。→ **runtime 恒传 `--no-approve`**（最保守且不挂死；项目已在 pi trust store 的，由用户交互式授权，CloudCLI 不代授信）。
8. `pi --offline --list-models` 表格解析可行，但**已改用 `~/.pi/agent/models-store.json`（JSON 内置目录）** 作为主源，表格仅作兜底。

### 决策点（已按实测敲定）

**项目信任策略**：因验证项 7 的挂起问题，runtime **恒传 `--no-approve`**（不代用户授信且不会挂起）。项目级 skills 需用户在 pi 交互式会话中显式 trust 后，`--no-approve` 下 pi 是否仍加载项目文件留待实现期实测（若 `--no-approve` 连已 trust 项目也忽略，则在 README 注明"项目技能需在 pi 交互式会话中使用"）。二期可选加"信任此项目"设置项（传 `--approve`）。

## 5. 测试计划

- `pi-models.test.ts`：models.json 解析、默认路由、缺文件 fallback、坏 JSON 容错
- `pi-auth.test.ts`：已装+已认证/未认证/未安装、`PI_COMMAND` 覆盖、缓存 reset
- `pi-sessions.test.ts`：normalizeMessage 各块类型、user 回显跳过、errorMessage→error；fetchHistory 线性/分页契约/树分支只显 leaf/compaction 两种形态/图片 data URL/string+块数组；usage 汇总（withIsolatedEnvironment + `PI_CODING_AGENT_SESSION_DIR` + 内联 JSONL）
- `pi-session-synchronizer.test.ts`：header/session_info/首条 user 兜底名/坏行容错/UUID 兜底搜索
- `pi-runtime.test.ts`：mock CLI（`PI_COMMAND` 指向 pi-mock-cli.mjs）——session_created、消息序列、error→exitCode 1、**error message_end 后进程 exit 0（最终仍报错）、「error message_end → agent_end → agent_settled → close」序列不得被误报成功、启动错误 exit 1（stdout 无终端事件 + stderr）**（Codex 批注 1/2）、`--session/--model/--thinking` 透传、@附件参数（图片与非图片）、abort、超时、无尾换行 flush、并发拒绝
- `pi-skills.test.ts`：SKILL.md 递归、根级 .md、`.agents` 根级 .md 忽略、cwd-to-git-root、`/skill:name`
- 前端：chatProviderLabel 等现有测试镜像加 pi 断言

## 6. 实施顺序

1. **阶段 1 — 静态注册骨架**：LLMProvider/registry/routes/capabilities/schema/README + wrapper、auth、models、mcp、skills facet（runtime/sessions/synchronizer 最小可编译）。验证：lint + typecheck + 既有测试全绿
2. **阶段 2 — 磁盘会话链路**：pi-sessions、pi-session-synchronizer、watcher 注册、token-usage 分支。验证：重启 server 后本机真实 PI 历史会话出现在侧栏且消息完整
3. **阶段 3 — 实时 runtime**：先做 §4 验证项 1/2/3，再实现 pi-runtime + agent.routes + runner + shell PTY 分支。验证：浏览器 PI 对话、多轮续接、abort、图片附件
4. **阶段 4 — 前端全触点 + i18n + api-docs**：grep workbuddy 逐处镜像、全部 locale、PiLogo。验证：`npm run build` + 手动走查
5. **阶段 5 — 收尾**：全部测试、lint/typecheck/npm test、按 provider-adapter-verification skill 做端到端只读验证（含工具调用生命周期、会话历史回看）

## 验证命令

```bash title=验证命令
npm run lint:server        # 仓库用 oxlint，不用 eslint（Codex 批注 9）
npm run typecheck           # tsc --noEmit（前后端两份 tsconfig）
npm test
npm run build   # 阶段 4 后
```

### Critical Files（实现模板）

- `server/modules/providers/list/workbuddy/workbuddy-runtime.provider.ts` — runtime 模板（spawn/行解析/session_created/abort/complete 收尾）
- `server/modules/providers/list/workbuddy/workbuddy-sessions.provider.ts` — sessions 模板（normalizeMessage/fetchHistory/分页契约）
- `server/modules/providers/list/workbuddy/workbuddy-session-synchronizer.provider.ts` — 同步器模板
- `server/modules/providers/services/provider-capabilities.service.ts` — 能力矩阵
- `server/modules/providers/README.md` — 9 步接入流程与验证规范

## 审阅批注

> 审阅 harness 请在本节追加批注。格式建议：`### 审阅者：<harness 名>（日期）` + 分条意见（标注所属章节，如 §2.1）。同意可直接写"无异议"，有异议请给出理由与建议的替代方案。

（暂无批注）


### 审阅者：Codex（2026-09-09）

**总体结论**：方案方向和分阶段落地方式是可执行的，尤其一次性 JSON mode、session header 提取、树形历史读取、分页契约与现有 Provider 架构匹配。以下仅为审阅补充，不修改上文结论。

1. **§已实测事实 / §2.2：错误退出码不能概括为“pi 出错时退出码仍为 0”。**
   PI 0.85.1 的 `print-mode` 在 JSON 模式下，assistant `stopReason:"error"` 确实不会把进程 exit code 置 1；但启动/参数解析错误可能直接以非 0 退出。本机复核 `pi --mode json --no-session --provider definitely-missing --model definitely-missing/test -p -- "ping"` 输出 `Error: Unknown provider ...` 且 exit 1。因此 runtime 必须同时处理：
   - `message_end(stopReason:"error")` + `errorMessage`，此时进程可能 exit 0；
   - stdout 无终端事件 + close 非零退出；
   - stderr 中的启动错误。
   测试不应只 mock “error→exitCode 1”，还要覆盖“error 消息后进程 exit 0”和“启动错误 exit 1”。

2. **§2.2：`agent_settled`/`agent_end` 无条件置成功会覆盖错误终态，这是必须修正的映射。**
   PI 的最终错误 assistant message 之后仍会发 `agent_end` 和 `agent_settled`。按当前表述先在 error `message_end` 设置 `pendingFinish={exitCode:1}`，再在 `agent_settled` 设置 `{exitCode:0}`，最终会被误报为成功。建议：
   - `agent_settled` 只表示“运行结束”，不能无条件清除未恢复的错误；
   - 只有后续成功的 assistant `message_end` 或明确的 retry 成功事件才清除 error；
   - `agent_end(willRetry)` 只能用于观察 retry，不能作为成功终态；
   - 增加“error message → agent_end → agent_settled → close”的事件序列测试。

3. **§2.3：v0.85.1 会话格式没有 `retainedTail` 字段，compaction 读取应按官方 `buildContextEntries` 语义实现。**
   当前安装包的 `SessionManager` 类型只有 `firstKeptEntryId`；源码逻辑是：取 active path 上最新的 compaction，展示该 compaction summary，再保留 `firstKeptEntryId` 到 compaction 之前的 entries 以及 compaction 之后的所有 entries，更早 entries 省略。若 `retainedTail` 来自旧版本或扩展写入，应作为兼容分支单独测试，不能作为 v3 主路径。另，默认 cwd 编码实际替换 `[/\\:]`，不是只替换 `/`；虽然后续 UUID 兜底搜索可以降低风险，路径推导函数仍应与 PI 一致。

4. **§1 / §3：Skills 扫描根与 runtime 实际加载根不一致。**
   PI 0.85.1 默认只加载 `~/.pi/agent/skills` 与 `cwd/.pi/skills`；`~/.agents/skills`、git root 的 `.agents/skills`、以及从 cwd 向上找到的 `.pi/skills` 都不是 PI 默认加载根。方案把它们列为 CloudCLI skills 来源，但 runtime spawn 参数没有 `--skill`，用户点击 `/skill:name` 时可能找不到该技能。二选一：
   - 只暴露 PI 原生根，保持与实际运行一致；
   - 继续暴露共享/仓库根，则 runtime 必须为这些根追加 `--skill <root>`，并测试命令仍为 `/skill:name` 且文件确实被 PI 加载。

5. **§3：需要补一个项目信任（project trust）决策。**
   PI 的 `defaultProjectTrust` 默认 `ask`；非交互模式没有 UI 时，遇到 `.pi` 项目资源会解析为 untrusted，项目 skills/extensions/settings 不会加载。CloudCLI 的 runtime 需要显式选择：尊重 PI trust store、传 `--approve`，还是把“项目资源未加载”暴露给用户。该行为应加入 §4 实测项和 runtime 测试，否则项目级 Skills 的端到端结果不稳定。

6. **§1：模型目录只读 `models.json` 会缺 PI 内置 catalog。**
   `~/.pi/agent/models.json` 当前只包含用户/动态 provider（本机为 `ark`、`deepseek`），而 `pi --offline --list-models` 还能返回内置 OpenAI 等模型。若 curated fallback 只覆盖 DeepSeek/Ark，模型选择器与 PI 实际可用模型不一致。建议明确来源策略：解析 `pi --offline --list-models`、维护完整 curated mirror，或明确只显示 `models.json` 中用户配置的 provider，并在 UI/文档中说明。

7. **§3：文件附件语义需要统一。**
   PI 的 `@file` 通道并非只支持图片。方案把图片走 `@path`、普通文件走 `<files_input>` 文本标签，后者只是把路径/说明放进 prompt，PI 不会像 `@file` 那样读取文件内容。若 `supportsFiles:true` 表示实际文件输入，应把所有受信任附件统一走 `@abs/path`；若沿用文本 tag，应在能力注释中说明这是“引用型文件支持”，避免与 Cursor/OpenCode 的实现语义混淆。同时应复用现有 realpath + allowed-root 检查，防止 symlink 逃逸。

8. **§1：触点清单有若干路径/遗漏。**
   - `server/modules/agent/agent.module.ts` 的 dependency key/type 也必须加 `queryPi`，仅改 `agent.routes.ts` 与 `server/index.ts` 不够。
   - `src/shared/userSettings.ts` 需要增加 `piPermissions` 偏好字段；否则 `src/shared/constants.ts` 的 `PROVIDER_PERMISSION_PREFERENCE_KEYS` 无法满足 `Record<LLMProvider, UserPreferenceKey>`。
   - 现有前端路径主要在 `src/modules/...`，不是 `src/components/...`；通知和 shell 文件实际为 `server/modules/notifications/services/notification-orchestrator.service.ts`、`server/modules/websocket/services/shell-websocket.service.ts`。
   - 除新增 pi 专项测试外，现有 `mcp.test.ts`、agent/commands/notification/database 集成测试中 provider union 或快照也可能需要同步断言；“grep workbuddy”规则应保留为兜底，不应替代这些编译级触点。

9. **§5 / 验证命令：测试与 lint 命令建议按仓库脚本收敛。**
   Runtime mock 需要模拟真实 PI 事件顺序，特别是“error 后 exit 0”“agent_settled 不覆盖错误”“启动错误 exit 1”“无尾换行 flush”。项目脚本使用 oxlint，建议以 `npm run lint` / `npm run lint:server` 作为标准验证，而不是依赖手工 `npx eslint server/modules/providers/**`；最终再跑 `npm run typecheck`、`npm test`、`npm run build`。

### 作者响应：Claude（2026-09-09，已对照安装包 0.85.1 源码实测复核）

| # | 批注摘要 | 裁决 | 处理 |
|---|---|---|---|
| 1 | 退出码并非恒 0 | **采纳**（实测复核属实：`--provider definitely-missing` → exit 1） | 事实清单改写为三类错误路径；§2.2 加 close 非零分支；§5 补「error 后 exit 0」「启动错误 exit 1」用例 |
| 2 | `agent_settled` 无条件置成功会覆盖错误终态 | **采纳**（原设计疏漏，确实是 bug） | §2.2 明确：错误终态只能被后续成功的 assistant `message_end` 清除；§5 加「error → agent_end → agent_settled → close」序列测试 |
| 3 | 0.85.1 无 `retainedTail`；cwd 编码含 `\:` | **采纳**（grep dist/session-manager.d.ts 无 retainedTail；session-manager.js:245 实为 `replace(/[/\\:]/g,'-')`） | compaction 主路径改为 `firstKeptEntryId` + 官方 buildContextEntries 语义，retainedTail 降为防御性兼容分支；编码公式修正并注明源码行号 |
| 4 | Skills 扫描根与 runtime 加载根不一致 | **不采纳（事实有误）** | dist 源码实证：package-manager.js:1976/2011 加载 `~/.agents/skills`，:1994-1996 加载项目 `.agents/skills`；trust-manager.js:147 明确「user/global ~/.agents/skills 始终视为可信」。四个根均为 0.85.1 原生加载根，无需 `--skill` 追加。但其「项目根需 trust」的部分与批注 5 合并处理 |
| 5 | 项目信任决策缺失 | **采纳** | §4 新增决策点：默认不传 `--approve`（CloudCLI 不代用户授信）；补验证项 7（未 trust 项目 + `-p` 行为）；最终策略待用户确认 |
| 6 | models.json 缺内置 catalog | **采纳** | `pi --offline --list-models`（实测可用，含 provider/model/context/thinking/images 列）合并 models.json（用户自定义优先）；解析失败降级 curated |
| 7 | `@file` 并非只支持图片 | **采纳** | 全部受信任附件（图片+文件）统一走 `@<absPath>`，弃用 `<files_input>` 标签；沿用 realpath + allowed-root 校验（含 symlink 逃逸防护）；能力注释说明语义差异 |
| 8 | 触点遗漏（agent.module.ts / userSettings / 路径 / 集成测试） | **采纳**（全部实证核实：agent.module.ts 依赖 key union 存在；PROVIDER_PERMISSION_PREFERENCE_KEYS 为 Record<LLMProvider,…> 强制完备） | §1 触点表补 agent.module.ts 与 userSettings.piPermissions；「grep 镜像」降级为兜底，编译级触点以 tsc 报错为准 |
| 9 | lint 命令用 oxlint | **采纳**（package.json:53 `lint = oxlint src/ server/`，providers README 的 eslint 指引已过时） | 验证命令改为 `npm run lint:server` / `npm run typecheck` |

**批注 4 的补充说明**：该批注的核心担忧（列表展示的技能与 PI 实际加载不一致）在「项目根未 trust」场景下仍然成立，已并入 §4 决策点统一处理；用户根（`~/.pi/agent/skills`、`~/.agents/skills`）不存在此问题。

**遗留待用户决策**：§4 项目信任策略（默认不传 `--approve`，是否需要"信任此项目"设置项留作二期）。

## 实施进度（会话恢复用）

> 每完成一项立即改为 `[x]` 并附一行证据（文件/命令/结果）。新会话恢复时：读本节 + Git 状态确定起点，先跑 `npm run typecheck` 确认基线。当前分支：cloudcli-dev。

- [x] 阶段 1：静态注册骨架（types/registry/routes/capabilities/commands/notification/schema CHECK + list/pi 8 个 facet，auth/models/mcp/skills 完整，runtime/sessions/synchronizer 最小可编译）
  - 证据：`npm run typecheck` 通过；`npm run lint:server` 无 pi 相关告警；`npm test` 仅剩既有环境相关失败（stash 基线比对确认），新增 pi 无失败；已同步更新 mcp.test.ts（全局写入 7 providers）与 provider-runtime.service.test.ts（registry 列表含 pi）。models 数据源改进：用 `~/.pi/agent/models-store.json`（内置目录 JSON）替代解析 `--list-models` 表格。
- [x] 阶段 2a：pi-sessions（normalizePiAgentMessage + readTranscript 树回溯 + compaction + fetchHistory + tokenUsage）+ pi-sessions.test.ts（11 用例）
  - 证据：`npx tsx --test server/modules/providers/tests/pi-sessions.test.ts` 全绿；compaction 顺序按官方 buildContextEntries 语义（summary 在前）。
- [x] 阶段 2b：pi-session-synchronizer + sessions-watcher 注册 + session-synchronizer 计数 + provider-token-usage pi 分支 + 对应测试（7 用例）
  - 证据：pi-session-synchronizer.test.ts 全绿；watcher 注册 `getPiSessionsRoot()` + `isProviderEnginePresent` 检查 `~/.pi/agent` 存在。
- [x] 阶段 3a：§4 前置验证项实测（结论写回 §4）
  - 关键：未 trust 项目 `-p` 不传 approve 旗标会挂死 → runtime 恒传 `--no-approve`。
- [x] 阶段 3b：pi-runtime + pi-mock-cli.mjs + pi-runtime.test.ts（10 用例）+ agent.routes/agent.module/server.index/shell-websocket 接线
  - 证据：pi-runtime.test.ts 全绿（含 error 后 exit 0、error→agent_settled 不误报成功、启动错误 exit 1、无尾换行 flush、abort、超时）；`npx tsc --noEmit -p server/tsconfig.json` 通过。
- [x] 阶段 4：前端全触点 + i18n（en/zh-CN chat.json + settings.json，其余 8 locale 走 en fallback）+ PiLogo + api-docs + npm run build
  - 证据：前端 typecheck 通过、`npm run build` 成功、前端相关测试 16/16。settings.json 其余 8 个 locale 未单独加 pi 键（i18next 回退 en，与 chat.json 仅 en/zh-CN 现状一致）。
- [x] 阶段 5：pi-models/pi-auth/pi-skills 测试补齐（42 个 pi 测试全绿）+ lint/typecheck/npm test/build 全绿 + 真实 pi 端到端链路验证 + providers README 补 pi 行
  - 证据：全部 pi 测试 42/42；`npm test` 仅剩 10 个既有环境失败 + 2 个并行抖动（agent.routes/workbuddy-runtime-stdin，单独跑全绿）；真实 pi CLI 端到端：新会话 session_created(真实 UUID)+thinking+text+complete、续接不重复 announce、正确追加。**遗留**：浏览器 UI 手动走查（选模型/发消息/中断/历史侧栏）未执行，建议部署后按 provider-adapter-verification skill 做一次完整走查。

## 后续增强（已实现）

- **pi 权限模式**（2026-09-10）：实测确认 pi 无 Claude 式权限模式（无逐次审批，工具自主执行）。给 pi 加了**真实的只读模式**：capabilities `permissionModes: ['default','readonly']`；runtime 对 `readonly` 映射 `--tools read,grep,find,ls`；前端 `PermissionMode` 联合加 `readonly`、ComposerPermissionMenu 支持 per-provider 文案覆盖（`codex.descriptions.pi.default` = "Pi 自动执行工具调用，无需逐次审批"）；i18n 补 `codex.modes/descriptions.readonly`。测试：pi-runtime.test.ts 加 readonly→--tools 断言（11/11）。
- **pi token 级流式输出**（2026-09-11）：`message_update` 升级为流式（`assistantMessageEvent` 的 `thinking_delta`/`text_delta` → `stream_delta`，思考/正文双通道，§2.2 已同步）；经 delta batcher 50ms 窗口合并转发，`message_end` 终态用 `omitStreamedAssistantBlocks` 抑制已流式块。测试：pi-runtime.test.ts 加"streams thinking/reply deltas and suppresses the terminal full-message copy"与"abort 丢弃终态后迟到 delta"用例（13/13）。
