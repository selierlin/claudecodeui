# Claude 流式输出 · 前端根治方案（按会话键控的流式缓冲）

> **状态**：已定稿（第一轮审阅完成，11 条批注的修订已并入正文，实现进行中）
> **日期**：2026-09-11
> **用途**：解决 `useChatRealtimeHandlers` 中流式缓冲为全局单例、导致多会话并发流式时串流与行数爆炸的问题。这是「最小路线」之外的根治路线，供其他 harness 审阅与批注。审阅时请重点检查：§2 的 registry 抽取是否值得、§4 的风险是否被低估、§7 的开放问题是否该有明确默认。
> **参考规范**：`docs/architecture/02-realtime-stream.md`（§Cross-session behaviour、§Text streaming、§If you change this, check that）、`.agents/skills/frontend-module-standards/SKILL.md`
> **前置**：后端让 Claude 真正吐 delta 的改动（`includePartialMessages` + 拆 `stream_event` + `message_stop` 边界 + 子代理 partial 过滤）。该部分已实现并搁置于分支 `feat/claude-partial-streaming`（提交 `7dac43d6`，方案文档在该分支的 `docs/research/claude-partial-streaming-plan.md`）。**本文只覆盖前端根治部分**，两者合并才是完整功能。

## Context

### 与前一份方案的关系

前一份 `claude-partial-streaming-plan.md` 对前端给了两条互斥路线：

- **最小路线**（当时采用）：非当前查看会话的 delta 客户端直接丢弃。闭合了串流与行爆炸，代价是后台会话退回「整段出现」。
- **根治路线**（当时搁置）：文档 §4.1 仅有一行描述「2a（两个 ref 改按 sessionId 键控）+ 2b（后台 delta 合并）」，并标注「不在本次范围，建议单独立项」。**没有可执行方案**。

本文把根治路线补成可执行方案。它不改变后端的任何东西，只重写客户端的流式缓冲所有权。

### 为什么现在值得重做

前一份的取舍是「本任务价值在前台流式，不该在开 SDK 选项的改动里顺手动子系统最锋利的边」。这个判断在**当时**成立。但代价是保留了后台会话实时性的缺口，且最小路线需要一处「非 viewed 即 return」的客户端丢弃——那是一段专门为回避缺陷而写的旁路。根治路线用更小的**净**复杂度（少一个旁路、少一类特例）换取完整行为，前提是 §2 的设计站得住。

## 1. 现状与缺陷（含 file:line）

### 1.1 缓冲是 `ChatInterface` 上的两个全局单例

`ChatInterface.tsx:83-84`：

```ts
const streamTimerRef = useRef<number | null>(null);
const accumulatedStreamRef = useRef('');
```

二者不按 session 区分，是整个子系统唯一非会话键控的流式状态。`02-realtime-stream.md:61-64`（规则 8）已把它记为「a real limitation, not a subtlety」。

### 1.2 三个消费点，不止两个

`useChatRealtimeHandlers.ts` 里读/写这两个 ref 的地方有**三处**（原文档只点了前两处）：

| 位置 | 行为 | 问题 |
|---|---|---|
| `:189-206` `stream_delta` | 追加到共享 ref；首次 delta 起 100ms 定时器，到点 `updateStreaming(sid, ref)`；若是后台会话再 `appendRealtime(sid, msg)` 落一行 | 后台文本会写进前台会话；后台每 delta 一行 |
| `:208-221` `stream_end` | 清定时器、flush、`finalizeStreaming(sid)`、清空 ref | 后台会话的 end 会拿前台的 ref 去 finalize |
| `:237-247` `complete` | 同样的 flush + finalize + 清 ref | **同一处缺陷的第三个实例**：Cursor 从不发 `stream_end`（`02-realtime-stream.md:172-175`），它完全依赖这里的 flush；此处仍用共享 ref |

三个点必须一起改，只改前两个会让 Cursor 的收尾仍走错会话。

### 1.3 后台会话行数爆炸

后台会话的每个 delta 经 `appendRealtime`（`useSessionStore.ts:741-757`）落成独立行，`stream_delta` 行 id 为 `${kind}_${randomUUID()}`（`server/shared/utils.ts:338`）各不相同，`upsertRealtimeMessages` 按 id upsert 无法合并。长回复迅速逼近 `MAX_REALTIME_MESSAGES = 500`（`useSessionStore.ts:536`）并淘汰最旧行，且这些行只在服务端持久化文本**完全相等**时才被 `pruneRealtimeSupersededByServer`（`:298-340`）清掉。

### 1.4 为什么过去很少暴露

只有 Cursor / OpenCode 吐 delta，二者都不是默认 provider（`02-realtime-stream.md:151-152`）。Claude 后端开流式后，默认 provider 的默认路径就会命中——多标签页、手机 + 桌面各开一个 Claude 会话是常见用法。

## 2. 设计方案

### 2.1 决策一：缓冲改为按 sessionId 键控的 registry

把两个单例 ref 换成一个按会话键控的缓冲注册表，每个会话持有自己的 `{ text, provider, timer }`：

```ts
type StreamBuffer = { text: string; provider: LLMProvider; timer: number | null };
```

