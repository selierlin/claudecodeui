# Claude 思考流式输出方案（消除思考阶段的「无反馈静默」）

> **状态**：**路线 A 已实现并通过手工验收（2026-09-11）**。§8 前置实测已完成，结论已回填 §2.2 / §5-0 / §6-0 / §7-Q5。
> **2026-09-11 二次定案**：Q1 由「路线 B」改判为**路线 A**。动工前复验发现路线 B 的立论前提「思考期间界面无反馈」不成立——指示器在发送瞬间即已点亮，B 为空操作（证据见 §2.4 / §2.5 / §7-Q1 及文末「作者复验追加」）。
> **验收记录**：发送后约 5s（TTFT）开始流式输出思考内容并自动展开；思考结束约 1s 后自动收起，正文接续流式。与 §5-1 口径一致。
> **日期**：2026-09-11
> **用途**：解决 Claude 在 extended thinking 阶段「界面完全无输出、整块思考内容一次弹出」的问题。本文档给出根因认定、两条可选路线与取舍，供其他 harness 审阅与批注。审阅时请重点检查：§2.1 的通道模型是否必要、§2.4 的路线推荐是否成立、§4 的风险是否被低估、§7 的开放问题是否该有明确默认。
> **参考规范**：`docs/architecture/02-realtime-stream.md`（§Text streaming、§Cross-session behaviour）、`.agents/skills/backend-module-standards/SKILL.md`、`.agents/skills/frontend-module-standards/SKILL.md`
> **前置**：文本流式改动已实现——后端 `includePartialMessages` + `stream_event` 拆包 + `message_stop` 边界 + 子代理 partial 过滤；前端按会话键控的流式缓冲 registry（根治路线）。本文只处理「思考」这一条通道，复用上述 registry 链路。
> **证据来源**：真实会话 `82bcea1b-53f7-4f27-ab0d-0e661002ffdc`（本机 `~/.claude/projects/-Users-selier-Projects-open-projects-cloudcli/`），时间是 UTC。

## Context

### 现象与实测时间线

用户在 CloudCLI 里发了一句「给我生成1万字的小说，男主名称是亮仔」，感知是「大概过了十几秒才看到输出」。从 transcript 还原：

| 时刻 | 事件 | 相对上一步 |
|---|---|---|
| 04:24:37.069 | 用户 prompt 落盘 | — |
| 04:24:56.647 | **thinking 块**落盘（1639 字符，一整块） | **静默 19.6s** |
| 04:26:28.977 | **text 块**落盘（3241 字符，第 1–5 章后被打断） | +92.3s |
| 04:26:28.980 | 用户打断 | +0.003s |

两个时间戳不同（`:56` 与 `26:28`），说明思考块是在**思考结束时独立送达**的，不是等打断时才一起刷出。

结论：**用户感知的 19.6 秒静默 = 整个思考阶段的时长**，期间界面没有任何反馈。

### 根因：两处缺口，都在「思考」这条链路上

**① adapter 只认文本 delta**（`claude-sessions.provider.ts:689`）：

```ts
if (raw.type === 'content_block_delta' && raw.delta?.text) {
  return [createNormalizedMessage({ kind: 'stream_delta', ... })];
}
```

思考 delta 的形状是 `{ type: 'thinking_delta', thinking: string, estimated_tokens: number | null }`（`node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts:1837-1849`），**没有 `text` 字段**。因此 `delta?.text` 为 `undefined`，不匹配该分支；后续分支只处理 `role === 'user' | 'assistant'` 的完整消息，也不匹配 → 思考 delta 被**静默丢弃**。

**② runtime 里完全没有 thinking 处理**：`grep thinking claude-runtime.provider.js` 零命中。

所以思考阶段 SDK 一直在吐 `thinking_delta`（`includePartialMessages` 已开），服务端一个字节都没往 UI 送；直到思考结束、完整 thinking 块到达，adapter 才在 `:953-960`（assistant 消息 + 数组内容里的 `thinking` 块）把它映射成 `kind: 'thinking'`，前端**一次性**渲染。

> 注：adapter 另有一处 `:888`（`raw.type === 'thinking'`）也能产出 `kind: 'thinking'`，但全 `server/` 目录**无人构造**该输入形状（见 §4.7.1），Claude SDK 路径上不可达——实时与持久化实际都走 `:953-960`。初版文档把两处并列引用，易让实现者以为实时走 `:888`。

### 一个关键发现：前端组件**已经**支持流式思考，只是从未被喂过数据

`src/modules/chat/transcript/Reasoning.tsx` 是照 ai-elements 的流式范式写的，具备：

| 能力 | 位置 |
|---|---|
| `defaultOpen ?? isStreaming` —— 流式期间自动展开 | `:51` |
| `isStreaming` 时触发 `<Shimmer>Thinking...</Shimmer>` | `:135-138` |
| 记录思考耗时，结束后显示「Thought for N seconds」 | `:78-88`、`:139-142` |
| 流式结束后 1s 自动收起 | `:98-106` |
| `lazyMount` —— 未展开过就不渲染昂贵子节点 | `:190-212` |

但 `MessageComponent.tsx:281` 传的是 `<Reasoning defaultOpen={isExporting}>`，`isExporting` 常规为 `false` → 命中 `isExplicitlyClosed`（`:52`），**自动展开被显式关掉**；且思考行永远不可能是 `isStreaming`（后端从不发流式思考）。

**这改变了本方案的成本判断**：路线 A 的前端增量远小于看起来的样子——组件能力齐备，缺的是「喂数据 + 解除硬性关闭」。

## 1. 目标与范围

**目标**：让思考阶段的等待有可见反馈，把 19.6s 这种静默压到 1~2s 内就有动静。

**范围**：只处理 Claude 的思考通道。不动历史读取、不动 transcript 格式、不动正文流式链路。

**非目标**：不改变模型思考本身耗时——思考该花 20 秒还是 20 秒，本方案只决定这 20 秒里界面显示什么。

## 2. 设计

### 2.1 为什么不能直接把思考 delta 塞进现有 registry

现有 registry 按 `sessionId` 键控，每个会话只有一个 `__streaming_<sid>` 占位行；`stream_end` 把它 finalize 成 `kind: 'text'` 的行（`useSessionStore.ts` 的 `updateStreaming` / `finalizeStreaming`）。

若把 `thinking_delta` 也映射成 `stream_delta` 而不加区分，思考与正文会**拼进同一行**。后果不只是「显示成一坨」：

- 持久化侧 thinking 与 text 是**两条独立行**（adapter `:888` / `:953` → `kind: 'thinking'` / `'text'`）。
- 前端剪除实时行靠 `isAssistantTextEchoedInSameTurnOnServer` 的**精确相等**判据（`useSessionStore.ts:250-252`）。合并行永远不等于任何单条持久化行 → 剪不掉 → 刷新后「合并行 + 两条持久化行」并存。

所以**必须引入通道维度**。三种实现路径：

| 路径 | 做法 | 代价 |
|---|---|---|
| **P1：复用 `stream_delta` + 通道字段** | `NormalizedMessage` 增加可选字段（如 `streamChannel: 'text' \| 'thinking'`），registry 按 `sessionId + channel` 键控 | 不动 `MessageKind` 两个联合；`finalizeStreaming` 需要拿到通道才能定 final kind |
| **P2：新增 kind**（如 `thinking_delta`） | 两个 `MessageKind` 联合各加一项 | 语义最清晰；但要同步服务端/客户端类型、重放与历史路径的忽略逻辑 |
| **P3：两个 registry 实例** | 文本一个、思考一个，各自注入带通道参数的 flush 回调 | 不改键格式；但 `ChatInterface` 要管两个实例，"统一 dropAll"语义略散 |

