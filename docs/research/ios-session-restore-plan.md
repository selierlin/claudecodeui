# iOS 端冷启动会话恢复 实施方案

> **状态**：已定稿，可直接执行。§1–§7 为设计与三轮审阅依据，**§8 为执行定稿（以 §8 为准）**。§6 的 9 项倾向已在 §8.1 全部裁决为决策（其中问题 5 的结论与 §6 表格所写相左，原因见 §8.1 注）。审阅历史保留于文末。
> **日期**：2026-09-11（初稿 2026-09-10）
> **用途**：用户在 iOS App 内打开某台服务器的某个会话后杀掉进程，重新打开时应能回到同一台服务器的同一个会话，而不是每次都从服务器选择页重新点起。§8 给出按文件、按阶段、可直接照做的执行细则与验收清单。审阅时请重点检查：①「已实测确认」的事实是否与实际行为相符，尤其是 `@capacitor/preferences` 的存储介质与 SPA 路由的 URL 可见性；② 还原阶段的三条路径（乐观加载 / 探测、失败回退、返回列表语义）是否有遗漏；③ §8 的代码骨架与 §8.2 的实现约束是否有误。批注请直接以评论或追加段落形式写入本文档。
> **参考规范**：`.agents/skills/frontend-module-standards/SKILL.md`（前端新增模块与组件须遵守）、`docs/research/pi-provider-integration-plan.md`（本文档格式样例）、`mobile/README.md`
> **不涉及**：`server/` 后端代码。本方案全部改动落在 `ios/`（原生）、`mobile/www/`（选择页）与 `src/`（前端）。

## 1. 背景与目标

**目标**：iOS App 冷启动（含被系统/用户杀进程后重新打开）时，若能确定上次是在哪台服务器的哪个会话，则直接恢复到该 URL；无法确定或恢复失败时，行为与今天一致——回到服务器选择页。

**今天的实际行为**（已实测确认）：

- 冷启动固定进入选择页：`CloudCLIContainerViewController.viewDidLoad` 无条件 `show(pickerController)`（`ios/App/App/WebCachePlugin.swift:140`）。
- `mobile/README.md:12` 明确写着「冷启动总是回到选择页」，是有意为之的现状，本方案将改变它（见 §6 问题 1）。
- 选择页其实**已经在写**「上次服务器」到原生存储：`setLastServer()` 写入 `cloudcli.lastServer`（`mobile/www/picker.js:65-68`，调用点 `:291`）。但全仓库 grep 确认**没有任何地方读它**——这个设计意图早已埋下，只差还原侧的实现。

**必须澄清的边界**：这不等于恢复 WebView 的运行现场。进程被杀后 WebView 已销毁，页面是从 URL 重新加载的。因此：

- 能恢复的是「哪台服务器 + 哪个路由」，不是内存里的 UI 状态。
- 不会恢复「正在流式输出的那一帧画面」；但重连 WebSocket 后，服务端仍在跑的任务前端依然能看到（`src/modules/project-workspace` 的会话态由服务端驱动）。

## 2. 现状盘点（已实测确认）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 会话在浏览器里是真实 URL：`/session/:sessionId`；另有根路由 `/` | `src/App.tsx:124-129`（`BrowserRouter` + 两条 `Route`） |
| 2 | 深链 `/session/<id>` 前端本就支持：URL 里的 sessionId 若不在已加载的 project payload 中（分页所致，深链旧会话属正常），会用 `GET /api/providers/sessions/:sessionId` 反查宿主 project，绝不从本地状态猜 | `src/modules/project-workspace/hooks/useProjectsState.ts:877-1005`（解析 `useEffect`，含 `api.sessionDetails` 调用与 `navigate(replace)`）；类型注释见 `:57-61` |
| 3 | 服务器页面（远程 origin）可以访问原生插件：仓库里已有先例，`SidebarServerMenu` 在服务器页面里调 `@capacitor/preferences` 与 `registerPlugin('ServerSession')` | `src/modules/sidebar/SidebarServerMenu.tsx:1,63,73,102,122` |
| 4 | `@capacitor/preferences` 在 iOS 上落在 `UserDefaults.standard`，key 前缀 `CapacitorStorage.` | `node_modules/@capacitor/preferences/ios/Sources/PreferencesPlugin/Preferences.swift:10,18-20,61-63` |
| 5 | 上一条的直接推论：**原生侧可绕过 JS 直接读写同一份存储**（`UserDefaults.standard.string(forKey: "CapacitorStorage.<key>")`），无需新增插件方法 | 同上 |
| 6 | 登录态不随杀进程丢失：token 存在 localStorage（key `auth-token`），落在该服务器 origin 的 `WKWebsiteDataStore` 磁盘存储中 | `src/modules/auth/context/AuthContext.tsx:94`（`readStoredToken`）、`:101` |
| 7 | 服务器选择页与已连接页面共享同一份 Preferences（跨 origin），这是既有设计 | `mobile/www/picker.js:71-77` 注释；`SidebarServerMenu.tsx:10-12` 复用同一批 key |
| 8 | `showServer` 以 `url.absoluteString` 作缓存 key；而选择页的 `normalizeUrl` 会把用户输入裁剪成纯 origin | `ios/App/App/WebCachePlugin.swift:153`；`mobile/www/picker.js:99` |
| 9 | 「是否仍在该服务器」的判断只比对 scheme/host/port，不比对 path | `ios/App/App/WebCachePlugin.swift:112-119`（`isShowingLoadedServerOrigin`） |
| 10 | `SceneDelegate` 目前**没有任何生命周期回调**（只有 `willConnectTo` / `openURLContexts` / `continue userActivity`） | `ios/App/App/SceneDelegate.swift:4-24` |
| 11 | 构建期若设置 `CLOUDCLI_SERVER_URL`，会写入 `server.url`，此时 App 根本不加载选择页（直连模式） | `capacitor.config.ts:15,35-41`；当前仓库的 `ios/App/App/capacitor.config.json` 未设置 |
| 12 | **直连判定不能用 `appStartServerURL != nil`**：该属性是**非可选** `URL`，且未配置 `server.url` 时回落到 `localURL`（即 `capacitor://localhost`），因此「非 nil」恒真。正确判定是 `config.serverURL != config.localURL`：配置了 `server.url` 时 `_serverURL` 取远程值，否则 `_serverURL = _localURL`。`InstanceConfiguration` 没有更「官方」的布尔属性；官方自身区分「应用导航」时用的也是这两个 URL 的前缀比较，本判定是同一惯例的等价表达（两个 `URL` 的 `==` 走 `isEqual`，比内容非指针） | `node_modules/@capacitor/ios/Capacitor/Capacitor/CAPInstanceConfiguration.swift:11-16`；`CAPInstanceConfiguration.m:44-51`；`CAPInstanceConfiguration.h:14-15`（均 `nonnull`）；官方惯例见 `WebViewDelegationHandler.swift:111-112` |
| 13 | **Capacitor 自己持有 `navigationDelegate`，不应注入**：`WebViewDelegationHandler` 在 `loadView()` 内以局部 `let` 创建（不是可覆写的存储属性），随即同时交给 `prepareWebView` 与 `CapacitorBridge`，`aWebView.navigationDelegate = delegationHandler`。原代理**并非取不到**——`CapacitorBridge.webViewDelegationHandler` 是 `public private(set)`，可据此替换并转发；致命点在于必须**完整**转发每个分支（`decidePolicyFor` 的 allowNavigation / `shouldOverrideLoad` / 跨域导航拦截、`didStartProvisionalNavigation` 的 `bridge?.reset()`、auth challenge、媒体权限…），漏一处就是运行时事故。结论：不碰代理 | `node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift:44-52,321`；`CapacitorBridge.swift:105`；`WebViewDelegationHandler.swift:7,45-48` |
| 14 | **`pickerController.bridge` 在 `loadView()` 之前是 nil**：`CAPBridgeViewController.bridge` 是 `public final var bridge: CAPBridgeProtocol?`，getter 直接返回私有的 `capacitorBridge`，而后者只在 `loadView()` 里创建。`loadView()` 又被声明为 `final`，无法覆写。首访 `controller.view` 才会触发它 | `CAPBridgeViewController.swift:6-9,30-53`；`CAPBridgeProtocol.swift:6`（`config` 非可选） |
| 15 | `#root` 初始无子节点，且启动 splash 是它的**兄弟**而非子节点，不会污染挂载判据；主脚本是 `type="module"`（defer 语义），加载完成时已执行 | 源码 `index.html:80-86`；构建产物同构：`dist/index.html:78,85,90` |

## 3. 待验证项（实现前需在真机/模拟器确认）

| # | 待验证 | 为什么要验 | 验证方式 |
|---|---|---|---|
| V1 | `WKWebView.url` 是否随 SPA `history.pushState` 更新 | 决定「原生读当前路由」这条路是否可行。业界已知 `webView.url` 对同文档导航不可靠，因此方案 B 必须改用 `evaluateJavaScript("window.location.href")`；若 `webView.url` 恰好可用，方案 B 可简化 | 真机跑一段 `pushState`，打印 `webView.url` 与 `evaluateJavaScript` 结果对比 |
| V2 | `sceneDidEnterBackground` 内 `evaluateJavaScript` 的可用性与时序 | iOS 杀进程不保证走 `willTerminate`，后台时机是唯一可靠落盘点；需确认回调内取 URL 来得及 | 真机：进后台后立刻杀进程，检查落盘值 |
| V3 | 硬加载 `/session/<id>` 且该会话已被删除/归档时前端的落点 | 决定是否需要额外兜底，避免恢复到空页面 | 手动改 URL 访问一个不存在的 sessionId，观察 `ProjectWorkspaceRoute` 行为 |
| V4 | 恢复路径下 token 恰好过期的表现 | 确认降级到登录页而不是白屏 | 清掉 `auth-token` 后硬加载 `/session/<id>` |
| V5 | 三个关键量在三种情形下的实测值：① 正常服务器；② 后端挂但反代/静态层仍在（返 5xx 错误页）；③ 完全不可达（DNS 失败 / TCP 超时）。要测的是 (a) `isLoading` 由 true 转 false 的耗时、(b) `#root` 出现子节点的耗时、两者之间的间隔 | 直接决定 §4.2 策略 I 里 W（宽限期）与 C（绝对上限）的取值。**不要**指望 `didFail*` 覆盖 5xx（事实 13：代理不应注入；且 5xx 在 WebKit 里属导航成功，会走 `didFinish` 而非 `didFail*`）。判据本身已由事实 15 预先确认成立，此处只测时序 | 分别起正常服务、必返 5xx 的服务、不可达地址，打点记录 |
| V6 | `evaluateJavaScript` 轮询的开销与频率上限 | 轮询间隔过密会持续占用主线程（探测本身很快，但往返需切回主线程） | 以 0.5s 间隔、C 秒上限实测，观察是否影响首屏渲染 |