推荐抽成模块私有工具 `src/modules/chat/utils/streamingBufferRegistry.ts`（`frontend-module-standards` 允许模块私有大型工具用描述性文件名），对外只暴露窄接口：

```ts
type StreamingBufferRegistry = {
  append(sessionId: string, text: string, provider: LLMProvider): void; // 追加；空文本/空 sessionId 直接 no-op；首个 delta 起 100ms 定时器
  flushNow(sessionId: string): void;             // 取消防抖，立即用整段文本回填；无条目或空文本 no-op
  drop(sessionId: string): void;                 // 清定时器并删除条目（不回填）
  dropAll(): void;                               // 卸载时清理
  has(sessionId: string): boolean;
};
```

`provider` 随 `append` 存入各自 buffer 的 `provider` 字段（**不**来自 hook 顶层闭包），回填时原样传给 `updateStreaming`。这同时修掉一个既有缺陷：现状 `useChatRealtimeHandlers.ts:197/215/244` 传的是「当前查看会话」的 provider，对异构 provider 的后台会话本就写错。registry 通过构造函数注入回填回调 `flush(sessionId, text, provider)`，定时器用 `window.setTimeout`；单测用 vitest fake timers，无需渲染 React。

`ChatInterface` 侧用 `useRef` 惰性创建 registry，回填回调经一个 `sessionStoreRef` 读取最新 store（避免把首帧的 `sessionStore`/`provider` 冻结进闭包）。

**替代方案**（更小、但不可独立测试）：直接在 `ChatInterface` 里把两个 ref 改成 `Map<string, StreamBuffer>`，逻辑内联在 handler。若审阅者认为 registry 抽取属过度设计，可采此方案；代价是核心不变量的验证必须走 `renderHook`。

### 2.2 决策二：后台会话也走 `updateStreaming`，删除 delta 旁路

`updateStreaming(sessionId, …)`（`useSessionStore.ts:803-823`）和 `finalizeStreaming(sessionId)`（`:829-846`）**本来就是会话键控的**。缓冲按会话分开后，后台会话的 delta 直接经自己的定时器回填到 `__streaming_<sid>` 行——**一个会话一个可增长的行**，与前台完全同构。

因此：

- 删除 `:202-204` 的 `if (sid !== activeViewSessionId) appendRealtime(...)` 旁路；
- §1.3 的行数爆炸随之消解（后台从「每 delta 一行」变「整段一行」）；
- 原「2b（后台 delta 合并）」不需要单独实现——它是 2a 的自然结果，**两者是同一处改动**。

渲染成本可忽略：`notify(sessionId)` 仅当 `sessionId === activeSessionIdRef.current` 时才 `setTick`（`useSessionStore.ts:548-552`），后台回填不触发前台重渲染。代价是后台 slot 每次 flush 会跑一次 `recomputeMergedIfNeeded`（O(该会话行数)），与今天前台 flush 的开销同级。

### 2.3 决策三：删除 `resetStreamingState` prop 链路，清理改由 registry 承担

现状（`ChatInterface.tsx:93-99`）是「清掉唯一的共享缓冲」，三个调用点：

| 调用点 | 现状语义 | 根治后的处置 |
|---|---|---|
| `ChatInterface.tsx:319` 卸载 | 清缓冲 | 改为 registry 的 `dropAll()`（留在 `ChatInterface` 内部），防止定时器泄漏与卸载后回填 |
| `useChatSessionState.ts:257` 新建会话 | 清缓冲 | **移除**：新会话不影响任何在跑会话的缓冲 |
| `useChatSessionState.ts:679` 无选中会话 | 清缓冲 | **移除**：同上 |
| `useChatSessionState.ts:713` 切换会话 | 清缓冲 | **移除**：缓冲已按会话分开，切换不应终结后台流 |

三处调用移除后，`resetStreamingState` 的整条 prop 链路成为死代码，**整体删除**：`useChatSessionState.ts:91`（声明）、`:191`（解构）、`:287`/`:762`（deps/返回）、`ChatInterface.tsx:169`（传参）、`transcriptScrollOwnership.test.tsx:110`（构造该入参）。不要保留空壳 prop。

> `02-realtime-stream.md:494` 明确写着「`resetStreamingState` is the only thing that unwinds a shared buffer mid-stream. Removing that call re-introduces cross-session text bleed.」——这条约束是**为共享缓冲而存在**的。缓冲按会话键控后该约束失效，架构文档须同步修订。

**清理时机**：每个会话的缓冲在 `stream_end` 或 `complete` 时 `drop`；`dropAll` 只在卸载时跑。极端情况下（进程被杀 / 丢帧，无任何终态事件）该会话残留一个 `__streaming_` 占位行——**它无法被 REST 刷新剪除**（`pruneRealtimeSupersededByServer` 要求文本 trim 后精确相等，部分文本 ≠ 持久化全文），只能靠 500 行上限淘汰。这是既有缺口（今天的 `resetStreamingState` 也只清 ref、不清 store 行），本方案没有使它变坏，但也不应被描述成「有 REST 兜底」。

### 2.4 三个消费点的改法