**倾向 P1**：改动面最小，且 registry 的 `append(sessionId, text, provider)` 只需扩展一个维度；P2 的新 kind 会牵动重放/历史两处无关路径，P3 的收益不足以抵消结构上的松散。

> **但 P1 的「改动面最小」不要低估**：除了键维度，P1 还必须带上**合成思考流式行**的 prune 判据（内容比对，形同 `text`）、id 方案与 dedupe 覆盖，否则该合成行在会话内增量刷新后不会与持久化行合并——详见 §4.7.2。（注意：这只关乎路线 A 新引入的合成行；**现有的非流式 thinking 行靠 id 判据已被正确剪除**，不是存量缺陷。）

### 2.2 `stream_end` 的通道归属（已实测确认：单 `message_stop`）

`stream_end` 目前由 `message_stop` 触发（消息级边界）。问题是：**思考与正文是否在同一个 `message_stop` 下？**

- 若思考与正文属于**同一个 API 响应** → 一个 `message_stop`；
- 若是**两次响应**（本例时间戳差了 92s，倾向这种）→ 两个 `message_stop`。

两种情况下都成立的规则是：**`stream_end` = 收尾该会话当前所有已打开的通道**。

- 单 `message_stop` 场景：一次收尾两个通道 → 思考行与正文行各自 finalize。
- 双 `message_stop` 场景：第一个收尾当时仅打开的思考通道，第二个收尾正文通道。

这条规则让实现不必预先知道时序，但**结论本身是推断，必须先实测**（§5-0，用 §6 的计数器）。若实测发现存在「同一个 `message_stop` 但思考通道未打开」等边界，规则需再收紧。

> **实测已确认（2026-09-11，见 §8，经审阅修正）**：真实形态是**单响应、单 `message_stop`、thinking + text 双内容块**——即上表「单 `message_stop`」分支。因此 §2.2 的结论应当收紧为：**思考与正文共享同一个 `message_stop`，`stream_end` 必须在那一次收尾里同时关闭两个通道**；表中「双 `message_stop`」分支在实测中未出现（原先据 `assistant: 2` 推断为双响应，是误读——`assistant` 计的是 SDK 按块组拆分的 assistant 消息数，不是 API 响应数，证据见 §8.5）。
> 另一处实测反例（第 1 轮整轮无 `stream_end`）已定位为**用户打断**所致，不是稳态缺陷，见 §8.6；其兜底路径已存在于 `complete` 分支。

### 2.3 路线 A：思考内容流式（完整）

把 `thinking_delta` 真正渲染出来，复用 `Reasoning` 的流式能力。

- **后端**：adapter 增加 `content_block_delta` + `delta.type === 'thinking_delta'` 分支 → 带通道标记的流式消息；runtime 的子代理过滤（`isSubagentPartialEvent`）扩展到思考通道。
- **前端**：registry 增加通道维度；`useChatMessages` 的 `stream_delta` 分支按通道产出 `isThinking: true, isStreaming: true` 的行；`MessageComponent` 对「正在流式的思考行」传 `isStreaming` 且不强制 `defaultOpen={false}`，交给 `Reasoning` 自动展开、结束后 1s 收起。

**收益**：静默期变成实时滚动的推理文本；结束后自动收起，不污染阅读。
**成本**：改动横跨后端 adapter / runtime / 类型与前端 registry / store / 渲染，是本方案里最大的一档。

### 2.4 路线 B：思考进度指示（轻量）

不流式思考内容，只给出「它活着」的信号。

- **做法**：收到第一个 `thinking_delta`（或任何 delta）即向前端发一条轻量 `status` 消息；前端把既有的 `ActivityIndicator` / `Shimmer` 点亮，可选显示 `estimated_tokens` 累计。
- **后端**：一个分支。
- **前端**：一个指示器分支，几乎不碰 registry。

**收益**：成本极低，直接消灭「界面像死了一样」的观感。
**代价**：看不到思考内容。

**一个被低估的细节**：思考面板默认是**收起**的（`Reasoning defaultOpen={isExporting}` → false）。也就是说——即使做了路线 A，若不做自动展开，用户看到的仍只是一个折叠标题，静默观感**几乎没有改善**。这使「A 必须配套自动展开」成为硬约束。

**⚠️ 已废弃（2026-09-11 复验）**：B 的立论前提「思考期间界面像死了一样」**不成立**——指示器本就常亮：

| 环节 | 事实 | 位置 |
|---|---|---|
| 发送即点亮 | `chat.send` **之前**调用 `onSessionProcessing(sid, { statusText: null, canInterrupt: true })` | `useChatComposerState.ts:869` |
| 有文案 | `statusText === null` 时自动轮播本地化的「Thinking / Processing / Analyzing / Working …」（走 i18n） | `ActivityIndicator.tsx:70` |
| 不会被误清 | `syncProcessingSessions` 对服务端未上报的条目保留 10s 宽限 | `useSessionProtection.ts:8`、`:129-133` |

此时再补一条「思考块开始 → 发 `status`」，落点与既有条目**逐字段相同**，`markSessionProcessing` 会直接 `return prev`（`useSessionProtection.ts:62-68`），**连一次重渲染都不产生**。故 B 是空操作，Q1 改判路线 A；B 仅保留为 A 落地后「redacted / display=omitted」的降级显示。

### 2.5 取舍与推荐

| | 路线 A（内容流式） | 路线 B（进度指示） |
|---|---|---|
| 静默期观感 | 实时滚动的推理文本 | 进度指示/计时 |
| 后端改动 | adapter + runtime + 类型 | 一个分支 |
| 前端改动 | registry 通道 + store + 渲染 | 一个指示器 |
| 与持久化形态一致 | 是（独立 thinking 行） | 无关（不建行） |
| 主要风险 | 通道模型、replay 压力、渲染量 | 几乎无 |

**~~推荐：先 B~~ → 已改判：走 A（2026-09-11）。** 原推荐基于「B 能消灭静默观感」这一假设，但复验证实该假设的前提不成立（见 §2.4 废弃说明）——指示器本就一直亮着，B 不改变任何可见行为。因此**唯一能改变「看不到内容」的做法是 A**。取舍退化为「A 的成本是否值得」，而答案受 §4.1 约束：**必须配套自动展开**，否则折叠标题同样不产生内容变化。

A 与 B 仍不互斥：B 的指示器保留为「思考内容被 redacted / display=omitted」时的降级显示（此时只有 `estimated_tokens`，没有 `thinking` 文本）。

## 3. 文件清单

### 路线 B（**已废弃**，仅保留为 A 的降级显示）

| 文件 | 改动 | 规模 |
|---|---|---|
| `server/modules/providers/list/claude/claude-sessions.provider.ts` | `content_block_delta` 增加 `thinking_delta` 分支 → 发一条 `status`（沿用现有 kind，携带 `estimated_tokens` 累计） | 约 10 行 |
| `server/modules/providers/list/claude/claude-runtime.provider.js` | 子代理过滤扩展到思考通道 | 约 2 行 |
| 前端指示器消费点 | 复用既有 `status` / `ActivityIndicator` 路径 | 约 10 行 |

### 路线 A（**采用**）

本方案的实际落地范围（B 的 `status` 分支不再作为主体，仅按 §2.5 保留为 redacted/omitted 的降级）：