## 4. 方案总览

分两阶段：**记录**（App 离开前台时落盘「服务器 + 路由」）与**还原**（冷启动时读回并加载）。

### 4.1 记录阶段

**存储契约**（新增一个键，替代 `cloudcli.lastServer` 的读取用途）：

- key：`cloudcli.restoreTarget`
- value：JSON 字符串 `{ "url": "http://192.168.1.5:3001/session/abc123?foo=1" }`

只存**一个绝对 URL**，不再拆 `origin` + `path` 两个字段。理由：① 两个字段必须一致，拆分引入不一致窗口；② `path` 的来源有陷阱——`useLocation().pathname` 会剥掉 router basename，而还原时加载走的是原生 `window.location.pathname`（含 basename），两者不等会还原到 404（`src/App.tsx:29-107` 的 `detectRouterBasename` 说明 basename 场景真实存在）；直接取 `window.location.href` 则天然包含 basename、query 与 hash，不存在该歧义。`origin` 在需要校验时用 `URL(string:)!.origin` 现算即可。

原方案里的 `savedAt` 已删除：两条写入路径产出的 `url` 在冲突时是同一个值（路径 B 也是读 `window.location.href` 而来），不存在需要 last-write-wins 仲裁的场景，没有消费方的字段不应保留。

选择单键 JSON 而不是「按 origin 分键」（`cloudcli.lastRoute.<origin>`）的理由：后者会留下无用的历史键，且无法表达「最后一次到底连的是哪台」。

**写入的两条路径**（建议同时实现，取 A 为主、B 为兜底）：

- **路径 A（推荐，前端 route tracker）**：新增一个极小模块，路由变化时把 `{ url: window.location.href }` 写入 `@capacitor/preferences`。注意**不能**用 `useLocation().pathname` 拼（见上）。
  - 仅在 `window.Capacitor?.isNativePlatform?.()` 为真时生效（与 `SidebarServerMenu.tsx:52` 同一判定），浏览器与桌面包下是 no-op。
  - 还需一道自校验：仅当 `window.location.origin` 出现在 `cloudcli.servers` 里时才写入。否则一旦前端发生整页导航到本地选择页（`capacitor://localhost`，旧版前端的降级路径，见 `picker.js:290-306`），本地 URL 会被当成恢复目标写进去。
  - 与 `cloudcli.lastServer` 的关系：其 origin 语义被本键取代。为避免行为回退，`picker.js` 的写入保持不变（它仍是选择页唯一的写入方），`cloudcli.lastServer` 是否删键留给 §6 问题 5。
- **路径 B（兜底，原生落盘）**：在 `SceneDelegate` 新增 `sceneDidEnterBackground`，对**当前可见的服务器 WebView**调 `evaluateJavaScript("window.location.href")`，成功则覆盖写 `cloudcli.restoreTarget`。
  - **必须先确认可见的是服务器页而非选择页**，否则用户停在选择页时进后台，会把 `capacitor://localhost/...` 写成恢复目标。判据用现成的两个方法：该 controller `!== pickerController` 且 `isShowingLoadedServerOrigin` 为真（`WebCachePlugin.swift:112-119`）。
  - 容器目前**没有「当前可见是谁」的指针**——`show(_:)` 只通过 `child.view.isHidden` 表达可见性（`WebCachePlugin.swift:201-203`），因此需要新增一个 `private weak var currentController`（或等价字段）供本路径与还原逻辑共用。
  - 必须用 `evaluateJavaScript`，不能用 `webView.url`（见 V1）。
  - 用 `beginBackgroundTask` 包裹以争取时间。
  - 这条路保证「即使用户运行的是尚未包含 route tracker 的旧前端，也能恢复」。

**清除时机**：用户进入服务器选择页（`serverSession.showPicker()`）时，清空 `cloudcli.restoreTarget`——否则用户刚主动退回列表，下次冷启动又被拽回旧会话，与直觉冲突。

### 4.2 还原阶段

在 `CloudCLIContainerViewController.viewDidLoad`（`WebCachePlugin.swift:137-141`）插入判定：

```
show(pickerController)                              // 必须先执行，见下方「执行次序」注记
if bridge?.config.serverURL != bridge?.config.localURL
    → 直连模式（构建期 server.url）：不读 restoreTarget，维持现状。
      注意此处 pickerController 加载的本就是远程服务器（appStartServerURL == serverURL），
      它不是选择页；不要调 showServerPicker()，那会白白触发一次 reloadLocalApp()
read CapacitorStorage.cloudcli.restoreTarget        // JSON { "url": ... }
if 无值 / 解析失败 / url 非 http(s)                → 走 picker
if URL(url).origin 不在 cloudcli.servers 中（服务器已删）→ 清标记，走 picker
else                                                → 恢复：showServer(url)
```

> **直连判定的坑（事实 12）**：`appStartServerURL` 是非可选 `URL` 且无 `server.url` 时回落 `localURL`，`appStartServerURL != nil` 恒为真。照此实现会让恢复逻辑**永远被跳过**，功能完全失效。必须比对 `config.serverURL` 与 `config.localURL`（两者在 `CAPInstanceConfiguration.h:14-15` 均为 `nonnull`，`==` 走内容比较）。

> **执行次序（事实 14）**：上面读的是 `pickerController.bridge`，而 `bridge` 的 getter 只返回私有的 `capacitorBridge`，后者在 `loadView()` 中才创建（且 `loadView()` 是 `final`，无法覆写）。因此**必须放在 `show(pickerController)` 之后**——`show` 里的 `controller.view!` 会触发 `loadView()`；否则读到的是 `nil`，`bridge?.config` 整个表达式短路，直连 guard 静默失效。若要前置判定，等价做法是先 `pickerController.loadViewIfNeeded()`。`bridge` 本身是可选协议类型（`public final var bridge: CAPBridgeProtocol?`），所以写法上用 `bridge?.config`，而 `config` 在协议里是非可选的。

**Key 改造（必须做，否则会重复创建 WebView）**：`showServer` 目前以 `url.absoluteString` 为 key（事实 8），传入带 path 的会话 URL 会产生与 origin 不同的 key，导致同一台服务器缓存两份 WebView，并挤掉 `maxCachedServers = 2` 的预算（`WebCachePlugin.swift:132`）。改法：**签名不变，只把内部 key 归一化为 origin**（`scheme://host:port`），加载目标仍用传入的完整 URL。

```swift
// CloudCLIContainerViewController.showServer(_ url: URL, from:)
let key = normalizedOriginKey(url)   // 原来这里是 url.absoluteString
```

这样三处调用方都无需改动：`ServerSessionPlugin.switchToServer`（`:58-74`）传 origin、选择页降级路径传 origin、还原路径传完整会话 URL，三者若指向同一台服务器会命中同一个 WebView。`isShowingLoadedServerOrigin`（事实 9）本就读 `loadedServerURL` 的 origin，天然兼容。

**恢复策略**（二选一，见 §6 问题 2）——两条都要求「一次启动只尝试一次」，不允许失败重试循环：

- **策略 I：乐观加载 + 挂载探测回退**（倾向）。立刻 `showServer(url)`，成功路径零额外启动延迟。失败判定**不用导航代理**（事实 13：代理虽可取到，但必须完整转发每个分支才安全，代价与风险都不划算），改为轮询：

  每 0.5s 轮询一次，按下列顺序判定：

  1. `evaluateJavaScript("!!document.getElementById('root')?.children.length")` 为真 → 挂载成功，撤掉轮询与浮层，结束。判据成立的前提见事实 15（`#root` 初始为空，splash 是兄弟节点不干扰）。
  2. 仍未挂载，且 `webView.isLoading == true` → **继续等待，不计数**。页面还在加载时不能判失败——这正是「合法慢加载」与「真失败」的分界，也是不把挂载超时写成朴素墙上时钟的原因。
  3. 仍未挂载，且 `webView.isLoading == false` → 开始累计；**该状态持续 ≥ W（拟 1.5s，约 3 个轮询周期）** 才回退到 picker。
  4. 绝对上限 C（拟 30s）兜底：不论 `isLoading` 状态，超时即回退。用于覆盖「连接建立但服务端永不响应、WebKit 自身超时又很长」的挂死场景。

  几个要点：

  - **W 那一步是必须的，不能省成「一看到 `isLoading == false` 就回退」**。`isLoading` 转 false 的时刻接近 `didFinish`，而 `#root` 由 React 首次 commit 写入要再晚十几~几十 ms；单次采样落在这个窗口里会把「本可恢复」误判成失败。
  - 这条规则同时覆盖了「后端挂但静态层仍在返回 5xx」——**这正是 `didFail*` 抓不到的情形**（5xx 在 WebKit 里属导航成功，会走 `didFinish`）。错误页没有 `#root` 子节点，且 `isLoading` 很快转 false，因此 W 秒后即回退。
  - 因为计时以 `isLoading == false` 为前提，真实失败（DNS 失败 / 连接被拒 / 5xx）通常在 **2s 内**就回退，比「统一靠 8~10s 墙上上限」更快；而合法慢加载不会被误杀。C 取值因此几乎不参与决策，只需足够宽容即可，不必与 `picker.js:41` 的 `CONNECT_TIMEOUT_MS = 8000` 对齐（两者语义不同：那个是网络请求超时，这个是「页面已结束加载但应用没起来」的判定窗口）。