```
stream_delta(sid, text, provider):  if (!sid || !text) return
                                    registry.append(sid, text, provider)

stream_end(sid):          if (!sid) return
                          registry.flushNow(sid)        // 无条目 / 空文本则 no-op
                          store.finalizeStreaming(sid)  // 无占位行则 no-op，保持现行为
                          registry.drop(sid)

complete(sid):            if (sid && registry.has(sid)) {
                            registry.flushNow(sid)
                            store.finalizeStreaming(sid)
                            registry.drop(sid)
                          }
```

要点：

- `stream_delta` 的 `provider` 取自 `msg.provider`，不再读 hook 顶层的 `provider`（§2.1）。hook 入参仍保留 `provider`——它继续用于给本地合成的 `protocol_error` 帧打标记（`useChatRealtimeHandlers.ts:169`），但流式路径不再读它。
- `stream_delta` / `stream_end` 保留 `if (!sid)` 守卫（对应现行为 `useChatRealtimeHandlers.ts:213` 的 `if (sid)`）。
- `append` / `flushNow` 对空文本 no-op，是让 `complete` 的 `has(sid)` 判据**等价于**现状 `accumulatedStreamRef.current` 判据的前提：`updateStreaming` 无条件建/改行（`useSessionStore.ts:806-820`），不 guard 就会造出空 `__streaming_` 行。
- `stream_end` **无条件**调用 `finalizeStreaming`（与现行为一致）——Claude 纯工具消息也会发 `message_stop`，此时无占位行，`finalizeStreaming` 在 `:832-834` 自然 no-op。
- `complete` 保持「有缓冲才收尾」的判据。Cursor 无 `stream_end`，靠这里；OpenCode / Claude 的 `stream_end` 已把条目 drop，`complete` 的 `has` 为 false，跳过。
- `stream_end` 与 `complete` 可能都到达（OpenCode / Claude），先 `drop` 后 `has=false`，不会二次 finalize。

### 2.5 与既有去重/剪除的关系

不变。`updateStreaming` 仍产出 `__streaming_<sid>` 行，`finalizeStreaming` 仍在**原数组位置**把 id 换成 `text_<ts>_<rand>`（`:836-841`，DOM 身份依赖它）。`pruneRealtimeSupersededByServer`（`:314`）与 `dedupeAdjacentAssistantEchoes`（`:262-290`）的判据不涉及缓冲所有权，无需改动。唯一差别是后台会话现在也会产生 `__streaming_` 行——`pruneRealtimeSupersededByServer` 已按 `__streaming_${message.sessionId}` 匹配，天然覆盖。

## 3. 文件清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/modules/chat/utils/streamingBufferRegistry.ts` | **新建**：按会话键控的文本/provider/定时器注册表（§2.1） | 约 60 行 |
| `src/modules/chat/ChatInterface.tsx` | 两个 ref 换成 registry 实例（`useRef` 惰性创建，回填经 `sessionStoreRef` 读最新 store）；卸载 cleanup 改为 `dropAll`；删除 `resetStreamingState` 回调 | 约 18 行 |
| `src/modules/chat/hooks/useChatRealtimeHandlers.ts` | 入参由 `streamTimerRef` + `accumulatedStreamRef` 换成 `streamBuffers`（`provider` 保留，供 `protocol_error` 用）；重写 `stream_delta` / `stream_end` / `complete` 三处（§2.4）；删除 `appendRealtime` delta 旁路 | 约 30 行 |
| `src/modules/chat/hooks/useChatSessionState.ts` | 删除 `resetStreamingState` 的入参声明/解构/返回，及 `:257`、`:679`、`:713` 三处调用 | 约 8 行 |

`StreamBuffer` 就地定义在 registry 模块内（Q4：仅 registry 与 handler 引用，不下沉 `src/shared/types.ts`）。

**新建测试**

| 文件 | 覆盖 |
|---|---|
| `src/modules/chat/tests/streamingBufferRegistry.test.ts` | 100ms 合并（首个 delta 起定时器、窗口内只追加、到点回填整段）；多会话隔离；`flushNow` 立即回填；空文本 no-op；`drop` 清定时器；`dropAll`；provider 随会话各自携带 |
| `src/modules/chat/tests/streamingBufferSessionScope.test.tsx` | 用 `renderHook` 驱动 handler：A/B 交错 delta 各自只落自己的 slot；后台会话走 `updateStreaming` 且不 `appendRealtime`；A 的 `stream_end` 不 finalize B；无 `stream_end` 的 `complete`（Cursor 形态）只收尾自己 |

**需同步改的既有测试**（按诱因分两类，不要混为一谈）

| 诱因 | 文件 | 改法 |
|---|---|---|
| handler 入参：两个 ref → registry | `tokenBudgetSessionScope.test.tsx:34-35`、`permissionPromptReplay.test.tsx:36-37` | 换成 registry（真实实例或 stub） |
| 删除 `resetStreamingState` prop | `transcriptScrollOwnership.test.tsx:110` | 删掉该入参 |

`sessionStoreTruncate.test.tsx` 不引用 handler、也不构造本 hook 入参，**无需改动**。

**不修改**

- 全部 `server/**`
- `useSessionStore.ts` 的 `updateStreaming` / `finalizeStreaming` / `pruneRealtimeSupersededByServer` / `dedupeAdjacentAssistantEchoes`（会话键控已就绪，无需动）
- 多客户端语义（本方案是纯客户端状态，各端独立）