| 文件 | 改动 |
|---|---|
| `server/shared/types.ts` + `src/shared/types.ts` | 通道字段（P1）或新 kind（P2） |
| `claude-runtime.provider.js` | 子代理过滤覆盖思考通道；通道随消息传递 |
| `src/modules/chat/utils/streamingBufferRegistry.ts` | 通道维度（键或实例） |
| `src/modules/chat/hooks/useSessionStore.ts` | `updateStreaming` / `finalizeStreaming` 支持按通道定 final kind；**合成的思考流式行需自带 prune 判据（内容比对，形同 `text`）+ id 方案 + dedupe 覆盖**（见 §4.7.2，缺了 §5-3 必失败） |
| `src/modules/chat/hooks/useChatRealtimeHandlers.ts` | 三消费点按通道路由 |
| `src/modules/chat/hooks/useChatMessages.ts` | 流式思考行 → `isThinking: true, isStreaming: true` |
| `src/modules/chat/transcript/MessageComponent.tsx` | 流式思考行传 `isStreaming`，解除 `defaultOpen={false}` |

### 新建测试

| 文件 | 覆盖 |
|---|---|
| `server/modules/providers/tests/claude-thinking-stream.test.ts` | `thinking_delta` 被映射（B：status；A：带通道的流式消息）；`text_delta` 不受影响；子代理思考 delta 被丢弃；`estimated_tokens` 为 null 时不崩 |
| `src/modules/chat/tests/thinkingStreamScope.test.tsx`（A） | 思考与正文落成两行不合并；`stream_end` 收尾两个通道；刷新后不重复 |

## 4. 风险

### 4.1 折叠面板让 A 的收益落空（高，A 已采用 → 必须处理）

见 §2.4。A 必须配套「流式期间自动展开」，否则等于没做。这是 A 落地时最容易漏掉的一步。

### 4.2 replay 缓冲压力比正文更甚（中高）

思考 delta 同样是一条带 `seq` 的实时帧，也走 replay 缓冲（5000 事件/run，完成后保留 5 分钟）。思考通常与正文**同量级甚至更长**，两者叠加会让帧数翻倍。这与 `claude-streaming-root-fix-plan.md` §4.3 是同一个问题，**且本方案会让它更严重**。若采纳服务端 delta 合并，应把思考通道一并纳入。

### 4.3 渲染量（中）

本例思考 1639 字符、正文 3241 字符（被打断前），但比例随任务波动；thinking 的 token 速率与 text 同量级。10/s 的合并窗口（`streamingBufferRegistry.ts:7`）对两条通道各自生效，后台会话写频从 10/s 变成 20/s。仍在有界范围，但需在验收里观察长思考 + 长正文并发的表现。

### 4.4 与 `showThinking` 偏好的交互（中，需决策）

用户关闭「显示思考」时（`src/shared/uiPreferences.ts:28`，默认 true 但可关），`MessageComponent.tsx:87` 会整行 `return null`。那么：

- 路线 A 的流式思考行也应隐藏——但此时用户又回到静默，需要 B 的指示器兜底（而指示器是否也该被该偏好关掉？）。
- 建议：**指示器不受 `showThinking` 控制**（它不泄露内容），仅内容行受控。列为 §7-Q4。

### 4.5 redacted / omitted thinking（低中）

SDK 存在 `BetaRedactedThinkingBlock`，且 `estimated_tokens` 的注释明确说明它只在 `thinking.display === 'omitted'` 时有值（`messages.d.ts:1839-1848`）。即存在**没有思考文本、只有 token 估算**的形态。路线 B 天然覆盖；路线 A 需要降级处理（只显示进度、无内容），否则会渲染空行。

### 4.6 子代理思考通道必须一并过滤（中）

现有 `isSubagentPartialEvent` 只拦 `stream_delta` / `stream_end`（定义 `claude-runtime.provider.js:446`，调用 `:1089`）。新增思考通道后若漏拦，子代理的思考会串进主线程——与当初文本流式踩过的坑同型，且更隐蔽（思考行是折叠的，不易肉眼发现）。

### 4.7 路线 A 的 thinking 流式行需要自带 prune / dedupe 判据（**仅路线 A**，非存量缺陷）

> ⚠️ **本节初版结论错误，已推翻重写。** 初版据审阅意见认定「**今天**的非流式 thinking 行在会话内增量刷新后就会双份，属存量缺陷」。该认定**经实测证伪**——否则会凭空引入一项不必要的修复。**路线 B 完全不受本节影响。**

#### 4.7.1 为什么「今天就会双份」不成立（探针实测）

审阅意见的推理链建立在「实时 SDK 消息无 `uuid`」上，该前提不成立：

| 声称 | 实际 | 证据 |
|---|---|---|
| 实时 SDK 消息无 `uuid` → id 随机 | **`SDKAssistantMessage.uuid` 为必填**，`SDKPartialAssistantMessage.uuid` 亦为必填 | `sdk.d.ts:2646`、`:3423` |
| `transformMessage` 会丢掉 uuid | 原样透传（无 `parent_tool_use_id` 时直接 `return sdkMessage`） | `claude-runtime.provider.js:393-419` |
| 实时走 `:888` 产出无后缀 id | 实时与持久化**走同一分支** `:953-960`（`assistant` + 数组内容），id 同为 `${baseId}_${partIndex}`，`baseId = raw.uuid` | `claude-sessions.provider.ts:701`、`:955` |
| `:888` 是实时路径 | 全 `server/` 目录**无人构造** `{type:'thinking'}`（仅测试与其他 provider 出现）→ Claude SDK 路径上该分支不可达 | `grep -rn "type: 'thinking'" server/` |
| —— | 代码库自身依赖「实时 uuid == transcript uuid」（`raw.uuid` 被当作编辑/分叉锚点） | `claude-sessions.provider.ts:654-658` |

**直接探针**（把同一形状分别按「实时」与「持久化」喂给 adapter）：

```
live/thinking-only      → [{"k":"thinking","id":"UUID-A_0"}]
persisted/thinking-only → [{"k":"thinking","id":"UUID-A_0"}]   ← 两侧 id 完全相同
both-blocks             → [{"k":"thinking","id":"UUID-B_0"},{"k":"text","id":"UUID-B_1"}]
```

真实 transcript 也印证形态：thinking 块各自独占一条 `assistant` 行（`blocks=['thinking']`），自带 uuid。

而 `pruneRealtimeSupersededByServer` 的**第一道判据**正是 `serverIds.has(message.id)`（`useSessionStore.ts:310-312`），位于所有 kind 分支**之前**——id 相同即被剪除，**根本走不到 `return true` 兜底**。故今天的 thinking 行不会双份。

**顺带澄清一个设计事实**：prune 是「三种判据并存」——`text` 靠**内容比对**、`tool_use` 靠 `toolId`、而 thinking 与 tool_result 靠**id 相等**。所以「thinking 没有 kind 分支」不等于「thinking 被漏掉」，它的判据是 id。

#### 4.7.2 路线 A 为什么仍然要做（本节保留的结论）

路线 A 会引入**合成的流式占位行**（如 `__streaming_thinking_<sid>`），`finalizeStreaming` 随后把它换成 `text_<ts>_<rand>` 这类**新 id**（`useSessionStore.ts:836-841`）——它与持久化的 `${uuid}_${partIndex}` **永远不相等**，此时：

1. `serverIds` 判据失效；
2. `kind: 'thinking'` 无 kind 分支 → 落到 `return true` → 保留；
3. `dedupeAdjacentAssistantEchoes` 也不覆盖 thinking 相邻对。

**于此时才会真的双份**（且只在会话内增量刷新时；硬刷页 `realtimeMessages` 为空，prune 在 `:302-304` 提前返回，不会双份）。

**因此 §3 路线 A 的要求保留，但理由更正为**：合成的流式思考行需要**自己的**剪除判据（形同 `text` 的内容比对），并需要自带 id 方案；`finalizeStreaming` 还需按通道决定 final kind（否则思考行会被最终化成 `text`）。这与「修复存量缺陷」是两件事。

## 5. 验收