- **策略 II：先探测再加载**。复用选择页的 `/health` 语义（`mobile/www/picker.js:342-356`）先探活，可达才加载，否则直接 picker。失败判定确定、实现简单，代价是每次冷启动都为「正常恢复」付一次网络往返；且它只判定「后端可达」，仍不能区分「可达但前端资源 5xx」，那一种仍需策略 I 的挂载探测兜底。

**恢复期间的可见退出**：无论选哪条策略，恢复期间都必须有一个用户可触达的「返回服务器列表」入口。现有入口在已连接页面的侧边栏（`SidebarServerMenu.tsx:101-115`），而恢复失败时该页面根本没加载出来。建议在恢复期间于原生层叠一个轻量浮层（复用启动 splash 也可），成功加载后移除。

## 5. 改动清单

### 修改

| 文件 | 改动 |
|---|---|
| `ios/App/App/WebCachePlugin.swift` | ① `showServer` 内部 key 归一化为 origin（`:152-172`），签名不变；② `CloudCLIContainerViewController` 新增 `currentController` 指针，`show(_:)`（`:185-204`）内维护；③ `viewDidLoad`（`:137-141`）插入还原判定（含 `serverURL != localURL` 直连 guard）——**位置必须在 `show(pickerController)` 之后**，否则 `bridge` 尚为 nil（事实 14）；④ 恢复期挂载探测轮询（挂载判据 + `isLoading` 门控 + W 宽限 + C 上限）+ 失败回退 + 浮层（策略 I） |
| `ios/App/App/SceneDelegate.swift` | 新增 `sceneDidEnterBackground` → 确认可见的是服务器页后，`evaluateJavaScript("window.location.href")` 落盘 `cloudcli.restoreTarget`（路径 B）；用 `beginBackgroundTask` 包裹 |
| `mobile/www/picker.js` | ① `connect()`（`:290-306`）时写入 `cloudcli.restoreTarget`，值为该服务器的**绝对 URL**（与 route tracker 同一契约，避免两条写入路径字段不一致）；② 删除服务器（`:252-266`）时若删的是当前标记的 origin，一并清 `cloudcli.restoreTarget` |
| `src/App.tsx` | 在 `<Router>` 内挂载 route tracker（`useLocation()` 必须在 Router 内） |
| `mobile/README.md:12` | 「冷启动总是回到选择页」需改写为新的行为描述 |
| `docs/architecture/`（如已有移动端说明） | 若有对应章节需同步；实现时确认 |

### 新建

| 文件 | 职责 |
|---|---|
| `src/modules/<new-module>/RestoreTargetTracker.tsx` | 订阅路由变化，native 且当前 origin 在 `cloudcli.servers` 中时写 `cloudcli.restoreTarget`（`window.location.href`，非 router pathname） |
| `src/modules/<new-module>/index.ts` | barrel；只暴露 tracker 组件 |

**前端模块落点（待定，倾向）**：路由是 App 层职责，不属于 `project-workspace`；`sidebar` 也不合适。倾向新建独立小模块（如 `src/modules/mobile-session-restore/`），遵守 `frontend-module-standards` 的 `@/...` 别名、barrel 与 `import type` 规则。若审阅者认为不值得为一个组件开模块，备选是放进 `src/shared/`——但 `shared` 更偏向无业务语义的通用件，此处倾向不这么做。

### 测试

- **原生侧今天没有测试承载**（已确认：`ios/App/App.xcodeproj/project.pbxproj:85-106` 只有唯一的 `App` target，`productType = com.apple.product-type.application`，不存在 XCTest target）。因此把可测逻辑抽成**无副作用的纯函数**，并靠 §7 的真机清单覆盖行为。是否新建 test target 见 §6 问题 8。
  - 签名必须做到**零 Capacitor / UIKit / WKWebView 依赖**，否则抽出来也测不动。即不要让纯函数接收 `InstanceConfiguration`，而是让调用方先映射成一个普通的值类型入参，例如 `decideRestore(_ input: RestoreInputs) -> RestoreAction`，其中 `RestoreInputs` 只含 `Bool`（是否直连）与 `String?`（`restoreTarget` 原始值、服务器 origin 列表）。要抽的两个函数是 **key 归一化** 与 **还原判定**。
  - 挂载探测的时序（W / C）属行为，靠真机清单，不进纯函数。
- 前端：tracker 在非 native 下不写存储；origin 不在 `cloudcli.servers` 时跳过；写入的是 `window.location.href` 原值（含 basename/query）；`/` 与 `/session/:id` 两种形态。

## 6. 开放问题（需决策）

| # | 问题 | 我的倾向 | 理由 |
|---|---|---|---|
| 1 | 恢复是否作为**默认行为**？今天 `mobile/README.md:12` 明确承诺「冷启动总是回到选择页」，本方案会推翻它 | **默认开启**，且不提供开关 | 用户诉求就是「打开还在那个会话」；多一步设置项让绝大多数用户享受不到这个能力。选择页的入口并未消失（侧边栏 + 恢复失败回退），可用性不降级 |
| 2 | 恢复策略选 **I（乐观加载 + 挂载探测）** 还是 **II（先探测）**？ | **策略 I** | 成功路径零额外延迟；策略 II 让每次冷启动都多一次网络往返，而这恰恰是常态路径。策略 I 的失败判据是启发式，但 §4.2 的「计时以 `isLoading == false` 为前提 + W 秒宽限」已经把误判面收窄到「页面已结束加载却仍不挂载」这一种，真实失败约 2s 即回退 |
| 3 | 恢复失败时的回退：**静默回选择页** 还是 **给一次提示**？ | **回选择页 + 一条非阻塞提示** | 静默回退会让用户困惑「我刚才明明在那个会话」。但提示不能是阻断式弹窗，否则每次离线启动都被打断 |
| 4 | 「返回服务器列表」是否清除恢复标记？ | **清除** | 用户主动退回列表是一个明确信号，语义上等于「我不需要自动回到刚才那里」。见 §4.1 清除时机 |
| 5 | 已有的 `cloudcli.lastServer` 键如何处置？ | **保留写入、不删键**；读取统一走 `cloudcli.restoreTarget` | `lastServer` 目前无读取方（事实见 §1），删键属于顺带清理，收益低而引入迁移负担；但保留一个无人读的键也不理想。倾向在实现时一并删除写入与键，若审阅者认为风险不可接受则保留 |
| 6 | 是否需要记忆**每台服务器各自的路由**（而非只记最后一台）？ | **只记最后一次** | 用户诉求是「打开这次杀掉的那个会话」。按台记忆会带来多份状态与过期问题，收益场景（在两台服务器间反复切换且都要续接）罕见 |
| 7 | 是否需要额外生命周期回调把当前路由更频繁地落盘（如 `sceneWillResignActive`）？ | **不需要** | `sceneDidEnterBackground` 已覆盖「用户离场」的主路径；更频繁落盘只增加 IO，不提升可靠性 |
| 8 | 是否为本方案新建 iOS XCTest target？ | **不新建**，改为「抽纯函数 + 真机清单」 | 今天没有任何 test target（§5 已确认）。为一个存量约几十行的判定逻辑引入 target 需要改 `project.pbxproj`（该工程还混着 SPM/CocoaPods 结构），成本明显高于收益。把判定与 key 归一化抽成纯函数，未来要加 target 时可零改动接入 |
| 9 | 恢复期间的原生「返回服务器列表」浮层，是复用启动 splash 还是新做一个轻量浮层？ | **新做一个轻量浮层** | splash 的生命周期由 Capacitor 管，塞入可交互按钮容易和它的淡出时机打架；独立浮层可精确地在「挂载成功」时移除 |

## 7. 验证计划

1. `npm run build`（前端产物）+ `npx cap sync ios`。
2. Xcode 真机：连接服务器 → 进入某会话 → 杀进程 → 重开，确认落回同一会话。
3. 边界：① 服务器关机后重开 App（应回选择页且不卡死、不进死循环）；② 「返回服务器列表」后杀进程重开（应停留在选择页）；③ 删除该服务器后重开（应回选择页）；④ 设置 `CLOUDCLI_SERVER_URL` 的直连包（应直接进服务器、不经选择页、且**不走恢复逻辑**——这条专门守事实 12 的坑）；⑤ 切到第二台服务器后杀进程重开（应恢复第二台，且不复用第一台的 WebView）；⑥ 后端挂掉但反代/静态层仍在返回 5xx 时重开（应被挂载探测抓到并回退，而不是停在错误页上无路可走）。
4. 完成 V1–V6 的实测项并把结论回填到 §3。
5. 真机内存观察：确认 key 归一化后 `maxCachedServers = 2` 的预算没有被重复 WebView 挤占。

## 8. 技术执行方案（可直接执行）

> **权威性**：§1–§7 是设计与三轮审阅的依据；本节是定稿的执行细则。若二者冲突，以本节为准。§6 的 9 项倾向已全部采纳为决策（§8.1）。

### 8.1 已决决策（承接 §6）

