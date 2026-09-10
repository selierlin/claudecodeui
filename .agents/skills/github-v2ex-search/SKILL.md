---
name: github-v2ex-search
description: 在 GitHub、V2EX 或互联网上搜索资料/话题/项目/插件/配置时使用。按站点分层选路：搜 GitHub 优先已认证的 gh CLI，其次模型自带 websearch，最后 curl + REST API 兜底；搜 V2EX 优先 websearch，其次 curl（DDG 站外搜 + 官方 API）。含本机网络经验：v2ex.com 直连不通，需走本地代理 127.0.0.1:7890（HTTP）/7891（SOCKS5）或镜像 global.v2ex.co；WebFetch 不吃本地代理。适用于"搜一下 GitHub/V2EX 上有什么"、"找某主题的配置/插件/扩展"、"查某项目仓库信息"、"看 V2EX 最近/热门话题"等场景。
allowed-tools:
  - Bash
  - Read
---

# GitHub / V2EX 网络搜索（按站点分层：gh > websearch > curl）

目标：以最小 token、最快速度搜到 GitHub、V2EX 上关于某主题的信息。

## 核心决策流程（先判断再动手）

**按站点区分优先级，不统一套一层策略：**

```
搜 GitHub：gh CLI（已认证） > 模型自带 websearch > curl + REST API
搜 V2EX ：模型自带 websearch > curl（DDG 站外搜 + 官方 API）
```

```
搜 GitHub：
1. 本地 gh 是否已认证（gh auth status 通过）？
   ├─ 有 → 用 gh（5000 次/时限流、相关度索引、结果最全，比通用搜索精准）
   └─ 没有 → 继续
2. 模型自带 websearch？
   ├─ 有 → 调用它，失败/限流/结果为空则继续
   └─ 没有 → 继续
3. curl + REST API 兜底（匿名 60 次/时，省着用）

搜 V2EX：
1. 模型自带 websearch？
   ├─ 有 → 调用它，失败/限流/结果为空则继续
   └─ 没有 → 继续
2. curl：DDG 站外搜索找帖子 + V2EX 公开只读接口读正文（V2EX 无专用 CLI，也无正式搜索 API）
```

> 为什么 GitHub 上 gh 优先于 websearch：gh 针对 GitHub 专门优化（已认证高限流、真实搜索索引、结果只含仓库/代码/issue），通用 websearch 会混入无关网页。V2EX 没有专用工具，websearch 才是首选。

## 一、GitHub 搜索

### 首选：gh CLI（已认证时）

检查认证：`gh auth status`（本地账号 selierlin 已用 keyring 认证，token 含 repo/read:org 权限）。

常用命令（全部输出 JSON，直接 python 解析）：

```bash
# 搜索仓库（支持自然语言，按 star 排序）
gh search repos "<关键词>" --limit 10 --sort stars --json fullName,stargazersCount,description

# 搜索代码
gh search code "<关键词>" --limit 10 --json repository,path

# 搜索 issue / PR
gh search issues "<关键词>" --json repository,title,state
gh search prs "<关键词>" --json repository,title,state

# 单仓库详情
gh repo view <owner>/<repo> --json stargazerCount,description,updatedAt,language

# 列组织仓库
gh repo list <org> --limit 30 --json name,description,stargazerCount

# 列仓库目录 / 读文件（替代 contents + raw 两个 curl 端点）
gh api repos/<owner>/<repo>/contents/<path>
gh api repos/<owner>/<repo>/contents/<path> --jq .content | base64 -d   # 文件内容(base64)
gh api repos/<owner>/<repo>/forks --jq '.[] | .full_name'

# 任意 REST 端点（gh api 通吃，且带认证）
gh api "search/repositories?q=<关键词>&sort=stars" --jq '.items[] | "\(.stargazers_count)★ \(.full_name)"'
```

> gh 的优势：OAuth 认证 → 限流 5000 次/时（匿名 curl 只有 60 次）；`gh search` 用真实搜索索引（相关度排序），能搜到匿名 API 搜不到的仓库。

### 回退：curl + REST API（gh 不可用时）

匿名限流 60 次/小时，尽量少而精地调用。

### 常用端点

```bash
# 1) 搜索仓库（q 语法：关键词 + sort/stars）
curl -s "https://api.github.com/search/repositories?q=<关键词>&sort=stars&order=desc&per_page=10"

# 2) 列某组织/用户的仓库
curl -s "https://api.github.com/orgs/<org>/repos?per_page=30&sort=updated"

# 3) 单仓库详情（star 数、描述、更新时间）
curl -s "https://api.github.com/repos/<owner>/<repo>"

# 4) 列仓库某目录结构（找 docs/ 等）
curl -s "https://api.github.com/repos/<owner>/<repo>/contents/<path>"

# 5) 取仓库内文件原文
curl -s "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>"

# 6) 最近 fork（找第三方衍生/本地化项目）
curl -s "https://api.github.com/repos/<owner>/<repo>/forks?sort=newest&per_page=30"
```