| # | 场景 | 期望 |
|---|---|---|
| 0 | **前置实测**（§6 计数器） | ✅ **已完成，见 §8**：**单 `message_stop` 覆盖 thinking+text 双通道**已确认；思考块 delta 数实测 **53 ~ 9177**（跨 run 波动 2 个数量级）；`stream_end` 缺失反例已定位为用户打断 |
| 1 | 长思考任务（1 万字小说这类） | **自首个思考 delta 起** ≤ 2s 出现**流式思考内容**（面板自动展开；§8.4 口径：不含不可控的 TTFT ≈5.4s），不再有 19s 级静默 |
| 2 | 思考结束 | 思考块收起，正文开始流式，两者互不干扰 |
| 3 | 思考 + 正文并存 | **两条独立行**，不合并；刷新后无重复行（A） |
| 4 | 思考期间 abort | 无残留流式行，busy 态清除 |
| 5 | `showThinking = false` | 内容行隐藏；指示器行为符合 Q4 决策 |
| 6 | redacted / display=omitted | 只显示进度，不渲染空内容行 |
| 7 | 子代理任务 | 子代理思考不混入主线程 |
| 8 | 开关关闭 | 完全回退到当前行为（思考整块弹出） |
| 9 | 移动端长思考 + 长正文 | 无卡顿、滚动跟随正常 |

## 6. 实施顺序

0. ✅ **实测工具已落地并取数**：runtime 加了环境变量门控的流式计数器——`CLAUDE_STREAM_DEBUG=1` 启动时，每轮 run 结束打印一行 `[claude-stream-debug]`，含 `textDeltas` / `thinkingDeltas`（SDK 侧计数）、`kinds`（归一化后各 kind 数）、`subagentDrops`、`maxGapMs`（最大相邻 delta 间隔）、`deltaSpanMs`、`sdkTypes`。已在 `474d80d1-8efd-4dc6-bd16-0da5dcf7c3b9`（2 run，其一被打断）与 `35ebea43-59dd-4b32-ac13-22ea13081fca`（2 run，agentic 长任务）共 **4 个 run** 上取得数据，结论见 §8。
> 取数后**建议回滚** `plist` 里的 `CLAUDE_STREAM_DEBUG`（见 §8.8）。若日后还要靠日志判读响应结构，可给计数器补一个 `event.type` 直方图（`message_start` / `content_block_stop` / `message_stop` / `signature_delta` / `input_json_delta` 各计数）——本次「单/双响应」之争本可直接读出，不必靠算术反推。
1. 依实测结果确定通道模型与 `stream_end` 规则（若时序与推断不符，先修订 §2.2 再动手）
2. 路线 A（Q1 已二次定案：走 A，含自动展开；见 §2.3 / §2.5 / §3）
3. 自动化用例 + 手工验收 §5
4. 同步架构文档：`02-realtime-stream.md`（Claude 的流式能力表、`stream_end` 边界描述、跨会话缓冲相关表述须与文本流式的修订并集一次性处理）+ `CHANGELOG.md`

## 7. 开放问题

| # | 问题 | 我的倾向 |
|---|---|---|
| Q1 | 路线 A（思考内容流式）还是 B（进度指示）？ | ✅ **已定案（2026-09-11）**：~~走路线 B~~ → **改判为路线 A**。原定 B 的前提被复验证伪（指示器本就常亮，B 为空操作，见 §2.4/§2.5）；B 降级为 redacted/omitted 的 fallback。A 必须配套自动展开（§4.1） |
| Q2 | （A）流式期间自动展开思考面板吗？ | 展开，结束后 1s 自动收起——否则 A 的收益落空（§4.1） |
| Q3 | 通道用什么机制：P1 复用 `stream_delta` + 字段 / P2 新 kind / P3 两个 registry？ | P1 |
| Q4 | 路线 B 的进度指示是否受 `showThinking` 偏好控制？ | 不受控（只显示进度、不泄露内容）；内容行仍受控 |
| Q5 | 思考 delta 是否也纳入服务端合并，以控制 replay 压力？ | 纳入。§8 实测：思考 delta 占总帧数 **58%（242/420）** 与 **3%（53/1600）**，比例随任务剧烈波动——最坏情形（思考主导）下不合并确实会先撞 5000 上限 |
| Q6 | 是否利用 `estimated_tokens` 显示「已思考 ~N tokens」？ | B 里可选增强；数据仅在 display=omitted 时存在，不能作为唯一信号 |

## 8. 前置实测结论（2026-09-11 完成）

> **取数方式**：本机 cloudcli 以 `CLAUDE_STREAM_DEBUG=1` 启动（`cloudclictl install`，开关写入 plist 模板），产生两条会话共 **4 个 run**：
> - `474d80d1-8efd-4dc6-bd16-0da5dcf7c3b9`：发「写 5 千字小说」——**run 1 被用户打断**（非正常结束，见 §8.6），run 2 正常。
> - `35ebea43-59dd-4b32-ac13-22ea13081fca`：agentic 长任务（多工具调用），两个 run 均正常。
>
> **取数位置**：`~/Library/Logs/CloudCLI/cloudcli.out.log` 的 `[claude-stream-debug]` 行（共 4 条）。时间均为 UTC。

### 8.1 原始数据

```
# 第 1 轮
{"sessionId":"474d80d1-8efd-4dc6-bd16-0da5dcf7c3b9","textDeltas":178,"thinkingDeltas":242,
 "subagentDrops":0,"maxGapMs":430,"deltaSpanMs":15622,
 "kinds":{"thinking":1,"stream_delta":178,"text":1},
 "sdkTypes":{"system":244,"stream_event":424,"assistant":2,"user":1,"result":1}}

# 第 2 轮
{"sessionId":"474d80d1-8efd-4dc6-bd16-0da5dcf7c3b9","textDeltas":1547,"thinkingDeltas":53,
 "subagentDrops":0,"maxGapMs":814,"deltaSpanMs":62951,
 "kinds":{"thinking":1,"stream_delta":1547,"text":1,"stream_end":1},
 "sdkTypes":{"system":55,"stream_event":1607,"assistant":2,"result":1}}

# 第 3 轮 —— 会话 35ebea43（agentic，多工具）
{"sessionId":"35ebea43-59dd-4b32-ac13-22ea13081fca","textDeltas":269,"thinkingDeltas":462,
 "subagentDrops":0,"maxGapMs":3496,"deltaSpanMs":38799,
 "kinds":{"thinking":4,"tool_use":3,"stream_end":4,"tool_result":3,"stream_delta":269,"text":3},
 "sdkTypes":{"system":467,"stream_event":841,"assistant":10,"user":3,"result":1}}

# 第 4 轮 —— 会话 35ebea43（超长思考 + 多工具，本组数据里信息量最大的一条）
{"sessionId":"35ebea43-59dd-4b32-ac13-22ea13081fca","textDeltas":317,"thinkingDeltas":9177,
 "subagentDrops":0,"maxGapMs":4618,"deltaSpanMs":462195,
 "kinds":{"thinking":16,"tool_use":19,"stream_end":17,"tool_result":19,"stream_delta":317,"text":7},
 "sdkTypes":{"system":9195,"stream_event":10566,"assistant":42,"user":19,"result":1}}
```

> 第 3、4 轮是首轮取数时遗漏、经审阅指出的数据；其中第 4 轮（`thinkingDeltas: 9177` × `textDeltas: 317`，考虑时长 **462s**）在「思考帧量级」和「响应结构」两个问题上都比前两轮更有价值。

### 8.2 结论一：思考 delta 确实存在，且在服务端被 100% 丢弃（§2 根因，确证）