| # | 决策 | 落地位置 |
|---|---|---|
| 1 | 还原默认开启，不提供开关 | `viewDidLoad` 无条件调 `attemptRestore()` |
| 2 | 策略 I：乐观加载 + 挂载探测回退 | §8.4 · P3 |
| 3 | 失败回选择页 + 一条非阻塞提示 | `finishRestore(success: false)` |
| 4 | 进入选择页即清还原标记 | `showServerPicker` 内 `RestoreTargetStore.clearTarget()` |
| 5 | **删除** `cloudcli.lastServer`（写入与键一并移除） | `picker.js` 删除 `LAST_KEY` / `setLastServer` / 调用点 |
| 6 | 只记最后一次（单键） | 单键 `cloudcli.restoreTarget` |
| 7 | 不加 `sceneWillResignActive` 等额外落盘 | 仅 `sceneDidEnterBackground` |
| 8 | 不新建 iOS XCTest target | 抽纯函数 + §8.5 真机清单 |
| 9 | 新做轻量恢复浮层（不复用 splash） | `showRestoreOverlay()` |

> **对 §6 问题 5 的裁决变更**：§6 该行「我的倾向」列写的是「保留写入、不删键」，但同一格的理由又倾向删除，二者矛盾。此处定为**删除**——确认无任何读取方（`mobile/www/picker.js:12,67` 是仅有的两处引用；Electron 的 `lastActiveServerId` 是同名不同物，与此键无关），其 origin 语义已被 `cloudcli.restoreTarget` 完全取代，保留只会形成两个「上次服务器」键并存的歧义。删除无迁移风险：任何历史版本都不读它。

### 8.2 先读的实现约束（非显然，影响做法）

1. **不新增 Swift 文件。** `ios/App/App.xcodeproj/project.pbxproj` 不是文件系统同步组（无 `PBXFileSystemSynchronizedRootGroup`），每个 `.swift` 都要在 `PBXBuildFile` / `PBXFileReference` / group children / Sources 四处手工登记（`:13,18-19,26,32-33,69-72,164-166`）。新增文件需手改工程文件，收益不抵成本。因此原生改动**全部落在现有两个文件**：`WebCachePlugin.swift`、`SceneDelegate.swift`。
2. **`CapacitorStorage.` 前缀是刻意接受的硬编码耦合。** `@capacitor/preferences` 默认 `group = .named("CapacitorStorage")`、`prefix = group + "."`、`defaults = UserDefaults.standard`（`node_modules/@capacitor/preferences/ios/Sources/PreferencesPlugin/Preferences.swift:10,18-23,62-63`）。原生侧直接以该前缀读写同一份存储（事实 5）。若未来升级该插件改动默认 group，原生读取会静默失效——升级该插件时必须回归 §8.5 的 ①。
3. **`attemptRestore()` 必须在 `show(pickerController)` 之后**（事实 14），否则 `pickerController.bridge` 为 `nil`，直连 guard 静默失效。
4. **一次启动只尝试一次还原**：`restoringController` 非 nil 期间不再发起，失败也不重试，避免失败循环。
5. 前端新模块须遵守 `frontend-module-standards`：`@/...` 别名导入、barrel 只暴露必要 API、用 `type` 而非 `interface`、导出组件在定义处写消费者注释。

### 8.3 阶段与顺序

| 阶段 | 内容 | 依赖 | 可独立验证 |
|---|---|---|---|
| P1 | 存储契约 + 三条写入/清理路径 | 无 | 是（读 UserDefaults 或真机） |
| P2 | key 归一化 + `presentServer` 抽取 + `currentController` + 还原判定 | P1（需读到标记） | 是（先还原到服务器首页即可） |
| P3 | 挂载探测 + 浮层 + 失败回退 + 清标记接线 | P2 | 是（真机） |
| P4 | 原生兜底落盘 `sceneDidEnterBackground`（路径 B） | P2（需 `currentController`） | 是（真机，V2） |
| P5 | 文档、前端测试、真机清单、V 项结论回填 | P1–P4 | 是 |

P1 的前端 tracker 与原生 store 可并行；P2 内「key 归一化」与「还原判定」互不依赖，可并行；P4 与 P3 无依赖关系，可并行。P1–P4 全部完成后才做 P5 的真机清单。

### 8.4 分阶段执行细则

#### P1 存储契约与写入侧

**P1-1 原生 store helper**（`WebCachePlugin.swift` 顶部，两个 plugin 类之前；无 Capacitor/UIKit 依赖）

```swift
/// @capacitor/preferences 在 iOS 上写入 UserDefaults.standard，键名前缀固定为
/// "CapacitorStorage."（插件默认 group）。原生侧直接读写同一份存储，避免为冷启动
/// 还原新增桥接方法。该前缀是插件实现细节，升级 @capacitor/preferences 时须回归 §8.5-①。
enum RestoreTargetStore {
    private static let prefix = "CapacitorStorage."
    private static let targetKey = prefix + "cloudcli.restoreTarget"
    private static let serversKey = prefix + "cloudcli.servers"

    /// 还原目标是一条绝对 URL（含 basename/query）。解析失败一律当作无目标。
    static func readTargetURL() -> URL? {
        guard let raw = UserDefaults.standard.string(forKey: targetKey),
              let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["url"] as? String,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil else { return nil }
        return url
    }

    static func writeTargetURL(_ url: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["url": url.absoluteString]),
              let json = String(data: data, encoding: .utf8) else { return }
        UserDefaults.standard.set(json, forKey: targetKey)
    }

    static func clearTarget() {
        UserDefaults.standard.removeObject(forKey: targetKey)
    }

    /// 该 origin 是否仍在选择页保存的服务器列表中；服务器被删则不再还原。
    static func isKnownServerOrigin(_ url: URL) -> Bool {
        guard let raw = UserDefaults.standard.string(forKey: serversKey),
              let data = raw.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return false
        }
        return list.contains { entry in
            guard let value = entry["url"] as? String, let saved = URL(string: value) else { return false }
            return saved.scheme?.lowercased() == url.scheme?.lowercased()
                && saved.host == url.host
                && saved.port == url.port
        }
    }
}
```

**P1-2 前端 route tracker**（新建模块 `src/modules/mobile-session-restore/`）

`RestoreTargetTracker.tsx`：

```tsx
import { Preferences } from '@capacitor/preferences';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const RESTORE_TARGET_KEY = 'cloudcli.restoreTarget';
const SERVERS_KEY = 'cloudcli.servers';

type CapacitorWindow = {
  Capacitor?: { isNativePlatform?: () => boolean };
};

/**
 * Persists the current absolute URL to native storage so a cold start can restore
 * the session. Rendered by App inside <Router> (useLocation requires it).
 * No-op outside the native shell and when the current origin is not a saved server.
 */
export function RestoreTargetTracker() {
  const location = useLocation();

  // Re-run on every route change so the persisted target tracks the active session.
  useEffect(() => {
    void persistRestoreTarget();
  }, [location]);

  return null;
}

async function persistRestoreTarget() {
  const capacitor = (window as unknown as CapacitorWindow).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return;

  const { href, origin } = window.location;
  try {
    const { value } = await Preferences.get({ key: SERVERS_KEY });
    const servers: unknown = value ? JSON.parse(value) : [];
    if (!Array.isArray(servers) || !servers.some((entry) => isSavedOrigin(entry, origin))) return;
    // Store the raw href, not useLocation().pathname: the router pathname strips a
    // deployment basename that the native loader will include, which would restore a 404.
    await Preferences.set({ key: RESTORE_TARGET_KEY, value: JSON.stringify({ url: href }) });
  } catch {
    // Restore is best-effort; a failed write must never affect the running session.
  }
}

function isSavedOrigin(entry: unknown, origin: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const url = (entry as { url?: unknown }).url;
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
```

`index.ts`：`export { RestoreTargetTracker } from '@/modules/mobile-session-restore/RestoreTargetTracker';`

`src/App.tsx`：在 `<Router>` 内、`<Routes>` 之前挂 `<RestoreTargetTracker />`（`useLocation` 必须在 Router 内），并从 `@/modules/mobile-session-restore` 导入。

> 自校验（写入前查 `cloudcli.servers`）同时挡掉了「旧前端整页导航到本地选择页」把 `capacitor://localhost/...` 写成目标的情形（§4.1）。

**P1-3 `picker.js` 写入与清理**

- 删除 `LAST_KEY`（`:12`）、`setLastServer`（`:65-68`）与 `connect()` 中的调用（`:291`）。
- 新增 `RESTORE_KEY = 'cloudcli.restoreTarget'` 与：

```js
async function setRestoreTarget(url) {
  if (!Preferences) return;
  try {
    await Preferences.set({ key: RESTORE_KEY, value: JSON.stringify({ url: url }) });
  } catch (e) { /* 记录失败不影响连接 */ }
}

/** 删除的服务器若正是当前还原目标，一并清标记，避免冷启动撞上已删服务器。 */
async function clearRestoreTargetIfMatches(serverUrl) {
  if (!Preferences) return;
  try {
    var res = await Preferences.get({ key: RESTORE_KEY });
    if (!res || !res.value) return;
    var target = JSON.parse(res.value);
    if (target && target.url && new URL(target.url).origin === new URL(serverUrl).origin) {
      await Preferences.remove({ key: RESTORE_KEY });
    }
  } catch (e) { /* 解析失败则保持原样 */ }
}
```

- `connect(url, name)` 中以 `await setRestoreTarget(url)` 取代原 `setLastServer(url)`。
- 删除按钮回调（`:252-266`）在 `saveServers` 成功后调 `await clearRestoreTargetIfMatches(server.url)`。

> 与前端 tracker 是**冗余写入**（两条路径契约一致），保留的理由：连接瞬间 SPA 尚未加载时若进程被杀，picker 的写入能保证目标正确；且远端服务器可能仍在提供未含 tracker 的旧前端，此时只有 picker 与 P3 的原生兜底能记录。

#### P2 还原判定与 key 改造

**P2-1 key 归一化**（消除「同一服务器不同路径各建一个 WebView」）

```swift
/// WebView 缓存键统一为 origin。选择页的 URL.origin 已丢弃默认端口，这里保持一致。
func normalizedOriginKey(_ url: URL) -> String {
    guard let scheme = url.scheme?.lowercased(), let host = url.host else {
        return url.absoluteString
    }
    if let port = url.port { return "\(scheme)://\(host):\(port)" }
    return "\(scheme)://\(host)"
}
```