## 4. 风险与边界（诚实评估）

按严重度排序。

### 4.1 三个消费点必须同时改（中，本方案最容易做错的地方）

`complete` 里的 flush 是最隐蔽的一处：它平时只在 Cursor 上生效（无 `stream_end`），若只改 delta/end 两处，Claude/OpenCode 的常规路径看不出问题，**Cursor 会在多会话下串流收尾**。§5 的自动化用例 4 就是钉这个。

### 4.2 移除切会话清理，保留后台存活（中，需审阅者确认）

`02-realtime-stream.md:494` 把切会话清理列为「唯一能拆掉共享缓冲」的机制。移除它之后：

- **收益**：后台会话保持实时，切过去即见正在生成的文本（根治路线的核心价值）。
- **代价**：会话切换不再有「兜底清空」。若有 run 没有终态事件（进程被杀 / 丢帧，未发 `complete`），该会话残留一个 `__streaming_` 占位行，且**无法被 REST 刷新剪除**（前缀 ≠ 全文，精确相等判据不命中），只能靠 500 行上限淘汰。这是既有缺口（今天的 `resetStreamingState` 只清 ref、不清 store 行），本方案未使它变坏，但后台会话现在也会走到这条路径，**行为面变宽**。
- 缓解：可在打开会话（`requestLatestMessages`）时顺带 `drop` 该会话缓冲——但会牺牲「打开正在流式的后台会话」这一收益，故不建议默认做。

这是本方案最需要审阅者表态的一项（§7-Q2）。审阅者已表态：**有条件支持移除**，条件是把上面的「REST 兜底」表述改正、并把架构文档同步列为完成条件——两项均已并入正文。

### 4.3 后台会话开始产生实时行（中，行为变化）

后台 slot 从「很多独立 delta 行」变为「一个可增长的 `__streaming_` 行」。这是改善，但属可观察行为变化：

- 打开一个正在跑的后台会话，会看到单行文本在增长，而非一次性出现（这正是想要的）。
- 该会话完成后，占位行被 finalize 为普通 assistant 行，并在 REST 刷新时按文本相等被剪除。
- 若用户从不打开该会话，行留在该 slot 的 `realtimeMessages` 中，占用极小（一行）。

### 4.4 定时器与内存（低）

并发定时器数 = 正在流式的会话数（个位数）。`drop`/`dropAll` 保证定时器被清。`ChatInterface` 卸载时 `dropAll` 是唯一的全局清理，务必保留，否则定时器回调可能对已卸载组件触发 `setTick`。

### 4.5 与既有 dedupe 的边界（低）

`dedupeAdjacentAssistantEchoes` 的精确相等判据不变。后台会话现在也会出现「`stream_delta` 行紧邻相同 assistant `text` 行」的形态，该分支（`:267`）本就为此设计，直接覆盖。

### 4.6 测试面扩大（低）

两处独立诱因：handler 入参签名变化触及 2 个测试（`tokenBudgetSessionScope`、`permissionPromptReplay`）；删除 `resetStreamingState` prop 触及 1 个（`transcriptScrollOwnership:110`）。都不是用法回归，只是构造参数需要更新——仍应逐一确认它们断言的行为未被改变。

### 4.7 不属于本方案的风险

- 服务端 replay 缓冲被 delta 挤占（前份方案 §4.3）：与缓冲所有权无关，需另行实测。
- 跨客户端（多标签页）语义：纯客户端状态，各端独立，无新增共享。
- 后端 SDK 选项与事件拆包：前置条件，见文首。

## 5. 测试与验证

### 自动化

| # | 用例 | 断言 |
|---|---|---|
| 1 | 单个会话连续 delta（fake timers） | 100ms 窗口内只 append；到点 `updateStreaming` 一次，内容为整段 |
| 2 | 两个会话交错 delta | 每个会话只收到自己的文本；互不污染 |
| 3 | 后台会话 delta | 对该 sessionId 调用 `updateStreaming`；**不**调用 `appendRealtime` |
| 4 | A 的 `stream_end` 到达时 B 正在流式 | A 被 finalize；B 的占位行与缓冲不受影响 |
| 5 | 仅 `complete`、无 `stream_end`（Cursor 形态） | 该会话被 flush + finalize；其他会话不受影响 |
| 6 | `stream_end` 后紧跟 `complete` | 不二次 finalize |
| 7 | 纯工具消息的 `stream_end`（无占位行） | `finalizeStreaming` no-op，不抛错、不影响他会话 |
| 8 | `dropAll` | 所有定时器清空；后续 delta 不产生回填 |
| 9 | 后台长回复 | 该 sessionId 的 `realtimeMessages` 中占位行**恰好一行**（钉行数爆炸） |
| 10 | 同一会话连续两轮 `delta→end→delta→end` | 两行各自完整、不互相覆盖；第二轮初始文本**只含第二轮 delta**（`drop` 后必须从空文本起） |

### 手工验收