### 限流与踩坑

- **search 端点最容易限流**（共享 IP 额度），返回 `{"message":"API rate limit exceeded"}`。遇到就改走不需要 search 的端点：org 仓库列表、单仓库详情、fork 列表。
- 结果解析统一用 `python3 -c "import json,sys; ..."` 一行搞定，别写临时文件。
- `raw.githubusercontent.com` 返回纯文本，适合快速读 README / 配置文件。

### 解析示例

```bash
curl -s "https://api.github.com/search/repositories?q=pi-coding-agent&per_page=10" | python3 -c "
import json,sys
for r in json.load(sys.stdin).get('items',[]):
    print(f\"{r['stargazers_count']:>5}★ {r['full_name']} - {r.get('description') or '无描述'}\")"
```

## 二、V2EX 搜索（websearch 首选，curl 两步走）

V2EX 没有专用 CLI。**首选模型自带 websearch**（搜 `site:v2ex.com <关键词>`）；不可用/失败/限流时再走 curl。V2EX 站内搜索 `/search` 需要登录（直接 302 跳登录页），所以 curl 方案是：

### 第零步：先解决网络可达性（本机 `v2ex.com` 直连不通）

**本机直连 `www.v2ex.com` 会失败**（TCP 443 超时，curl 返回 `000`）。诊断结果：

| 主机 | DNS | TCP 443 | 说明 |
|---|---|---|---|
| `www.v2ex.com` | `104.244.45.246`（自有单 IP） | **FAIL** | 主站无 CDN，单 IP 被阻断 |
| `global.v2ex.co` | `104.26.x` / `172.67.x`（Cloudflare） | OPEN | 官方备用域名，直连可用 |
| `cn.v2ex.com` / `global.v2ex.com` / `s.v2ex.com` | — | FAIL | 本机均不通 |

所以有三种走法，**优先代理（能拿主站真实数据）**：

```bash
# 方式 1（首选）：本地代理 —— 本机已跑 Clash 风格代理
curl -s -m 25 -x http://127.0.0.1:7890 "https://www.v2ex.com/api/topics/hot.json"
curl -s -m 25 --socks5-hostname 127.0.0.1:7891 "https://www.v2ex.com/api/topics/hot.json"
# 或给当前 shell 全局设上（后续 curl 自动走代理）
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890

# 方式 2：换官方镜像域名（无需代理，但可能拿到的是缓存数据）
curl -s -m 25 "https://global.v2ex.co/api/topics/hot.json"
```

> 代理端口：**`7890` 是 HTTP，`7891` 是 SOCKS5**。用 `-x http://...:7891` 会 `000`，SOCKS5 必须用 `--socks5-hostname`。
> 实测走代理访问主站 `hot.json`：HTTP 代理 0.36s / SOCKS5 0.23s，均 200。
> **WebFetch 工具不吃本地代理**（走它自己的网络栈），所以即便代理开着，WebFetch `www.v2ex.com` 仍会 `fetch failed`——抓 V2EX 一律用 Bash + curl。

### 第一步：DDG 站外搜索找帖子链接

```bash
curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
  "https://html.duckduckgo.com/html/?q=site%3Av2ex.com+<关键词>"
```