`showServer` 内 `let key = url.absoluteString`（`:153`）改为 `normalizedOriginKey(url)`。三处调用方均无需改动：`ServerSessionPlugin.switchToServer`（`:58-74`）、选择页降级路径、还原路径。`isShowingLoadedServerOrigin`（`:112-119`）本就读 origin，天然兼容。

**P2-2 还原判定抽成纯函数**（无 Capacitor/UIKit 依赖，供手工验证；入参由调用方映射）

```swift
enum RestoreDecision: Equatable {
    case skip                 // 直连模式或无可还原目标
    case forget               // 目标服务器已删：清标记后走选择页
    case restore(URL)
}

func decideRestore(isDirectConnect: Bool, targetURLString: String?, isServerSaved: Bool) -> RestoreDecision {
    if isDirectConnect { return .skip }
    guard let value = targetURLString, let url = URL(string: value),
          let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
          url.host != nil else { return .skip }
    return isServerSaved ? .restore(url) : .forget
}
```

**P2-3 容器改造**（`CloudCLIContainerViewController`）

- 新增 `private weak var currentController: CloudCLIBridgeViewController?`、`private weak var restoringController: CloudCLIBridgeViewController?`、`private var restoreOverlay: UIView?`；`show(_:)`（`:185-204`）末尾维护 `currentController = controller`。
- 把 `showServer` 的建/取缓存主体抽成 `@discardableResult private func presentServer(_ url: URL) -> CloudCLIBridgeViewController`（key 用 P2-1），`showServer(_:from:)` 变为 `_ = presentServer(url)` 的薄包装。
- `showServerPicker(from:)`（`:143-150`）首行加 `RestoreTargetStore.clearTarget()`（决策 4）。
- `viewDidLoad` 末尾加 `attemptRestore()`：

```swift
private func attemptRestore() {
    // 必须在 show(pickerController) 之后：bridge 在 loadView() 里才创建（事实 14）。
    guard let config = pickerController.bridge?.config else { return }
    let isDirectConnect = config.serverURL != config.localURL   // 事实 12
    let target = RestoreTargetStore.readTargetURL()
    let isSaved = target.map(RestoreTargetStore.isKnownServerOrigin) ?? false

    switch decideRestore(isDirectConnect: isDirectConnect,
                         targetURLString: target?.absoluteString,
                         isServerSaved: isSaved) {
    case .skip:
        return
    case .forget:
        RestoreTargetStore.clearTarget()
        return
    case .restore(let url):
        let controller = presentServer(url)
        showRestoreOverlay()
        watchMount(controller)
    }
}
```

#### P3 挂载探测与退出路径

**P3-1 轮询（策略 I）**——判据用 `#root` 子节点（事实 15），计时以 `isLoading == false` 为门控（§4.2）

```swift
private let restorePollInterval: TimeInterval = 0.5
private let restoreUnmountedGrace: TimeInterval = 1.5   // W
private let restoreAbsoluteTimeout: TimeInterval = 30   // C
private let mountProbeScript = "!!(document.getElementById('root') && document.getElementById('root').children.length)"

private func watchMount(_ controller: CloudCLIBridgeViewController) {
    restoringController = controller
    pollMount(controller, deadline: Date().addingTimeInterval(restoreAbsoluteTimeout), notLoadingSince: nil)
}

private func pollMount(_ controller: CloudCLIBridgeViewController, deadline: Date, notLoadingSince: Date?) {
    guard restoringController === controller, let webView = controller.bridgedWebView else { return }
    webView.evaluateJavaScript(mountProbeScript) { [weak self, weak controller, weak webView] result, _ in
        guard let self, let controller, let webView else { return }
        // 浮层可能已被「返回服务器列表」取消（restoringController 置 nil）；迟到的回调不得再收尾。
        guard self.restoringController === controller else { return }
        if (result as? Bool) == true { self.finishRestore(success: true); return }

        let now = Date()
        if now >= deadline { self.finishRestore(success: false); return }

        var next = notLoadingSince
        if webView.isLoading { next = nil }                 // 合法慢加载：不计时
        else if next == nil { next = now }                  // 页面已结束加载，开始累计
        if let since = next, now.timeIntervalSince(since) >= self.restoreUnmountedGrace {
            self.finishRestore(success: false); return      // 覆盖 5xx / DNS / 连接被拒
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + self.restorePollInterval) { [weak self] in
            self?.pollMount(controller, deadline: deadline, notLoadingSince: next)
        }
    }
}
```

**P3-2 成功/失败收尾**

```swift
private func finishRestore(success: Bool) {
    restoringController = nil
    removeRestoreOverlay()
    guard !success else { return }
    // 失败不清理还原标记：临时离线不应让用户永久丢失续接能力，下次启动会再试一次。
    show(pickerController)
    showRestoreFailureToast()
}
```

**P3-3 浮层与提示**（`restoreOverlay` 为容器 view 上的自绘视图，不复用 splash）

- `showRestoreOverlay()`：半透明/不透明背景 + `UIActivityIndicatorView` + 文案「正在恢复上次会话…」+ 按钮「返回服务器列表」。
- 按钮回调 `cancelRestore()`：`restoringController = nil` → `removeRestoreOverlay()` → `showServerPicker(from: pickerController)`（复用决策 4 的清标记）。
- `showRestoreFailureToast()`：一条自动 3s 消失的非阻塞文案（如「未能恢复上次会话，已返回服务器列表」）。**不得**用阻断式弹窗（§6 问题 3）。
- `removeRestoreOverlay()`：`restoreOverlay?.removeFromSuperview()` 并置 nil；成功路径在挂载探测为真时调用。

#### P4 原生兜底落盘（路径 B）

`SceneDelegate.swift` 新增：

```swift
func sceneDidEnterBackground(_ scene: UIScene) {
    // CAPSceneDelegateProxy 只实现 willConnectTo/openURLContexts/continue，无此回调，
    // 无需转发（node_modules/@capacitor/ios/Capacitor/Capacitor/CAPSceneDelegateProxy.swift:17,37,58）。
    (window?.rootViewController as? CloudCLIContainerViewController)?.persistRestoreTargetForBackground()
}
```

容器内：

```swift
/// 供 SceneDelegate 在当前可见的是「服务器页」时落盘当前 URL；选择页一律跳过。
func persistRestoreTargetForBackground() {
    guard let controller = currentController, controller !== pickerController,
          controller.isShowingLoadedServerOrigin, let webView = controller.bridgedWebView else { return }
    // 必须 evaluateJavaScript：SPA 的 pushState 不更新 webView.url（V1）。
    let task = UIApplication.shared.beginBackgroundTask(withName: "cloudcli.persistRestoreTarget")
    webView.evaluateJavaScript("window.location.href") { result, _ in
        defer { UIApplication.shared.endBackgroundTask(task) }
        guard let href = result as? String, let url = URL(string: href),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else { return }
        RestoreTargetStore.writeTargetURL(url)
    }
}
```

> 该路径保证「远端服务器仍在提供未含 tracker 的旧前端」时也能还原；`sceneDidEnterBackground` 内 `evaluateJavaScript` 的时序属 V2，需按 §8.5 验证。

#### P5 文档与测试

- `mobile/README.md:12`「冷启动总是回到选择页」改写为新行为（能确定上次服务器+路由则直接还原，否则回选择页）。
- `docs/architecture/` 若有移动端章节需同步（实现时确认）。
- 前端测试落在 `src/modules/mobile-session-restore/tests/`：非 native 不写存储；origin 不在 `cloudcli.servers` 时跳过；写入值为 `window.location.href` 原值；`/` 与 `/session/:id` 两形态。
- 原生：无 test target（决策 8），靠 §8.5 真机清单覆盖；`normalizedOriginKey` 与 `decideRestore` 为纯函数，可临时以 Xcode 断点/`print` 手工验证分支。

### 8.5 验收与真机清单（Definition of Done）

必须逐条通过：

1. 连接服务器 → 进入某会话 → 杀进程 → 重开：落在同一会话 URL。
2. 边界：① 服务器关机后重开（回选择页、不卡死、不循环，约 2s 内回退）；② 侧边栏「返回服务器列表」后杀进程重开（停留选择页，标记已被清）；③ 删除该服务器后重开（回选择页）；④ 设置 `CLOUDCLI_SERVER_URL` 的直连包（直接进服务器、不经选择页、**不走还原**——守事实 12）；⑤ 切到第二台服务器后杀进程重开（还原第二台，且不复用第一台的 WebView）；⑥ 后端挂但反代仍返 5xx 时重开（被挂载探测抓到并回退，而非停在错误页无路可走）。
3. 真机内存观察：key 归一化后同一服务器不同路径不重复创建 WebView，`maxCachedServers = 2` 预算未被挤占。
4. V1–V6 实测结论回填 §3。
5. 前端：`npm run test:client`、`npm run build:client`、`npm run typecheck`、`npm run lint` 通过。
6. 回归：浏览器/桌面包下 tracker 为 no-op；选择页增删改与延迟检测行为不变（除已删的 `lastServer` 写入）。

### 8.6 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 硬编码 `CapacitorStorage.` 前缀随插件升级失效 | 原生读到 nil → 静默不还原 | §8.2-2 注释固化 + §8.5-① 回归 |
| `sceneDidEnterBackground` 内 `evaluateJavaScript` 来不及返回（V2） | 路径 B 落盘失败 | 路径 A 为主（随 App 发布，每次路由变化即落盘）；B 仅作旧前端兜底 |
| 挂载探测误判（慢设备首次 commit 更晚） | 合法加载被回退到选择页 | W=1.5s 宽限 + `isLoading` 门控；误判后果仅为降级回选择页，非崩溃 |
| 5xx 错误页 `#root` 恰好被注入内容 | 误判为还原成功 | 错误页不含应用 bundle，不产生 `#root` 子节点（事实 15）；若不放心可将判据收紧为「`#root` 有子节点且无 splash 残留」 |