| 指标 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 第 4 轮 |
|---|---|---|---|---|
| SDK 发出的思考 delta（`thinkingDeltas`） | **242** | **53** | **462** | **9177** |
| 转发的 `stream_delta` 帧数 | 178 | 1547 | 269 | 317 |
| `textDeltas` | 178 | 1547 | 269 | 317 |
| 转发的 `thinking` 完整块数 | 1 | 1 | 4 | 16 |

转发帧数与 `textDeltas` 在**全部 4 个 run 上逐轮精确相等**（178=178、1547=1547、269=269、317=317），即每一帧 `stream_delta` 都源自正文 delta，**思考 delta 转发数恒为 0**；`kinds.thinking` 等于该 run 的思考块数（1/1/4/16），即思考内容只在块结束后被**整块**补发。

> 第 4 轮的量级值得记住：**9177** 帧思考 delta 全部丢弃，`thinking : text` 帧数比达 **29 : 1**。这既是 §4.2 replay 压力的最坏参照，也说明「思考帧数」可以远超正文。

这直接坐实 §2 根因①：`claude-sessions.provider.ts:689` 判据是 `raw.delta?.text`，而思考 delta 形状为 `{type:'thinking_delta', thinking:string}`（无 `text`），分支不匹配后被丢弃。根因②（runtime 无 thinking 处理）不再需要单独论证——即使有，也被 adapter 挡在前面。

### 8.3 结论二：上游没有任何卡顿，「静默」纯属服务端丢弃所致（新证据，§2 现象解释补强）

`maxGapMs` 在前两个 run 上仅 **430ms / 814ms**——相邻 delta 的最大间隔不到 1 秒，SDK 在**同一响应的生成期间**以稳定节奏吐帧。因此「等十几秒」既不是模型慢，也不是网络/传输慢：**服务端在持续收帧的同时一帧都没往 UI 送**，客户端只能空等第一帧正文。

> **口径限定（经审阅补正）**：该结论只适用于「同一响应生成期间」。agentic run（第 3、4 轮）的 `maxGapMs` 为 **3496ms / 4618ms**，对应的是**工具执行/等待区间**——那种停顿是真实的上游空闲，与「思考被丢弃」是两回事。不要把本结论推广成「SDK 永不空闲」。

### 8.4 结论三：静默时长 ≈ 思考 delta 窗口（quantified）

以「delta 均匀分布」估算思考窗口占比，并用 transcript 的块落盘时间交叉验证：

| | 思考 delta 占比 | 估算静默 | transcript 交叉验证 |
|---|---|---|---|
| 第 1 轮 | 242/420 = 58% | ≈ 15.6s × 58% ≈ **9.0s** | 思考 delta 起点反推 ≈04:53:10.9，思考块落盘 04:53:18.887 → ≈**7.9s** ✅ |
| 第 2 轮 | 53/1600 = 3% | ≈ 62.9s × 3% ≈ **2.1s** | 思考块 04:53:48.580、正文块 04:54:49.760（正文 61s） ✅ |

第 2 轮正文占绝对多数，所以「正文一出现就流式正常」的观感成立；第 1 轮思考主导，静默最明显。**静默时长与思考 delta 数量强相关**，这正是路线 A/B 要消灭的量。

**口径补正（经审阅）**：上表算的是「自首个思考 delta 起」的空窗。但用户是从**按下发送**开始计时的——第 1 轮 prompt 落盘 `04:53:05.490`，思考窗口起点反推 ≈`04:53:10.9`，即 **TTFT ≈ 5.4s** 也是用户感知静默的一部分（用户实际感知 ≈ 5.4 + 7.9 ≈ **13.4s**）。**TTFT 不在本方案可控范围内**，所以 §1 / §5-1 的「静默 ≤ 2s」必须注明口径是「自首个思考 delta 起」，否则验收无法判定。

`subagentDrops` 4 个 run 均为 0，说明没有子代理帧干扰，数据干净。

### 8.5 结论四（**已修订**）：单响应、单 `message_stop`、thinking + text 双内容块

> ⚠️ **本节初版结论是错的**，已按审阅意见推翻重写。初版据 `sdkTypes.assistant: 2` 判定为「双响应、双 `message_stop`」，该推断不成立。

**正确结论**：一次 API 响应内先流 thinking 块、再流 text 块，**只有一个 `message_stop`**。§2.2 因此应取「单 `message_stop` 收尾所有已打开通道」这一分支，且这是实测中**唯一出现**的形态。

**证据一（结构事件算术）**：第 2 轮 `stream_event: 1607`，其中内容 delta 为 `1547 (text) + 53 (thinking) = 1600`，另有 thinking 收尾必需的 `signature_delta` 1 个（属 `content_block_delta`，不计入 text/thinking 计数）→ 结构事件 = `1607 − 1601 = 6`，恰是一次含两个内容块的响应骨架（`message_start` + 2×`content_block_start` + 2×`content_block_stop` + `message_stop`）。若把 signature 也当结构事件，则为 7。**而两次独立响应最少需要 2×4 = 8 个结构事件** —— 6 与 7 均 < 8，双响应不成立。第 1 轮结构事件更少，同样只够一次响应。

**证据二（更强：`stream_end` 与 `assistant` 两条口径不等）**：

| run | `sdkTypes.assistant` | `kinds.stream_end` |
|---|---|---|
| 474d80d1 第 1 轮（被打断） | 2 | 0 |
| 474d80d1 第 2 轮 | 2 | 1 |
| 35ebea43 第 3 轮 | 10 | 4 |
| 35ebea43 第 4 轮 | 42 | 17 |

`assistant` 恒大于 `stream_end`（约 2.5 倍），说明 **`message_stop` 是「每 API 响应一次」，而 `assistant` 是「SDK 按内容块组拆分出的消息数」**——一个响应里 thinking、text、tool_use 各自落成独立 `assistant` 消息（第 4 轮 `16 thinking + 7 text + 19 tool_use = 42` 精确自洽）。所以 transcript 里「thinking 一条行、text 一条行」**不能**反推为两次响应；一个响应的块落盘即成多行。

**对实现的影响**：思考通道与正文通道**必然共用同一个 `stream_end`**，实现不能依赖「思考先收到一个 `stream_end`、正文再收一个」。`stream_end` 到点时必须同时收尾两个通道（这正是 §2.2「收尾所有已打开通道」的价值：规则与触发次数解耦）。初版 §8.5 若照原样落地，会写出「两个 `message_stop`」的测试用例，与真实流形不符。

### 8.6 反例已定位：零 `stream_end` = **用户打断**（初版「result 收尾」怀疑被证伪）

第 1 轮 `kinds` 中**完全没有 `stream_end`**。初版怀疑「该轮以 `result` 收尾、未走 `message_stop`」，**该怀疑不成立**，已按审阅意见定位为**用户打断**：

- transcript 中该轮于 `04:53:26.529` 落盘一条 user-role 的 `[Request interrupted by user]`，与 text 块落盘时间 `04:53:26.528` **相差 1ms** —— 即在正文块刚落盘时被打断，流被切断、`message_stop` 未及送达，故 `stream_end` 为 0。
- 反证：第 3、4 轮同样以 `result` 收尾，`stream_end` 分别正常发出 **4 / 17** 个。可见「`result` 收尾」不会导致 `stream_end` 缺失。
- 那条 `No response requested.`（22 字符，`04:53:40.854`）是打断后的后台补写，属打断的**后果**而非原因。

**这对方案是好消息**：该反例不是稳态缺陷，而是正面命中 §5-4（思考期间 abort）的验收场景。