| # | 场景 | 期望 |
|---|---|---|
| 1 | 长回复（500 字 + 代码块），前台 | 逐字出现；结束无重复气泡；文本与刷新后一致 |
| 2 | 两个 Claude 会话同时流式 | 文本不串会话；**切到后台会话能看到它正在逐字生成**（根治路线的核心验收点） |
| 3 | 后台长回复跑完再打开 | 单行文本；完成后为普通 assistant 行；无重复 |
| 4 | 会话 A 流式中切到 B、再切回 A | A 在切走期间继续累积（非丢弃）；切回看到完整进度 |
| 5 | 后台会话流式中 abort | 已出文本保留为普通行，busy 清除，无残留占位行 |
| 6 | 三个以上会话并发 | 无串流、无明显卡顿 |
| 7 | 移动端长回复 | 滚动跟随正常、无明显卡顿 |
| 8 | Cursor 会话多开（无 `stream_end`） | 收尾正常，不串流（对应 §4.1） |
| 9 | 卸载 ChatInterface（切到别的路由）再回来 | 无定时器泄漏告警；会话重新加载正常 |

### 验证命令

```
npx vitest run src/modules/chat/tests/streamingBufferRegistry.test.ts
npx vitest run src/modules/chat/tests/streamingBufferSessionScope.test.tsx
npx vitest run src/modules/chat/tests/
npm run test:client
npm run typecheck
npm run lint
npm run build:client
```

## 6. 实施顺序

0. **先并入后端前置**：只摘 `feat/claude-partial-streaming` 的两个后端源码 + 一个测试（**不摘其前端最小路线改动**），跑基线（`claude-partial-stream.test.ts` 应过、`messageStreamEnd.test.tsx` 等前端基线应过）确认对照点，再叠加本方案
1. 抽 registry + 单测（纯函数，无 React）
2. 改 `ChatInterface`（建 registry、卸载 `dropAll`、删 `resetStreamingState` 回调）与 `useChatRealtimeHandlers`（三个消费点、删旁路、provider 取 `msg.provider`）
3. 删 `useChatSessionState` 的 `resetStreamingState` prop 链路（含三处调用）
4. 更新既有测试（2 处 handler 入参 + 1 处 prop）；跑前端全量 + typecheck + lint + build:client
5. 手工验收 §5（重点 2、4、5、8）
6. 同步架构文档（**按前置方案与本方案的并集一次性修订**）：`:20-22`、`:45-48` 规则 4、`:61-64` 规则 8、`:72` The pieces 表、`:151-152` kind 表、`:163-170` 整段、`:477-478`、`:494`；更新 `CHANGELOG.md`

## 7. 开放问题（Q1/Q2/Q4/Q5 已定）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | registry 抽成模块私有工具，还是内联 `Map` 在 `ChatInterface`？ | **已定：抽 registry**。核心不变量可脱离 React 单测，符合「最锋利的边值得独立测试」；两位审阅者均支持 |
| Q2 | 是否移除切会话/无会话时的 `resetStreamingState`（保留后台实时）？ | **已定：移除**。两位审阅者有条件支持，条件（改正 §4.2 表述、架构文档同步列为完成条件）已并入正文 |
| Q3 | 后台会话是否应维持实时占位行？ | 维持。丢弃后台 delta（最小路线）与根治路线互斥，不应混用 |
| Q4 | `StreamBuffer` 类型放 `src/shared/types.ts` 还是模块内？ | **已定：模块内定义**（仅 registry 与 handler 引用） |
| Q5 | 后端前置改动（`feat/claude-partial-streaming`）如何并入？ | **已定：只摘后端两个源码 + 测试，丢弃其前端「最小路线」改动**；先跑基线再叠加本方案 |
| Q6 | 是否需要并发会话数上限或调试日志？ | 不需要；并发的流式会话数天然有限（= 正在跑的用户会话数） |

## 审阅批注

> 请在此表按 `文件:行` 或 `§小节` 逐条批注。作者会逐条复验后追加响应。