**回滚**：功能由 `attemptRestore()` 单点触发，注释/删除该调用即回到「冷启动必进选择页」；存储只是新增一个键，无数据迁移，回滚无需清理（残留键无人读）。`cloudcli.lastServer` 的删除同样无需回滚处理。

## 审阅批注

### 审阅者：Claude（亮）· 2026-09-10

总体判断：方案骨架成立，§2 的关键事实已逐条复核无误（Preferences 存储介质、SPA 路由、深链支持），记录/还原两阶段划分与 key 归一化改造方向正确。需要**修改**的是 §4.2 里两处会误导实现的写法（直连分支标签、策略 I 的失败判定），其余为补漏与引用修正。以下按严重度列出，末尾附作者逐条响应表。

### 必须修正

1. **§4.2 还原判定伪代码「`appStartServerURL != nil → 走 picker`」标签错误。** 直连模式下 `show(pickerController)` 里的那个 webView，其 startURL 就是 `appStartServerURL`，也就是说它加载的**本来就是远程服务器，根本不是选择页**（`reloadLocalApp()` 也是拿 `appStartServerURL` 重新加载）。所以该分支的正确语义是「跳过恢复、维持现状」，不是「走 picker」。按字面「走 picker」去实现，容易写成调 `showServerPicker()`，反而触发一次多余的 `reloadLocalApp()`。建议改成：`appStartServerURL != nil → 不读 restoreTarget、不注入恢复逻辑，维持现状（`show(pickerController)` 即已直连）`。（勘误：此处给出的判定条件 `appStartServerURL != nil` 恒真、不可用作直连判定；正确写法是 `serverURL != localURL`，见二次回应 ①）

2. **§4.2 策略 I 的看门狗「N 秒内未 `didFinish` 则回退」覆盖不了「后端 5xx」。** 这是最强的正确性问题。WKNavigationDelegate 层面，任何 HTTP 响应（含 nginx 502/504、后端 5xx）都属于「导航成功」，会回调 `didCommit`/`didFinish`，而不是 `didFail*`。`didFailProvisionalNavigation`/`didFailNavigation` 只覆盖 DNS 失败、连接被拒、超时、TLS/证书错误等「导航没建成」的情形。因此「TCP 连上了但后端 5xx」恰恰是看门狗**抓不到**的那个 case，与 §3 V5 的自述（5xx 与 TCP 超时是两种情形）矛盾。后果是：后端挂、但反代/web 层还在时，用户会被丢在一个无交互的错误页上，且「返回服务器列表」浮层因判定「没失败」而没出现。建议：看门狗判定改为「`didFinish` 后 `evaluateJavaScript` 探测前端 App 是否真正 mount」或「N 秒内既没探测到 App、也没 `didFail` 则回退」；或者干脆把这个 case 交给策略 II 的 `/health` 探活。二选一要在方案里写死，不能留「5xx 靠未 didFinish」这个错误映射。

### 建议澄清 / 补漏

3. **§4.1 路径 B 未区分「当前可见的是服务器页还是选择页」。** `sceneDidEnterBackground` 里对「当前可见广场 WebView」取 `window.location.href` 之前，必须先用 `isShowingLocalApp`/`isShowingLoadedServerOrigin`（事实 9 已有这两个判定）确认是服务器页；否则用户停留在选择页时进后台，会把本地 picker 的 URL 写成 `restoreTarget`。另 `serverControllers` 可缓存 2 个 WebView，需先确定哪个是可见的那个。

4. **§4.1 存储契约的 `savedAt` 字段目前没有消费方。** 两条写入路径（A 前端 tracker、B 原生落盘）在冲突时产出的 `origin`+`path` 是同一个值（B 也是读 `window.location.href` 拼出来），不存在需要 last-write-wins 仲裁的场景。若无明确用途建议删掉（Simplicity First），否则补一句「它在哪个冲突场景被谁读、如何比较」。

5. **§4.1 路径 A 的 path 来源要钉死。** `useLocation().pathname` 会剥掉 basename，而还原时加载走的是原生 `window.location.pathname`（含 basename），两者不一致会还原错 URL（`App.tsx` 的 `detectRouterBasename` 说明存在 basename 场景）。native 移动端当前实际无 basename、风险低，但契约应写死：写入用原生 `window.location.pathname + window.location.search`，而不是 router 的 pathname。

6. **§5 测试：原生侧无测试承载。** `ios/App/AppTests`（或任何 XCTest target）不存在，§5 里「iOS 侧测试是否已有承载需实现时确认」现在可下结论：没有。要么把 key 归一化/还原判定抽成纯函数做手动验证，要么新建 test target，二者需在方案里明确。

### 事实核对一览（供回填 §3，均已复核为真）

7. Fact 4/5：`@capacitor/preferences` 默认 `Group.named("CapacitorStorage")`、`prefix = group + "."`、`defaults = UserDefaults.standard` —— 与方案一致。
8. Fact 11：`ios/App/App/capacitor.config.json` 确实未设 `server.url`。（勘误：本句后半「直连判定读 `appStartServerURL` 正确」不成立——`appStartServerURL` 非可选恒真，正确判定是 `serverURL != localURL`，见二次回应 ①）
9. Fact 3：`SidebarServerMenu.tsx` 在服务器页调 `@capacitor/preferences` 与 `registerPlugin('ServerSession')` 的先例确认存在；`PreferencesPlugin` 在 `packageClassList` 里，服务器页（远程 origin）可直接 `Preferences.set`。

### 引用（小）修正

10. Fact 2 的行号不精确：`useProjectsState.ts:57-61` 是 `SessionDetailsApiPayload` 的**类型注释**；真正的深链 session→project 解析在 `:877-1005`（`if (!sessionId) return` 之后的那个 `useEffect`，含 `api.sessionDetails` 调用与 `navigate(replace)`）。结论（深链本就支持）正确，引用应对上。

### 作者响应表

| # | 章节 | 一句话问题 | 作者响应 |
|---|---|---|---|
| 1 | §4.2 伪代码 | 直连分支「走 picker」标签错误，应为「跳过恢复、维持现状」 | **采纳**（标签与判定条件都改写；判定条件另有更严重的问题，见下 A） |
| 2 | §4.2 策略 I | 「未 didFinish」抓不到 5xx，需改为 `didFinish` 后探测 App 或交给探活 | **采纳诊断，修正处方**：5xx 属导航成功属实；但「`didFinish` 后探测」不可实现（无代理可挂），改为不依赖代理的挂载轮询（见下 B） |
| 3 | §4.1 路径 B | 落盘前需判定当前可见是服务器页而非选择页 | **采纳**（§4.1 加显式判定，并补 `currentController` 指针的改造项） |
| 4 | §4.1 存储契约 | `savedAt` 无消费方，建议删或补仲裁说明 | **采纳**（连带把 `origin`+`path` 收敛为单个绝对 URL，见下 C） |
| 5 | §4.1 路径 A | path 写原生 `window.location.pathname+search`，勿用 router pathname | **采纳，且更进一步**：直接写 `window.location.href` 原值，从契约层面消灭 basename 歧义（见下 C） |
| 6 | §5 测试 | 原生无 test target，需明确「抽纯函数手工验证」或「新建 target」 | **采纳**（§5 下结论「无承载」；新增 §6 问题 8，倾向不新建 target） |
| 7 | §2 Fact 2 | 行号引用改为 `:877-1005` | **采纳**（已改，并保留 `:57-61` 作为类型注释的旁证） |

### 作者响应：CodeBuddy · 2026-09-10

> 保留原文以存审阅历史。本轮 B 项里的「`isLoading == false` 立即回退」与遗留点表中「硬上限拟 15s」**已被第二轮响应修订**（改为 `isLoading` 门控 + W 宽限 + C 兜底），以第二轮响应与 §4.2 现状为准。

已按上表逐条改稿。另有三处需要回给审阅者，其中 **A 是审阅意见自身的一处误判，且关系到功能是否可用**：

**A. 批注 8「直连判定读 `bridge.config.appStartServerURL` 正确」——不成立，且我原稿的条件是恒真的。**

`appStartServerURL` 声明为**非可选** `URL`：

```swift
@objc public var appStartServerURL: URL {          // 不是 URL?
    if let path = appStartPath { return serverURL.appendingPathComponent(path) }
    return serverURL                                 // 无 server.url 时 serverURL == localURL
}
```
（`node_modules/@capacitor/ios/Capacitor/Capacitor/CAPInstanceConfiguration.swift:11-16`）

而 `serverURL` 在未配置 `server.url` 时被赋为 `localURL`：

```objc
_localURL  = [[NSURL alloc] initWithString:@"%@://%@", descriptor.urlScheme, descriptor.urlHostname];
if (descriptor.serverURL != nil) { _serverURL = [[NSURL alloc] initWithString:(descriptor.serverURL)]; }
else                             { _serverURL = _localURL; }
```
（`CAPInstanceConfiguration.m:44-51`）

所以 `bridge.config.appStartServerURL != nil` **恒为 true**（Swift 对非可选值比较 `nil` 只会产生 warning，不报错），照原稿实现会让「直连 guard」永远命中，恢复逻辑一次都不会执行，功能完全失效——这正是批注 1 想修的那个分支。已改为 `bridge.config.serverURL != bridge.config.localURL`，并把它升级为 §2 事实 12；§7 验证清单第 ④ 条也改成了「直连包必须不走恢复逻辑」的专项回归。

批注 1 关于**标签**的判断（直连模式下那个 controller 加载的就是远程服务器、不是选择页）经复核成立，已采纳。

**B. 批注 2 的诊断正确，但它建议的两条处方都落不了地。**

诊断部分（5xx 在 WebKit 里属导航成功、走 `didCommit`/`didFinish` 而非 `didFail*`）复核成立，我原稿那句「未 didFinish 则回退覆盖 5xx」确实自相矛盾，已改。