**兜底路径已存在，无需新增**：`useChatRealtimeHandlers.ts:229-238` 的 `complete` 分支已做「若该会话仍有缓冲 → `flushNow` + `finalizeStreaming` + `drop`」（`root-fix-plan` §2.4 即此设计，Cursor 从不发 `stream_end`，完全依赖它）。因此 §8.7 的「需补兜底」应改为：**兜底已有，本方案要做的是把思考通道也纳入 `complete` 分支的收尾范围，并补一条「打断 → 无 `stream_end` → 无残留流式行」的回归用例**（即 §5-4）。

### 8.7 对方案的影响小结

| 方案中原有表述 | 实测后 | 处置 |
|---|---|---|
| §2 根因：思考 delta 被静默丢弃 | ✅ 确证（4 个 run 上转发数恒为 0） | 无需改 |
| §2.2：需实测是单还是双 `message_stop` | ❌ 初版写「双」——**实为单响应单 `message_stop`** | 已改 §2.2 / §5-0 / 本节 |
| §2.2：`stream_end` 由 `message_stop` 触发 | ⚠️ 初版写「需补兜底」——兜底**已有**，反例实为用户打断 | 已改 §8.6；改为补回归用例 |
| §4.2 / §7-Q5：思考 delta 会加剧 replay 压力 | ✅ 确证，比例波动从 3% 到 **96%**（第 4 轮 9177/9494） | 按最坏情形设计 |
| §1 / §5-1：「静默 ≤ 2s」 | ⚠️ 缺口径，且未计 TTFT（≈5.4s 不可控） | 已补 §8.4 口径 |
| §3 路线 A：prune / dedupe 需覆盖 thinking | ⚠️ 初版遗漏，**但仅限路线 A**——审阅所称「今天就会双份的存量缺陷」经探针证伪 | §4.7 已推翻重写；§3 保留要求、更正理由 |
| §4.4 / §4.5 / §4.6 | 数据未覆盖（无 `showThinking=false`、无 redacted、无子代理场景） | 仍待验收 |

### 8.8 取数开关的善后（经审阅提醒）

`CLAUDE_STREAM_DEBUG` 目前**固化在本机 LaunchAgent 的 plist 模板**里（`server-infra/cloudcli/com.selier.cloudcli.plist` 的 `EnvironmentVariables`，经 `cloudclictl install` 生成到 `~/Library/LaunchAgents/com.selier.cloudcli.plist`），因此**对后续所有 run 持续生效**，每 run 往 `cloudcli.out.log` 写一行。

取数已结束，两种处置择一（推荐前者）：

| 处置 | 操作 |
|---|---|
| **回滚**（推荐） | 从 plist 模板删掉该 key → 外部终端执行 `cloudclictl install`（`bootout` 会向整个进程组发信号，不能在 CloudCLI 会话内跑） |
| 保留 | 在 §6-0 明确保留意图；建议同时给计数器补 `event.type` 直方图（`message_start` / `content_block_stop` / `message_stop` / `signature_delta` / `input_json_delta`），否则下次判读响应结构仍要靠算术反推 |

> 本次「单/双 `message_stop`」的误判，根源正是计数器只有 delta 分类计数、没有结构事件直方图。补上直方图后，本轮 §8.5 的结论可以直接从日志读出。

**另一个值得固化的取数手法：直接给 adapter 喂形状**。§4.7.1 的 id 之争（实时 vs 持久化是否产同一个 id）用「读源码 + 推理」两次得出相反结论，最后靠一段十几行的探针脚本定案：

```bash
cat > .probe-ids.ts <<'EOF'
import { ClaudeSessionsProvider } from './server/modules/providers/list/claude/claude-sessions.provider';
const p = new ClaudeSessionsProvider();
const raw = { type: 'assistant', uuid: 'UUID-A', session_id: 'S1', parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想', signature: 's' }] } };
console.log(p.normalizeMessage(raw, 'S1').map(m => ({ k: m.kind, id: m.id })));
EOF
npx tsx --tsconfig server/tsconfig.json .probe-ids.ts
```

**凡涉及「某条消息在当前链路上会变成什么」的判断，优先用探针跑一次，而不是靠源码推理。** 同型问题（id 方案、kind 映射、字段保留）今后都应先探针后结论。

## 审阅批注

> 请在此表按 `文件:行` 或 `§小节` 逐条批注。作者会逐条复验后追加响应。

| 审阅者 | 位置 | 批注 |
|---|---|---|
| Claude | §8.5（连带 §2.2 引注、§5-0、文首状态行） | **（高）「双 message_stop」结论与自身数据矛盾，正确结论是「单响应、单 message_stop、thinking+text 双块」。** 算术：第 2 轮结构事件 = stream_event 1607 − delta 1600 = **7**；两次独立响应最少需要 2×(message_start + content_block_start + content_block_stop + message_stop) = 8 个结构事件，7 < 8 ⇒ 不可能是两次响应；而 7 恰好等于一次含 thinking+text 块的完整响应骨架（6 个结构事件 + 1 个 signature_delta）。第 1 轮结构事件仅 4，同样只够一次被拦腰截断的响应。transcript 佐证：thinking 落盘 04:53:48.580 与 text 落盘 04:54:49.760 之间的 61s 正是正文生成时长（deltaSpanMs 62.9s 的主体），thinking→text 在**同一响应内连续流式**。`sdkTypes.assistant: 2` 的正确解读是 **SDK 把含 thinking 的响应拆成两条 assistant 消息**（按块组拆分），不是两次 API 响应；transcript「两条独立 assistant 行」同理——一个响应的块落盘即成两行。**影响**：§2.2 表里「双 message_stop」分支可能根本不存在，真实形态就是「单 message_stop 收尾双通道」（即表中「单」分支）；「收尾所有已打开通道」规则本身不受影响（这正是它与触发源解耦的价值），但 §8.5/§5-0/状态行的「双 message_stop 已确认」措辞须更正为「单 message_stop 覆盖双通道已确认」，否则实现者会按双 stop 预期写测试用例。 |
| Claude | §8.6 | **（高）怀疑方向已被 transcript 与第三轮数据证伪，可精确定位为「用户打断」。** 我核验了 474d80d1 的 transcript：round 1 在 04:53:26.529 被 `[Request interrupted by user]` 打断（thinking 18.887 → text 26.528 落盘 → 1ms 后打断），`No response requested.`（22 字符）是打断后的后台补写（04:53:40.854）。零 `stream_end` 的机制是**打断切断流、message_stop 未及送达**——不是「以 result 收尾」的常态：第三轮（见下条）同样以 result 收尾却正常发出了 4 个 `stream_end`。这正面命中 §5-4（思考期间 abort）场景。**影响**：兜底已存在于 root-fix-plan §2.4 的 `complete` 分支（flush+finalize），§8.7 的「需补兜底」应改为「兜底已有，须补 abort-无-stream_end 的回归用例」；§8 取数描述应补注 round 1 是被打断的 run（「跑满两轮」的表述对数据解读有误导）。 |
| Claude | §8.1 | **（中）漏收了日志里的第三条数据，且它恰好是信息量最大的一条。** `cloudcli.out.log` 中还有会话 35ebea43 的 agentic run：`{textDeltas:269, thinkingDeltas:462, maxGapMs:3496, deltaSpanMs:38799, kinds:{thinking:4, tool_use:3, tool_result:3, stream_end:4, stream_delta:269, text:3}, sdkTypes:{assistant:10, …}}`。三重价值：① 支撑上一条的单响应模型——stream_end:4 == 响应数，而 assistant 行有 10（4 thinking + 3 tool_use + 3 text），即 message_stop 按响应触发、SDK 按块组拆 assistant 消息，两条口径的差异在此轮最清晰；② 提供了「多响应多 stream_end」的正例（§2.2 双通道规则在 agentic 循环下的真实形态）；③ 修正 §8.3 的普适表述——maxGap 3.5s 出现在工具执行间隔，「SDK 全程以稳定节奏吐帧」应限定为「同一响应的生成期间」。建议收进 §8.1 并在 §8.3/§8.5 引用。 |
| Claude | §3 路线 A 文件清单 | **（中）prune/dedupe 对 thinking 行没有任何分支，是路线 A 的硬缺口——且可能已是今天的潜在缺陷。** 机制（均已核源码）：`pruneRealtimeSupersededByServer`（useSessionStore.ts:309-339）只有 stream_delta/`__streaming_` id、text/assistant、text/user、tool_use 四类分支，kind `'thinking'` 落到 `return true` 兜底**永远保留**；`isAssistantTextEchoedInSameTurnOnServer` 要求 server 行 `kind === 'text'`（:249-251），thinking 持久化行永不匹配；`dedupeAdjacentAssistantEchoes` 只覆盖 stream_delta→text 与 text→text 相邻对。今天（思考非流式）live 思考行 id 为 `claude_<random>_<partIndex>`（live SDK 消息无 uuid，`baseId` 走 generateMessageId，claude-sessions.provider.ts:701），历史行 id 为 `<transcript-uuid>_<partIndex>`，id 不相等也不在 serverIds 里——刷新后理论上就会双份。路线 A 的 finalize 会把占位行换成 `text_<ts>_<rand>` 新 id，进一步切断 id 关联。**§3 路线 A 的 useSessionStore 行必须补 prune（及 dedupe）的 thinking 分支，并指定思考占位行的 id 方案（如 `__streaming_thinking_<sid>`，prune 按 id 名匹配是设计的一部分）；否则 §5-3「刷新后无重复行（A）」会失败。** 另建议顺手实测确认「今天刷新后思考行是否已双份」——若是，这是一个顺带修复的存量缺陷，应在 §4 里立为独立风险项而非随路线 A 隐式处理。 |
| Claude | §6-0 / 运营 | **（低）`CLAUDE_STREAM_DEBUG=1` 已固化进 `com.selier.cloudcli.plist:41`**，计数器对后续所有 run 持续生效（每 run 一行日志）。取数已完成，建议回滚该开关，或在 §6-0 注明保留意图。顺带建议：给计数器加一个 `event.type` 直方图（message_start / content_block_stop / message_stop / signature_delta / input_json_delta 各计数）——上面两条批注的「单/双响应」与「message_stop 未送达」就不再需要靠算术反推，下次实测直接可读。 |
| Claude | §1 / §4.4 / adapter 注释 | **（低，三处杂项）** ① §1「静默 ≤ 2s」应注明口径是「自首个思考 delta 起」：round 1 实测 TTFT ≈ 5.4s（prompt 04:53:05.490 → 思考窗口起点 ≈04:53:10.9），用户感知静默 13.4s = TTFT 5.4s + 思考 7.9s，TTFT 不可控。② §4.4 的 `uiPreferences.ts:28` 实际路径是 `src/shared/uiPreferences.ts`（不在 utils/ 下）；行号与默认值无误。③ adapter `message_stop` 分支的注释「must fire once per assistant message」（claude-sessions.provider.ts:697-699）与实测不符——实际是每个 API 响应一次，而 SDK 会把含 thinking 的响应拆成两条 assistant 消息；实现思考通道时应一并修正该注释，避免误导后人。 |
| | | |
| | | |
| | | |