| 审阅者 | 位置 | 批注 |
|---|---|---|
| Claude | §2.1 / §3 | **（高，设计缺口）flush 回调对 `provider` 的捕获会陈旧。** registry 经构造函数注入 `flush(sessionId, accumulatedText)`，该回调内部要调 `updateStreaming(sessionId, text, provider)`。若在 `ChatInterface` 里 `useRef` 惰性创建 registry，闭包捕获的 `provider` 是创建那一刻的值——而 `provider` 随选中会话/提供商变化，`useRef` 惰性初始化只跑一次，闭包永不清。后果：流式行的 `provider` 字段写错（尤其是后台异构 provider 的会话）。注意现状代码没有此问题：timer 闭包来自 effect，且 `provider` 在 deps 里（`useChatRealtimeHandlers.ts:353-370`），每次 provider 变化都会重绑。建议：`StreamBuffer` 增加 `provider` 字段、在 `append` 时捕获（每会话各自的 provider 才是正确值），或 flush 回调改读 ref。 |
| Claude | §4.2 | **（中，表述过强）「占位行由 REST 刷新兜底」不成立于部分文本。** `pruneRealtimeSupersededByServer` → `isAssistantTextEchoedInSameTurnOnServer`（`useSessionStore.ts:250-252`）要求文本**精确相等**才剪除。run 异常终止且无 `complete` 时，`__streaming_` 行持有的是部分文本，与持久化的完整回复不相等，REST 刷新剪不掉，会以「半截行 + 完整行」并存，直到 500 行上限淘汰。这属既有缺口（今天的 `resetStreamingState` 也只清 ref、不清 store 里的行），本方案没有使它变坏——但 §4.2 的缓解表述应如实改为「残留占位行**无法**被 REST 刷新剪除（前缀 ≠ 全文），仅靠行数上限淘汰」，避免审阅者按原文理解成有兜底。不建议为此扩 scope。 |
| Claude | §3 | **（低，事实修正）「需同步改 mock 的既有测试」清单不准。** grep 验证：只有 `permissionPromptReplay.test.tsx` 与 `tokenBudgetSessionScope.test.tsx` 构造了 `streamTimerRef`/`accumulatedStreamRef`；`transcriptScrollOwnership.test.tsx` 与 `sessionStoreTruncate.test.tsx` 完全不引用 `useChatRealtimeHandlers`（无任何命中），无需改动。清单应收窄为 2 个文件。 |
| Claude | §2.3 / §3 | **（低）`resetStreamingState` 的 prop 链路应整体删除。** 三处调用移除后，`useChatSessionState` 的入参声明（`:91`）、解构（`:191`）、返回引用（`:762`）以及 `ChatInterface.tsx:169` 的传参全部成为死代码。文件清单里「入参类型随 registry 调整」的措辞会引导实现者保留一个空壳 prop——应改为「删除该 prop 及其全部链路」，卸载时的 `dropAll` 留在 `ChatInterface` 内部即可。 |
| Claude | §5 | **（中，覆盖缺口）测试矩阵缺「一个 run 内多轮 stream/end 循环」。** Claude（前置改动后每条 assistant 消息一次 `message_stop`）与 OpenCode（每个 `step_finish` 一次）在 agentic run 里都会多次走「stream → end → 新占位行」。现行 9 个用例没有钉「第二次 cycle 的 `__streaming_` 行追加在第一次 finalize 行之后、不覆盖前者」——这正是 registry 按会话键控后最容易在 drop/重建时做错的多轮路径。建议补用例 10：同一会话连续两轮 delta→end→delta→end，断言两行各自完整。 |
| Claude | §2.4 | **（低）伪代码丢了 `if (sid)` 守卫。** 现行为是 `stream_end` 在 `if (sid)` 内才无条件 `finalizeStreaming`（`useChatRealtimeHandlers.ts:213`）；sid 为空（无 `sessionId` 且无 viewed 会话）时现状不调。伪代码写成无条件调用，实现照抄会引入行为差异。 |
| Claude | §1.2 | **（极低，行号）** delta 旁路的行号 `:203-205` 实为 `:202-204`（`if` 块本体）。不影响结论。 |
| Codex | §2.1 / §2.4 | **（高，设计应固化为实现要求）`stream_delta` 的 provider 不应再来自 hook 顶层闭包。** `NormalizedMessage` 已带 `provider`（`src/shared/types.ts:436`），建议把 registry 接口改为 `append(sessionId, text, provider)`，调用处传 `msg.provider`；这样同时解决 Claude 提的陈旧闭包问题，并正确处理后台异构 provider 并发。补一条测试：A/B 两会话 provider 不同、交错 delta 后 `updateStreaming` 分别收到各自 provider。 |
| Codex | §2.4 | **（中，缺 no-op 约束）`flushNow` 的接口注释只写“立即回填”，但 `stream_end` 伪代码无条件调用 `flushNow(sid)`。** 必须明确无 buffer 或空 text 时不触发 `updateStreaming`，否则纯工具消息的 `stream_end` 会创建一个空 `__streaming_<sid>` 行，偏离现状 `accumulatedStreamRef.current` 为空时不写的语义。registry 测试应覆盖该 no-op。 |
| Codex | §6 / §3 | **（中，架构文档同步清单不完整）§6 步骤 6 只写同步规则 8、Cross-session 与 reset 行，会留下至少 3 处过时事实。** `02-realtime-stream.md:45-48` 的“Claude 不流 delta”、`:477-478` 的“后台 session 的 `stream_end` 接近 no-op”、以及 `The pieces` 表中 `ChatInterface` owns 两个流式 ref 的描述都需要同步改。建议把架构文档 diff 纳入验收，而不只列三条。 |
| Codex | §5 | **（低，可并入 Claude 的多轮用例）多轮 `stream → end → stream` 不只要测两行都完整，还要断言 `drop` 后新 cycle 从空 text 开始。** 否则若 drop/重建复用旧 text，agentic run 第二轮的 `__streaming_` 会以第一轮旧内容开头；用例 10 应钉第二轮初始内容只含第二轮 delta。 |

**审阅者对开放问题的表态**：Q1 支持抽 registry（60 行 + 窄接口，核心不变量脱离 React 可测，不属过度设计）；Q2 支持移除切会话清理，但前提是先按上面 §4.2 批注修正「REST 兜底」的表述——决策依据里不能有一条不成立的缓解；Q3、Q6 同意文档倾向；Q5 的 cherry-pick 路线可行，建议在实施顺序里明确「丢弃该分支前端改动」的验证步骤（跑 `messageStreamEnd.test.tsx` 等基线）。