> 说明：
> - 用 **html.duckduckgo.com/html/**（HTML 版，匿名可抓），不要用 duckduckgo.com JSON API（已关闭）。
> - 关键词 URL 编码：`site:v2ex.com+pi+coding+agent`（`+` 表空格）。
> - **不要用 Bing**：搜 `pi` 会被数学常数 π 污染，全是圆周率网站。
> - DDG 连续多次请求会 202 限流，间隔开、少打几发。

解析（提取标题 + 帖子 id）：

```bash
python3 -c "
import re,html as h
doc=open('/dev/stdin').read()
for u,t in re.findall(r'<a rel=\"nofollow\" class=\"result__a\" href=\"([^\"]+)\">(.*?)</a>',doc):
    print(re.sub('<[^>]+>','',t).strip(), '|', re.search(r'v2ex\.com/t/(\d+)',h.unescape(u)).group(1))"
```

### 第二步：V2EX 公开只读接口读帖子正文

> 注意：V2EX 没有正式文档化的官方 API，`/api/` 下是网页端自用的**非正式只读接口**（无文档、无搜索能力、仅支持按 id/username 取数）。用它读正文没问题，但别依赖它做搜索。

```bash
curl -s -m 25 -x http://127.0.0.1:7890 "https://www.v2ex.com/api/topics/show.json?id=<帖子id>"
```

返回 JSON 含 `title / content / member / replies / created`，用 python 解析。拿到帖子 id 后可批量取多个：

```bash
for id in 1234709 1240364; do
  curl -s -m 25 -x http://127.0.0.1:7890 "https://www.v2ex.com/api/topics/show.json?id=$id" | python3 -c "
import json,sys
t=json.load(sys.stdin)[0]
print('标题:', t.get('title'))
print('内容:', (t.get('content') or '')[:300])"
done
```

### 第三步：看"最近有什么话题"（列表接口，不需要搜索）

用户问"V2EX 最近/热门有啥话题"时，别用 DDG，直接打两个列表接口（同样是只读非正式接口，免鉴权）：

```bash
curl -s -m 25 -x http://127.0.0.1:7890 "https://www.v2ex.com/api/topics/hot.json"    # 热门（约 10 条）
curl -s -m 25 -x http://127.0.0.1:7890 "https://www.v2ex.com/api/topics/latest.json" # 最新（约 40 条）

# 解析：标题 / 节点 / 回复数 / 链接
python3 -c "
import json,sys
for t in json.load(sys.stdin):
    print(f\"[{t['node']['title']}] {t['title']} (回复 {t['replies']}) {t['url']}\")"
```

> - `hot.json` 返回 10 条按热度排序，`latest.json` 返回约 40 条按时间排序，字段含 `title/node.title/replies/url/content_rendered`。
> - 两个接口都是 GET、无需 token、无需 UA（带上 `Mozilla/5.0` 更稳）。
> - 汇总时按主题归类更易读（本机实测：AI/中转站、Apple 新硬件、程序员职业、生活杂谈 是主要板块）。

## 三、通用补充源（GitHub / V2EX 之外）

| 目标 | 方式 |
|---|---|
| 某 npm 包信息 | `curl -s https://registry.npmjs.org/<包名>/latest`（description/version）|
| 某生态的扩展市场 | 直接抓官方包列表页，正则提取（如 pi.dev/packages）|
| 普通网页正文 | `curl -s -A "Mozilla/5.0" <url>` 再 python 去标签 |

## 使用注意事项

- **按站点选路**：搜 GitHub 先试 gh（已认证时），搜 V2EX 先试 websearch；不要统一先 websearch。
- gh 比匿名 curl 限流高 80 倍、结果更全；websearch 只在 gh 不可用时兜 GitHub，在 V2EX 上是首选。
- curl 命令里统一带 `-m <秒>` 超时，防止挂起。
- **访问 V2EX / GitHub 等被墙站点时，curl 统一加 `-x http://127.0.0.1:7890`**（本机已有代理）；直连 `v2ex.com` 必失败，GitHub 直连也时好时坏。
- 解析一律用一行 `python3 -c` 或 gh 的 `--jq`，不落临时脚本文件（除非解析逻辑确实复杂）。
- 单个搜索主题尽量一次并行发多个搜索（同一回复里多个 bash 调用），省往返。
- **查漏补缺**：使用中发现新的站点结构、新端点、新的限流规律，主动把经验补进本文件，让 skill 越来越准。

## 已踩过的坑（维护记录）

- **本机有 gh 2.97.0（OAuth 已认证，限流 5000/时）**，GitHub 搜索优先用它，别用匿名 curl。
- gh search repos 能搜到匿名 API 搜不到的仓库（相关度索引），如 pi-mcp-adapter、tau。
- GitHub search API 匿名限流严格，关键词搜不到就换 org/仓库列表端点，或直接换 gh。
- V2EX `/search` 需登录，必须走 DDG 站外搜索。
- V2EX `/api/` 是非正式只读接口（网页自用、无文档、无搜索能力），仅能按 id/username 取帖子/回复/用户，搜索必须靠站外。
- Bing 搜 "pi" 被圆周率污染，弃用。
- DDG 连续抓会 202，注意节流。
- pi.dev/packages 页面是很好的"生态扩展清单"来源，正则提取包名即可。
- **本机直连 `www.v2ex.com` 不通**（TCP 443 超时 / curl `000`，解析到单 IP `104.244.45.246`）；`global.v2ex.co` 走 Cloudflare 可直连，但数据可能是缓存。**首选走本地代理 7890** 拿主站实时数据。
- 本机代理：**7890 = HTTP，7891 = SOCKS5**（Clash 风格）。SOCKS5 要用 `--socks5-hostname`，不能当 HTTP 代理用。代理未设环境变量时 curl 默认不走。
- **WebFetch 不吃本地代理**，抓 `v2ex.com` 会 `fetch failed`；抓 V2EX 用 Bash + curl，别用 WebFetch。
- **V2EX 列表接口**：`/api/topics/hot.json`（热门 10 条）、`/api/topics/latest.json`（最新 ~40 条），免鉴权，适合回答"最近有什么话题"。
- 找可用镜像时可用 WebSearch 探路（如搜"v2ex 最近热门话题"会带出 `global.v2ex.co` 等镜像域名），但数据仍应从 API 拿。