**审阅者对开放问题的表态**：Q1 同意先 B（§2.5 的论证成立，特别是「A 的大半价值被折叠面板吃掉」这一条）；Q3 同意 P1，但 P1 的落地细节必须包含上一条批注的 prune/id 方案，否则 P1 的「改动面最小」是被低估的；Q5 同意纳入合并，58%↔3% 的波动论证成立（建议引用第三轮的 462/731≈63% 作为第三个点）；Q4 同意指示器不受 `showThinking` 控制。**对作者六处修改的核验**：状态行、§8、§2.2 引注、§5-0、§6-0、§7-Q5 六处均已落实，§8.1 引用的两行日志与 `cloudcli.out.log` 逐字一致，转发数==textDeltas 在全部三轮数据中精确成立（178/1547/269），§8.2 的「思考 delta 转发数为 0」证明是严密的。
| | | |
| | | |

### 作者响应

> 逐条复验完毕。**6 条批注中 5 条成立**（其中 3 条推翻了我或本文档的原始结论），**第 4 条部分驳回**（要求成立，但「存量缺陷」判断经探针证伪）。已修改 §1 / §2 / §2.1 / §2.2 / §3 / §4.7（推翻重写）/ §5-0 / §5-1 / §6-0 / §8，并补充了审阅者本人也漏掉的第 4 条数据。
>
> 本轮最大的方法教训：**批注中的「已核源码」不能直接采信**，必须独立验证其前提——R4 就是因为我跳过了这一步而错记了一项伪缺陷（详见 R4）。

#### R1（§8.5 双 `message_stop` 与自身数据矛盾）—— **接受，原结论错误，已推翻重写**

批注的算术成立，并且我找到了**比算术更硬的证据**：`stream_end` 与 `assistant` 是两条不同口径，`assistant` 恒大于 `stream_end` 且比例稳定在约 2.5:1——

| run | `assistant` | `stream_end` |
|---|---|---|
| 474d80d1 #1（打断） | 2 | 0 |
| 474d80d1 #2 | 2 | 1 |
| 35ebea43 #3 | 10 | 4 |
| 35ebea43 #4 | **42** | **17** |

第 4 轮 `16 thinking + 7 text + 19 tool_use = 42` 精确自洽，直接证明 `assistant` 是「按内容块组拆分的消息数」，`message_stop` 是「每响应一次」。批注对 `assistant: 2` 的重新解读正确。

对批注的一处精修：`signature_delta` 本身也是 `content_block_delta`，若按 delta 计，第 2 轮结构事件 = **6**；按结构事件计则 = 7。两种口径都 < 8，结论不变，但 §8.5 采用了「6（含 signature 归 delta）/ 7（signature 归结构）」的双口径写法以免后人重算。

**已改**：§8.5 整节重写；§2.2 引注由「双分支成立」改为「单 `message_stop` 收尾双通道，且这是实测唯一形态」；§5-0、文首状态行同步；并明确写出「实现不得依赖两个 `stream_end`，`stream_end` 到点须同时收尾两通道」——这正是批注担心的「实现者会按双 stop 写测试」的具体阻断。

#### R2（§8.6 零 `stream_end` = 用户打断）—— **接受，我的怀疑被证伪**

已在 transcript 中核实 `[Request interrupted by user]` 落于 `04:53:26.529`（user role），与 text 块落盘 `04:53:26.528` 相差 **1ms**。批注给出的反证（第 3、4 轮同样以 `result` 收尾却正常发出 4 / 17 个 `stream_end`）我复核成立，我的「result 收尾」怀疑**排除**。

批注的处置意见也正确：兜底已在 `useChatRealtimeHandlers.ts:229-238` 的 `complete` 分支（`root-fix-plan` §2.4 即此设计）。**已改**：§8.6 重写为「已定位：用户打断」，处置由「需补兜底」改为「兜底已有，须补 abort→无 `stream_end`→无残留流式行 的回归用例」；§8.7 对照表同步；§8 取数描述删掉「跑满两轮」并标注 #1 为打断轮。

#### R3（§8.1 漏收第三条数据）—— **接受，且实际是 4 条（批注也漏了第 4 条）**

核实日志共 **4** 条 `[claude-stream-debug]`。批注引用的是 `35ebea43` 的第一个 run，数据逐字段一致。**我补上了批注也没看到的第 4 条**，它信息量更大：