**Codex 对开放问题的表态**：Q1 支持抽 registry；Q2 支持移除切会话清理，但 §4.2 必须按上面的批注修正「REST 刷新兜底」表述，并把架构文档同步列为完成条件；Q3、Q6 同意文档倾向；Q4 倾向模块内定义，只有 registry 与 handler 都引用且外部需要时才下沉；Q5 的 cherry-pick 路线可行，建议先验证「丢弃该分支前端改动、保留后端改动」后的基线，再叠加本方案。

### 作者响应（第一轮）

> 两位审阅者共 11 条批注（Claude 7 / Codex 4）+ 开放问题表态。以下逐条独立复验并附 `file:line` 证据。**结论：11 条全部成立**，其中 3 条需补正位置/范围、1 条经复验发现两位审阅者各自漏掉的交叉点。正文修订待执行，本轮不动代码。

#### 逐条复验

| # | 来源 | 位置 | 批注要点 | 复验 | 处置 |
|---|---|---|---|---|---|
| R1 | Claude | §2.1/§3 | registry 的 flush 回调会陈旧捕获 `provider` | **成立。** 现状 `provider` 在 handler deps 里（`useChatRealtimeHandlers.ts:355`），每次变化重绑 effect，故无此问题；`useRef` 惰性创建的 registry 若在 `ChatInterface` 渲染作用域构造 flush 回调，则确实冻结首帧值 | 采纳。与 R8 合并——用 `msg.provider` 从根上消除该闭包 |
| R2 | Claude | §4.2 | 「REST 刷新兜底占位行」不成立于部分文本 | **成立。** `isAssistantTextEchoedInSameTurnOnServer` 以 trim 后**精确相等**为判据（`useSessionStore.ts:246-252`），部分文本 ≠ 持久化全文，剪不掉 | 采纳。修订 §2.3「由 REST 兜底」与 §4.2「直到下次 REST 刷新」两处表述 |
| R3 | Claude | §3 | 「需同步改 mock」清单不准 | **成立。** grep：`streamTimerRef`/`accumulatedStreamRef` 仅命中 `tokenBudgetSessionScope.test.tsx:34-35`、`permissionPromptReplay.test.tsx:36-37`；`transcriptScrollOwnership`/`sessionStoreTruncate` 均不引用这两者 | 采纳，但**须与 R4 拆成两类**（见「跨批注发现」①） |
| R4 | Claude | §2.3/§3 | `resetStreamingState` prop 链路应整体删除 | **成立。** 删除三处调用后，`useChatSessionState.ts:91`（声明）、`:191`（解构）、`:762`（返回）与 `ChatInterface.tsx:169`（传参）全部成死代码 | 采纳。**补充**：`transcriptScrollOwnership.test.tsx:110` 也构造该入参，须一并删——原作者清单没点出这处 |
| R5 | Claude | §5 | 缺「一个 run 内多轮 stream/end」用例 | **成立。** §5 现有 9 例无同一会话二次 cycle | 采纳，补用例 10（与 R11 合并） |
| R6 | Claude | §2.4 | 伪代码丢了 `if (sid)` 守卫 | **成立。** 现状 `:213` 先判 `if (sid)` 才在 `:217` 调 `finalizeStreaming`；`sid` 空则整体跳过 | 采纳，伪代码补守卫 |
| R7 | Claude | §1.2 | 行号 `:203-205` 实为 `:202-204` | **成立**（`if` 块 202–204）。**补正**：该 `:203-205` 字符串实际出现在 **§2.2**（§1.2 写的是 `:189-206`，区间本身没错） | 采纳，同时修位置与行号 |
| R8 | Codex | §2.1/§2.4 | provider 应取 `msg.provider`，不来自 hook 顶层闭包 | **成立。** 客户端 `NormalizedMessage.provider` 有定义（`src/shared/types.ts:436`），服务端 `createNormalizedMessage` 必填该字段（`server/shared/utils.ts:348-355`） | 采纳。**并且**：现状 `:197`/`:215`/`:244` 用的是「当前查看会话」的 provider（`useChatProviderState({ selectedSession })`），对异构 provider 的后台会话本就是错的——R8 同时修掉一个**既有潜在缺陷**（见②） |
| R9 | Codex | §2.4 | `flushNow` 必须对空文本 no-op | **成立。** `updateStreaming` 无条件建/改行（`useSessionStore.ts:806-820`），空文本会造出空 `__streaming_` 行 | 采纳。这也是让 §2.4 `complete` 的 `has(sid)` 判据**等价于**现状 `accumulatedStreamRef.current` 判据的前提（见③） |
| R10 | Codex | §6/§3 | 架构文档同步清单不完整 | **成立，且实际比 3 处更多**（复验出 8 处，见④） | 采纳，扩为完整清单 |
| R11 | Codex | §5 | 多轮用例还应断言 `drop` 后新一轮从空文本起 | **成立** | 采纳，并入用例 10 |

#### 跨批注发现（复验时两两比对得出）

**① R3 与 R4 是两份**「既有测试改动清单」，不能合成一份。原文 §3 把 4 个文件并列，隐含「都因 handler 签名变化而改」，实际是两个独立诱因：