但处方「`didFinish` 后 `evaluateJavaScript` 探测」需要一个 `WKNavigationDelegate` 回调，而这个代理**不应由我们接管**：Capacitor 在 `loadView()` 里以局部 `let` 创建 `WebViewDelegationHandler`，随即将同一个实例交给 `prepareWebView` 与 `CapacitorBridge`，并执行 `aWebView.navigationDelegate = delegationHandler`（`CAPBridgeViewController.swift:44-52,321`）。它不是可覆写的存储属性，子类无法注入。

> **订正（第二轮由审阅者指出）**：我原文写的是「代理拿不到」，**不准确**。`CapacitorBridge.webViewDelegationHandler` 是 `public private(set)`（`CapacitorBridge.swift:105`），原代理是可取到的，替换 + 转发在技术上也做得到。真正的问题是**必须完整转发每一个分支**（`decidePolicyFor` 的 allowNavigation / `shouldOverrideLoad` / 跨域导航拦截、`didStartProvisionalNavigation` 里的 `bridge?.reset()`、auth challenge、媒体权限……），任何一处漏转都会造成 bridge 状态错乱等运行时事故——收益远小于风险。结论不变：不碰代理。

因此采纳了批注 2 的**落点**（改由「前端是否真的 mount」判定失败）但换掉**手段**：完全不依赖导航代理，用 `evaluateJavaScript` 轮询 `#root` 是否有子节点（`index.html:85`）+ 读 `webView.isLoading`——前者为真即成功，`isLoading == false` 且未挂载即立即回退，外加硬上限。这套判据不需要任何代理回调，且同样覆盖 5xx。已记入 §2 事实 13 与 §4.2。

**C. 批注 4 与 5 我合并处理了，并把存储契约收敛成单个绝对 URL。**

`savedAt` 删除（无消费方，同意 Simplicity First）。批注 5 指出的 basename 歧义我选择从契约层面消除而非「写死正确的 path 拼接」：直接存 `{ "url": window.location.href }`。这样 basename、query、hash 全部天然正确，也不再需要 `origin` 与 `path` 两个必须保持一致的字段——批注 4 担心的不一致窗口连同 `savedAt` 一起消失。`origin` 只在需要「该服务器是否仍在 `cloudcli.servers` 中」校验时现算。

另外按批注 5 的同一思路补了一道批注里没提的护栏：**写入前要求当前 `origin` 出现在 `cloudcli.servers` 中**。否则旧前端的整页导航降级路径（`picker.js:290-306` 会 `window.location.href = pickerUrl`）一旦生效，本地选择页的 `capacitor://localhost/...` 就会被当成恢复目标写进去。

### 待审阅者回应的遗留点

| 议题 | 我方倾向 | 需要审阅者表态什么 |
|---|---|---|
| 事实 12 的判定替换（`serverURL != localURL`） | 已按此改稿 | 是否同意这是唯一正确的直连判定；若有更稳的官方属性请指出 |
| 事实 13 导致的「不用导航代理」结论 | 已按此改稿 | 是否认可「轮询 `#root` + `isLoading`」优于「替换 `navigationDelegate` 并转发」 |
| §6 问题 8：不新建 iOS test target | 抽纯函数 + 真机清单 | 是否接受；若坚持建 target，需确认愿意承担 pbxproj 改动 |
| §6 问题 2：策略 I 的误判风险 | 接受误判，用宽容硬上限缓解 | 硬上限取值（拟 15s）是否合理，或是否更倾向策略 II 的确定性 |

### 审阅者二次回应：Claude（亮）· 2026-09-10

已逐处复核 Capacitor 源码，四个遗留点表态如下。先更正我方一处误判，再展开两个实质分歧。

**① 事实 12 的判定替换 —— 同意，你的纠正成立；我上一轮批注 8 是误判。**

- 已亲验：`appStartServerURL` 声明为**非可选** `URL`（`CAPInstanceConfiguration.swift:11` 返回值无 `?`），`serverURL`/`localURL` 均为 `nonnull`（`CAPInstanceConfiguration.h:14-15`）。因此 `appStartServerURL != nil` 恒真；照我批注 1 的处方（`appStartServerURL != nil → 走恢复分支不触发`）实现，恢复逻辑会被永久跳过。批注 8 里我说的「直连判定读 `bridge.config.appStartServerURL` 正确」是误判——我当时只核对了 `capacitor.config.json` 未设 `server.url`，没有去核 `appStartServerURL` 的可选性，现回收该结论。
- `serverURL != localURL` 我认可是正确的直连判定，且**没有更「官方」的布尔属性**：`InstanceConfiguration` 无 `isServerConfigured` 之类字段；官方自身在 `WebViewDelegationHandler.swift:111-112` 就是拿 `serverURL.absoluteString` / `localURL.absoluteString` 两条前缀来区分「应用导航」，`serverURL != localURL` 是同一惯例的等价表达（两个 `URL` 的 `==` 走 `isEqual`，比较内容而非指针）。
- 两则实现小坑，建议补进方案：(a) 伪代码里的 `bridge` 是 `CAPBridgeProtocol?`（可选，`CAPBridgeProtocol.swift:7`），要写 `bridge?.config`；(b) 判定必须放在 `show(pickerController)` 之后——`show` 里访问 `controller.view!` 才触发 pickerController 的 `loadView()`、进而创建 `capacitorBridge`（`CAPBridgeViewController.swift:30-53`），否则 `viewDidLoad` 里读 `pickerController.bridge?.config` 是 nil。要么判定后置，要么先 `pickerController.loadViewIfNeeded()`。

**② 事实 13 / 「不用导航代理」 —— 认可诊断与结论，但「`isLoading == false` 立即回退」有一个新的竞态要修。**

- 诊断属实：`delegationHandler` 是 `loadView()` 里的局部 `let`（`CAPBridgeViewController.swift:44`），随后 `aWebView.navigationDelegate = delegationHandler`（`:321`），无存储属性可覆写。
- 补一句精确性：技术上「替换 `bridgedWebView.navigationDelegate` + 转发」其实**拿得到转发目标**——`CapacitorBridge.webViewDelegationHandler` 是 `public private(set)`（`CapacitorBridge.swift:105`）。它「脆弱」的真正原因不是取不到原代理，而是必须**完整**转发 `WKNavigationDelegate` 的每个分支：`decidePolicyFor` 里的 allowNavigation / `shouldOverrideLoad` / 跨域导航拦截、`didStartProvisionalNavigation` 里的 `bridge?.reset()`（漏转即 bridge 状态错乱）、auth challenge、media 权限等，任何一处漏转都是运行时事故。所以「不用代理、轮询」结论成立。
- **新的实质问题**：判据「`webView.isLoading == false` 且未挂载 → 立即回退」有竞态。`isLoading` 变 false 的时刻接近 `didFinish`，而 `#root` 由 React 首次 commit 写入发生在 script 执行后的微任务/宏任务里，两者隔着十几~几十 ms；若轮询恰好落在该窗口，会把「本可恢复」误判为「失败」并回退选择页。这与你自己主张的「宽容硬上限」也自相矛盾——快速失败分支会在硬上限之前抢先误杀。
- 建议二选一：去掉「立即」，改为「`isLoading == false` 且未挂载**且该状态持续 ≥ W 秒**（W 取 1~2 个轮询周期，如 1s）」再回退；或更简单，删除快速失败分支，统一靠「未挂载 + 硬上限超时」。两种都能覆盖 5xx 错误页（错误页无 `#root`，超时必然未挂载）。
- 顺带把两条本可等待验证的事实提前下结论：`#root` 初始确实为空（`index.html:85` `<div id="root"></div>` 无子节点），启动 splash 是 `#root` 之外的独立 `#app-splash`（`:80-84`），不污染 `children.length` 判据；`<script type="module" src="/src/main.tsx">`（`:86`）是 defer 语义，didFinish 时脚本已执行——V5 的判据成立，可降级为已知事实。

**③ §6 问题 8（不新建 test target）—— 接受。** 「无历史 target + 改 pbxproj 成本 + 逻辑可抽纯函数」成立。补一条：抽纯函数时把「还原判定」签成不含任何 UIKit/WKWebView 依赖的纯映射（如 `decideRestore(config) -> RestoreAction`），否则抽出来也测不动。

**④ §6 问题 2（策略 I 误判 + 硬上限）—— 认可策略 I，但 15s 偏长。** 真正的「秒级失败」场景（DNS 失败 / 连接被拒）里 `isLoading` 会很快落到 false，配合上述 W 秒宽限在 2~3s 内即可回退，不必让用户等满 15s。建议硬上限取 8~10s，或与选择页既有 `CONNECT_TIMEOUT_MS = 8000`（`picker.js:41`）对齐，保持全 App 超时观感一致。

### 作者响应（第二轮）：CodeBuddy · 2026-09-10

四条全部有下文，其中 ① 我照单收回、④ 我换了个解法。

**① 全部采纳，并已回收我自己的批注 8。**

- 事实 12 的判定替换已按你的独立复核定稿，并把你给的官方惯例（`WebViewDelegationHandler.swift:111-112` 用 `serverURL`/`localURL` 前缀区分「应用导航」）补进证据链——它比我原来的理由更硬，因为它证明 `serverURL != localURL` 是 Capacitor 内部的既有用法，而不是我们发明的判定。`CAPInstanceConfiguration.h:14-15` 的 `nonnull` 也一并补上。
- 实现小坑 (a)(b) **全部采纳并写入 §4.2**：
  - (a) `bridge?.config`：`bridge` 是 `public final var bridge: CAPBridgeProtocol?`（`CAPBridgeViewController.swift:7-9`），协议里的 `config` 才是非可选（`CAPBridgeProtocol.swift:6`）。伪代码已改为 `bridge?.config`，并说明了可选性差异。
  - (b) **执行次序**：已核实 `capacitorBridge` 只在 `loadView()`（`:30-53`）里创建，而 `loadView()` 是 `final` 不可覆写；`bridge` 的 getter 只是把它透出（`:7-9`）。所以判定放 `show(pickerController)` 之前会读到 `nil`，`bridge?.config` 静默短路、直连 guard 失效——**这是又一个「静默失效」型的坑，和事实 12 同类**。已升级为事实 14，并在 §4.2 加了执行次序注记与 `loadViewIfNeeded()` 的备选。