```
{"textDeltas":317,"thinkingDeltas":9177,"maxGapMs":4618,"deltaSpanMs":462195,
 "kinds":{"thinking":16,"tool_use":19,"stream_end":17,"tool_result":19,"stream_delta":317,"text":7},
 "sdkTypes":{"system":9195,"stream_event":10566,"assistant":42,"user":19,"result":1}}
```

它同时服务于三处：① 「`stream_end` ≠ `assistant`」的最强证据（R1）；② 思考帧占比的最坏值 **96%**（9177/9494），远高于批注引用的 63%；③ 支撑批注对 §8.3 的口径修正（`maxGapMs` 4618ms）。

**已改**：§8.1 补入第 3、4 轮数据与遗漏说明；§8.2 表格扩为 4 个 run（转发数==`textDeltas` 在 4/4 上精确成立）；§8.3 补口径限定；§7-Q5 与 §8.7 引用最坏值 96%。

#### R4（§3 路线 A 的 prune / dedupe 硬缺口）—— **部分接受：要求成立，但「存量缺陷」判断被证伪**

**接受的部分**：`pruneRealtimeSupersededByServer`（`:309-339`）确实没有 thinking 分支、`dedupeAdjacentAssistantEchoes`（`:262-290`）确实只覆盖两类相邻对、实时 thinking 行确实经 `appendRealtime`（`useChatRealtimeHandlers.ts:223-225`）进入 `realtimeMessages`。这些我逐处核过，并要求已写入 §3 与 §4.7.2。

**驳回的部分**：批注断言「**今天**刷新后思考行就会双份（存量缺陷）」——**不成立**。该断言依赖「实时 SDK 消息无 `uuid` → id 随机 → 与历史行 id 不等」，但这条链**每一环都有误**（详见 §4.7.1）：`SDKAssistantMessage.uuid` 是**必填字段**（`sdk.d.ts:2646`）、`transformMessage` 原样透传、实时与持久化**走同一 adapter 分支**（`:953-960`）产出同一个 `${uuid}_${partIndex}`。我写了直接探针验证：

```
live/thinking-only      → [{"k":"thinking","id":"UUID-A_0"}]
persisted/thinking-only → [{"k":"thinking","id":"UUID-A_0"}]
```

两侧 id 相同 → 命中 prune 的**第一道判据** `serverIds.has(message.id)`（`:310-312`，在所有 kind 分支之前）→ 被剪除，**走不到 `return true` 兜底**。真实 transcript 也印证：thinking 块各占一条独立 `assistant` 行、自带 uuid。

我另外核实了批注的「实时走 `:888`」：全 `server/` 目录**无人构造** `{type:'thinking'}` 输入（仅测试与其他 provider 出现），该分支在 Claude SDK 路径上不可达。

**因此 §4.7 已推翻重写**：结论从「存量缺陷」改为「**仅路线 A 的合成流式行**需要自带 prune 判据」——因为 `finalizeStreaming` 会把占位行换成 `text_<ts>_<rand>` 新 id（`:836-841`），那时 id 判据才会失效。**路线 B 完全不受影响**，§3 的要求保留但理由更正。

**我的失误**：这一条我初版是**直接采信**的——看到批注「均已核源码」就接受了机制表，只额外补了一个场景边界，没有独立验证「无 uuid」这个前提。**教训**：批注里的每一条「已核源码」都必须自己跑一遍；这次是靠直接喂数据给 adapter 才发现前提是错的。这条自我修正已写入本节与 §8.8。

#### R5（`CLAUDE_STREAM_DEBUG` 已固化）—— **接受**

属实，开关写在 LaunchAgent 的 plist 模板里，经 `cloudclictl install` 生效，对后续所有 run 持续输出。**已改**：新增 **§8.8** 给出「回滚（推荐）/ 保留」两条路径与具体操作（回滚需在 CloudCLI 会话外执行 `cloudclictl install`，因 `bootout` 会向整个进程组发信号）；§6-0 同步。

批注顺带建议的 `event.type` 直方图**非常准确**——本轮「单/双响应」之争正是因为没有结构事件计数才被迫靠算术反推。已采纳并写入 §8.8 与 §6-0 作为「若保留开关则一并补上」的增强项。

#### R6（三处杂项）—— **全部接受**

① §1 / §5-1 的「静默 ≤ 2s」口径：已注明「自首个思考 delta 起」，并在 §8.4 补 TTFT ≈5.4s 的说明（prompt `04:53:05.490` 已在 transcript 核实）。批注的「用户感知 13.4s = TTFT 5.4s + 思考 7.9s」这个拆分对验收判定很关键，已采纳。
② `uiPreferences.ts:28` 路径：确认实际为 `src/shared/uiPreferences.ts`，`showThinking: true` 默认值与行号无误；§4.4 路径已修。
③ adapter `:697-699` 注释「must fire once per assistant message」与实测不符：已确认应改为「每 API 响应一次」——按 R1 的口径，一个响应会拆成多条 `assistant` 消息。已列入 §3 路线 A 的附带修正项。

#### 对开放问题表态的回应

Q4（指示器不受 `showThinking` 控制）、Q5（纳入合并，最坏值按 96% 计）与批注一致，无异议。**Q1 已被作者复核推翻并改判，见下节**。**Q3（P1）接受批注的条件**：P1 的「改动面最小」确实被低估了——合成流式思考行的 prune 判据 / id 方案是 P1 落地的必要组成（§4.7.2），已写回 §2.1 与 §3，不再把 P1 描述为「只需扩展一个维度」。

#### 作者补充的自我修正（两条方法教训）

本轮出现了两次误判，方向相反，各对应一条教训：

1. **§8.5 误判（漏判）**：只看聚合计数、不看结构事件，把 `assistant: 2` 当成两次 API 响应。**教训**：判别流形（响应边界、块边界）时，计数器必须先有 `event.type` 直方图；§8.8 已把该增强固化。
2. **R4 误判（误判）**：**直接采信批注的「已核源码」结论**，未独立验证其前提（「实时 SDK 消息无 uuid」），差点凭空引入一项伪缺陷修复。**教训**：批注的源码论断必须自己复跑；本次最终靠「直接给 adapter 喂形状」的探针定案（§8.8 已附脚本）。**凡是「某条消息在当前链路上会变成什么」的判断，先探针、后结论。**

#### 作者复验追加：Q1 由 B 改判为 A（2026-09-11）

「先 B」是上一轮**作者与审阅者的共识决定**，但动工前复验发现其立论前提不成立：

| 路线 B 的前提 | 复验结果 | 证据 |
|---|---|---|
| 思考期间界面无反馈 | **指示器本就常亮** | `useChatComposerState.ts:869` 在 `chat.send` 前调 `onSessionProcessing(sid, {statusText: null})`；`ActivityIndicator.tsx:70` 对 `null` 自动轮播本地化文案 |
| 补一条 `status` 能带来新反馈 | **逐字段相同 → 被去重** | `useSessionProtection.ts:62-68`：`statusText` 相等即 `return prev`，零重渲染 |
| （不会被提前清除） | 服务端未上报条目保留 10s 宽限 | `useSessionProtection.ts:8`、`:129-133` |

结论：**路线 B 是空操作**。唯一能改变「看不到内容」的是路线 A，且必须配套自动展开（§4.1）。用户已确认原 19.6s 静默期「有指示器」，与该复验一致。已改：§2.3~§2.5 标注 A 采用、B 废弃；§3 目录对调；§5-1 验收口径改为「流式思考内容」；§6-2 / §7-Q1 同步。

方法论上这是本方案第三次同类教训：**动手前先验「方案赖以成立的那个前提」**，而不是只验方案内部的自洽性。前两次（§8.5 漏判、R4 误判）是**结论错**，这次是**目标错**——方案本身自洽，但要解决的问题已被既有机制解决掉了。