| 诱因 | 受影响测试 |
|---|---|
| handler 签名：两个 ref → registry | `tokenBudgetSessionScope.test.tsx`、`permissionPromptReplay.test.tsx`（各 2 行） |
| 删除 `resetStreamingState` prop 链路 | `transcriptScrollOwnership.test.tsx:110`（构造 `useChatSessionState` 入参） |
| 无 | `sessionStoreTruncate.test.tsx`（不引用 handler，也不构造本 hook 入参） |

**② R8 顺带修掉一个既有缺陷。** 现状的三处 `updateStreaming(..., provider)` 传的是「当前查看会话」的 provider。后台会话一旦开始走 `updateStreaming`（正是本方案的目标），这个值就会写错——R8 用 `msg.provider` 一并解决；这也解释了为什么 R8 不是「风格偏好」而是实现正确性要求。

**③ R6 / R9 / R5+R11 三者联动，须一起落。** R9 让 `flushNow` 空文本 no-op，才使 `append` 产生的条目必然含非空文本，从而 §2.4 `complete` 的 `has(sid)` 判据等价于现状的 `accumulatedStreamRef.current` 判据；R6 保证 `sid` 空时不误调；R5+R11 的多轮用例正是检验「`drop` 后新一轮从空文本起」这条链路的唯一手段。缺任一条都会留下行为差异。

**④ R10 的清单经复验扩为 8 处**：

| 位置 | 现文 | 为何过期 |
|---|---|---|
| `:20-22` | 「only two of the four providers ever send a `stream_delta`」 | Claude 也将发 delta |
| `:45-48` 规则 4 | 「Cursor and OpenCode stream; Claude and Codex do not」 | 同上（Codex 仍不流） |
| `:61-64` 规则 8 | 缓冲属 chat pane、非 session | 根治后按 session 键控 |
| `:72` The pieces 表 | `ChatInterface` owns 两个流式 ref | 改为 registry |
| `:151-152` kind 表 | Claude `stream_delta`/`stream_end` = **no** | 改为 yes |
| `:163-170` | 「Claude does not stream deltas today」整段 | 整段作废 |
| `:477-478` | 后台 `stream_end` 接近 no-op | 根治后后台有自己的占位行，finalize 生效 |
| `:494` | `resetStreamingState` 是唯一能拆共享缓冲的机制 | 约束随共享缓冲消失而失效 |

其中 `:20-22`/`:45-48`/`:151-152`/`:163-170` 属**后端开流式**（前置方案）的完成条件，`:61-64`/`:72`/`:477-478`/`:494` 属**本方案**。但 Q5 的顺序是「先并后端、再叠前端」，架构文档应**一次性按并集修订**，因此本方案 §6 的完成条件须引用并集，而非只列自己那 4 处。

#### 开放问题表态（复验后）

| # | 审阅者表态 | 作者结论 |
|---|---|---|
| Q1 | 双方支持抽 registry | 采纳（抽 `streamingBufferRegistry.ts`） |
| Q2 | 双方**有条件**支持移除切会话清理；条件 = 先修 §4.2 表述 + 把架构文档同步列为完成条件 | 采纳。条件已由 R2 与 R10 处置，两项并入正文即满足 |
| Q3 / Q6 | 双方同意文档倾向 | 保持（不做 thinking 流式；不加并发上限） |
| Q4 | Codex 倾向模块内定义 | 采纳（仅 registry 与 handler 引用，不上沉 `src/shared/types.ts`） |
| Q5 | 双方认可 cherry-pick；建议先验证「丢弃前端改动、保留后端改动」的基线 | 采纳。写入 §6：先只取 `7dac43d6` 的后端两文件 + 测试，跑 `messageStreamEnd.test.tsx` 等基线确认前端仍为旧行为，再叠加本方案 |

#### 已执行的正文修订

1. §2.1：`StreamingBufferRegistry.append` 改为 `append(sessionId, text, provider)`；`StreamBuffer` 增 `provider` 字段；`flushNow` 注明空文本 no-op
2. §2.2：`if (sid !== activeViewSessionId)` 旁路的行号修正为 `:202-204`；provider 来源改为 `msg.provider`（写在 §2.1/§2.4）
3. §2.3：删「由 REST 刷新兜底」表述；改为「删除 prop 及其全部链路」；补 `transcriptScrollOwnership.test.tsx:110`
4. §2.4：三个消费点伪代码补 `if (sid)` 守卫；`flushNow` no-op 约束
5. §3：把「需同步改 mock 的既有测试」按跨批注发现①拆为两类；`src/shared/types.ts` 一行按 Q4 结论删除
6. §4.2：「直到下次 REST 刷新」改为「无法被 REST 剪除（前缀 ≠ 全文），仅靠 500 行上限淘汰」
7. §4.6：「4 个既有测试文件」改为「2 + 1」
8. §5：补用例 10（同一会话连续 `delta→end→delta→end`，断言两行各自完整，且第二轮初始文本只含第二轮 delta）
9. §6：第 6 步扩为完整 8 处清单；cherry-pick 前增加基线验证步骤
10. §7：Q1/Q2/Q4/Q5 更新为已定结论