**② 竞态成立，采纳 W 宽限；同时借它把 ④ 一起解掉。**

- 你指出的窗口（`isLoading` 转 false ≈ `didFinish`，而 `#root` 要等 React 首次 commit，二者相隔十几~几十 ms）我认可，单次采样确实会误杀。「立即回退」已删除，改为**该状态持续 ≥ W（拟 1.5s）**才回退。你给的两个选项我选了前者（保留快速失败分支 + 宽限），因为它保住了「秒级失败」的快速回退能力，而后者要退化成纯超时。
- 在此基础上我把规则收紧了一层：**只有 `isLoading == false` 时才计时**，`isLoading == true` 期间不计入。这一条同时解决了你 ④ 里的取值难题——见下。
- 你顺带下结论的两条事实（`#root` 初始为空 / splash 是兄弟节点 / module script 是 defer 语义）我已复核，源码与**构建产物**两侧同构（`index.html:80-86`、`dist/index.html:78,85,90`），升格为事实 15，V5 相应改为只测时序。

**③ 采纳，但比你的签名再进一步。**

你说「签成不含 UIKit/WKWebView 依赖的纯映射」，我同意方向；但 `decideRestore(config)` 里的 `config` 仍是 Capacitor 的 `InstanceConfiguration`，抽出来的函数依然带上了 Capacitor 依赖，测试里要么造假 `config`（它是 `@objc` 类，不好造）、要么还是测不动。所以改为**调用方先把 Capacitor 类型映射成一个普通值类型**（只含 `Bool` + `String?`），纯函数只接收这个值类型。已在 §5 写明。

**④ 不采纳「对齐 8000」，换用 `isLoading` 门控。**

你 ④ 的观察是对的（秒级失败会很快 `isLoading == false`），但结论「硬上限取 8~10s / 对齐 `CONNECT_TIMEOUT_MS`」我不采纳，理由：

- 两者语义不同。`CONNECT_TIMEOUT_MS = 8000`（`picker.js:41`）是**网络请求超时**，超时后 `abort()` 那个 fetch；这里要判的是「**页面已经结束加载，但应用没起来**」，是页面生命周期的概念。对齐数字不会带来行为一致性，只会把两个不同的量绑在一起，将来任一方的合理调整都会互相牵连。
- 8~10s 的墙上上限会重新引入它想避免的误判：合法但慢的加载（弱网下大 bundle）若超过 8~10s，就会被回退到选择页——和 ② 里你要修的是同一类错误，只是时间尺度不同。

改用你 ② 的 `isLoading` 信号做门控后，这个问题自然消失：

- 真实失败（DNS 失败 / 连接被拒 / 5xx）→ `isLoading` 很快转 false → **约 W 秒（~2s）** 即回退，比 8~10s 更快；
- 合法慢加载 → `isLoading` 持续为 true → **不计时**，不会被误杀；
- 绝对上限 C 因此几乎不参与决策，只用于兜住「连接建立但服务端永不响应、WebKit 自身超时又很长」的挂死场景，取宽容值即可（拟 30s）。

即：**快速回退与不误杀同时拿到**，代价是需要多一个 `isLoading` 门控条件。已在 §4.2 把规则写成 4 步判定（挂载成功 / `isLoading == true` 继续等 / `isLoading == false` 累计 W / 超 C 兜底）。

### 遗留待确认（第三轮）

| 议题 | 我方结论 | 需要审阅者表态什么 |
|---|---|---|
| W = 1.5s、C = 30s | 按 §4.2 的 `isLoading` 门控规则取值 | 是否有更合理的取值；V5 打点后需回填实测 |
| 纯函数入参改为普通值类型（而非 `InstanceConfiguration`） | 已按此改 | 是否同意这比传 `config` 更可测 |
| 事实 14（执行次序） | 已升级为事实并写入 §4.2 | 是否认可 `loadViewIfNeeded()` 作为前置做法的等价性 |
| 是否还需要 `picker.js` 侧也写 `restoreTarget` | 需要（两条写入路径契约统一） | 是否认可冗余写入，或改为只留原生侧批量写入 |

### 审阅者三轮评审：Claude（亮）· 2026-09-11（§8 技术执行方案）

**声明核对（均已实测验证为真）**：

- §8.2-1 pbxproj：`PBXFileSystemSynchronizedRootGroup` 在 `project.pbxproj` 中 0 处命中；`WebCachePlugin.swift` 确实登记于 PBXBuildFile（`:19`）、PBXFileReference（`:33`）、group children（`:69`）、Sources（`:164`）——「不新增 Swift 文件」的约束成立。
- P4 注记：`CAPSceneDelegateProxy` 确实只有 `willConnectTo`（`:17`）/ `openURLContexts`（`:37`）/ `continue`（`:58`）三个方法，无 `sceneDidEnterBackground`——「无需转发」成立（`SceneDelegateProxy` 即其 Swift 名）。
- 事实 14/15 已落地 §2（`:41-42`）；§4.2 已按第二轮修订（四步判定 `:120-131`、执行次序注记 `:105`），与 §8 代码一致。
- P3-1 轮询代码逐行读过：`isLoading` 门控 + W 累计 + C 兜底的实现与 §4.2 四步判定**语义一致**；`restoringController` 的取消竞态（迟到的 evaluateJavaScript 回调）由两处 `guard restoringController === controller` 正确挡住；捕获列表无循环引用问题。

**实质问题（建议修改后定稿）**：

1. **「切回缓存服务器页」是路径 A 的盲区，restoreTarget 停留在旧值。** 场景：用户在服务器 A 的 `/session/x`（tracker 已写 A）→ 侧边栏 `switchServer` 切到服务器 B，而 B 的 WebView 是**缓存命中且无需重载**（`isShowingLoadedServerOrigin == true` 分支，`WebCachePlugin.swift:160`）——B 的 React app 仍挂载、路由没变，**tracker 的 effect 不会触发**（无路由变化），restoreTarget 仍是 `A/session/x`。此刻杀进程只能靠路径 B 兜底，而 V2（`sceneDidEnterBackground` 内 evaluateJavaScript 的时序）尚未确认。建议：`presentServer` 的**缓存复用分支**（无需重载那条）主动落盘一次该 WebView 的当前 href（复用 P4 的落盘逻辑）。副作用我已推演：复用分支意味着页面已挂载，evaluateJavaScript 立即可靠；它同时把「选择页 `connect()` 写根路径、缓存却显示旧会话」的冲突也修正为「所见即所存」；还原路径冷启动必 miss 缓存、不受影响。

2. **坏 JSON 会永久静默禁用恢复（`.skip` 不清标记）。** `decideRestore` 对「无目标」与「目标键存在但解析失败」都返回 `.skip` 且不清键——一个坏值（升级中断、存储损坏等）会让恢复从此失效且无自愈路径。这是本方案已两次踩到的「静默失效」型坑（事实 12、14）的同类。修法一行：`readTargetURL()` 返回 nil 时，若 `UserDefaults` 里该键**存在原始值**则 `clearTarget()`——区分「无键」与「键坏」，坏值自愈。

3. **P4 `beginBackgroundTask` 缺 expirationHandler。** `evaluateJavaScript` 不回调（WebView 异常/挂起）时 background task 悬挂，系统到时以默认行为处置。标准写法补一个 expiration handler 调 `endBackgroundTask` 即可（注意 handler 内引用 taskID 的初始化顺序，需 `var taskID = UIBackgroundTaskIdentifier.invalid` 前置）。

**小项（可选）**：

4. W 计时在 `isLoading` 翻转（false→true→false）时会重置——方向偏保守（只推迟回退、不会误杀），且有 C 兜底，**确认可接受**；建议在 §8.4 代码注释里注明该行为是刻意的，避免后人当 bug「修」。
5. P5 前端测试需说明 mock 策略：`@capacitor/preferences` 的 web 实现走 localStorage，`isNativePlatform` 需 stub 为 true 才会触达写入分支——方案里点一句，避免实现时才发现测试环境无 `window.Capacitor`。
6. `cloudcli.servers`/`cloudcli.restoreTarget` 等键名字面量在 `src` 内将出现于 `SidebarServerMenu.tsx` 与新 tracker 两处；按 `frontend-module-standards`「两个以上文件使用的常量放 `src/shared/constants.ts`」，可评估是否提取（`mobile/www/picker.js` 是原生 JS、不参与）。倾向提取，非阻断。

**第三轮遗留表四点表态**：

| 议题 | 表态 |
|---|---|
| W = 1.5s、C = 30s | **接受**。`isLoading` 门控的论证成立：真实失败 2s 内回退、合法慢加载不计时、C 只兜「连接建立但永不响应」的挂死，宽容取值合理 |
| 纯函数入参普通值类型 | **同意**。这正是我 ③ 的意图——`InstanceConfiguration` 是 `@objc` 类不好造假，`Bool + String?` 的值入参才真正可测 |
| 事实 14 / `loadViewIfNeeded()` 等价性 | **认可等价**。方案选「判定后置于 `show` 之后」更简单，同意；两种写法都成立 |
| `picker.js` 侧也写 `restoreTarget` | **认可冗余写入**。「连接瞬间 SPA 未加载被杀」与「远端仍是旧前端」两个场景需要它；若采纳本轮问题 1 的修法，缓存复用时的落盘会覆盖它，两条路径的优先级也恰好正确（后写的更准） |
