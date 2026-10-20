# DSH-Enhance

一个 DSH（DeepSeek Harness）插件，把三件事合进同一处：

1. **对话删除** —— 会话与归档会话的「…」菜单里出现「删除对话」，二次确认后删掉转录、工作区记账、归档标记与 spill。
2. **工作区修改** —— 把对话拖到别的工作区，或在工作区「…」菜单里点「修改工作区」把整个工作区的对话一次迁走。
3. **搜索 / 抓取替换** —— 按「优先 → 候补」的链条调用多个网页平台；优先那家 key 失效、额度不足、被反爬、抓不到正文时自动换下一家。

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [平台与免费额度](#平台与免费额度)
- [优先 / 候补规则](#优先--候补规则)
- [设置项](#设置项)
- [实现要点](#实现要点)
- [宿主路由](#宿主路由)
- [宿主升级适配](#宿主升级适配)
- [常见问题](#常见问题)
- [开发](#开发)

## 功能

### 对话删除

- 会话行与归档会话行的「…」菜单里各多一项「删除对话」。
- 点开后是确认卡片，显示对话标题与「不可恢复」提示；确认后：
  删转录工件 → 摘工作区记账 → 清归档标记 → 清 spill → 给注册表留一个墓碑，
  挡住 stale `list()` 把已删会话重新编入。
- 对话正在运行时拒绝删除，避免删到正在写的日志。

### 工作区修改

两种入口，走同一条宿主通道：

- **拖动**：把侧边栏的对话行拖到另一个工作区行上，落点会显示虚线高亮，松手即迁移。
- **菜单**：工作区「…」菜单 →「修改工作区」→ 弹出对话框选目标工作区（或「选择其他目录…」新建一个）→ 该工作区的**全部对话**逐条迁移。

迁移语义（重要）：

> 在目标工作区路径下**重建**一份携带完整历史的新会话，然后**删除**原会话。
> 原对话不会保留，也不进入归档列表，不可撤销。

之所以要重建而不是改字段：工作区成员资格由会话 header 的 `cwd` 与工作区 `path` 匹配决定，而 header 是不可改写的。

### 搜索 / 抓取替换

开启后，本插件向 `web` seam 注册 `dsh-enhance` 提供方，`web_search` / `web_fetch` 的请求按链依次尝试多个平台。
关闭后，请求原样转交宿主其它提供方，等于恢复原状。

## 安装

要求：DSH 已安装，Node ≥ 20。

### 1. 从仓库安装（推荐先用 link）

```bash
git clone https://github.com/AnbaoIy/DSH-WebEnhance.git
dsh plugin --profile <profile> add link:<克隆下来的目录的绝对路径>
```

### 2. 直接改 profile

编辑 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-enhance": "link:C:/path/to/DSH-WebEnhance"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-enhance"]
    }
  }
}
```

### 3. 重启并确认

插件自带 `cordis.patch.yml`，会把 `web` 的 `searchProvider` / `fetchProvider` 指向 `dsh-enhance`。
重启 DSH 后，`设置 → 增强设置` 应出现该页面。

> 与旧的 `dsh-webenhance` / `@michengai/dsh-archive-manager` 不要同时启用：三者都会占用
> `sidebar.workspaces.session.menu.item` 与 web provider id，重复注册会冲突。

## 使用

### 删除对话

1. 在会话行或归档会话行点「…」；
2. 选「删除对话」；
3. 确认卡片里点「删除」。

### 迁移对话

- 单条：直接拖动到目标工作区行。
- 整个工作区：工作区「…」→「修改工作区」→ 选目标 → 确认。

### 配置搜索替换

`设置 → 增强设置`：

1. 打开「搜索功能替换」；
2. 搜索、抓取各一行三个槽位（优先 / 候补 1 / 候补 2），点开选择平台；
3. 在「平台密钥」里填 key，点「获取 Key」直达对应平台；
4. 点右下角「保存」。

## 平台与免费额度

| 平台 | 搜索 | 抓取 | 密钥归属 | 免费额度 |
| --- | --- | --- | --- | --- |
| DeepSeek 官方 | ✅ | ✅ | **DSH 内置，不由本插件管** | 由「设置 → 网页搜索」管理 |
| Parallel | ✅ | — | 本插件设置页 | 每月 5,000 次请求 |
| Tavily | ✅ | ✅ | 本插件设置页 | 每月 1,000 credits |
| Firecrawl | ✅ | ✅ | 本插件设置页 | 每月 1,000 credits |

**DeepSeek 官方不做任何包装**：链上选到它时，请求直接转交 DSH 已注册的内置提供方 ——
搜索交给 `@deepseek-ai/dsh-web-search-deepseek`（provider id `deepseek-official`），
抓取交给 `@deepseek-ai/dsh-web-fetch-http`（provider id `http`）。它的 API Key、DeepSeek 账号令牌、
端点、超时都由宿主自己决定，本插件不复制、不改写、不单独存 key。链上只有官方一项时，它的错误原样上抛。

Parallel 没有抓取接口，所以抓取侧只有三个可选平台。

## 优先 / 候补规则

搜索与抓取各有一条链，**固定三个槽位**（优先、候补 1、候补 2），一行三等分排开：

- 每个槽位是一个弹出式选择按钮，菜单里列出该功能支持的全部平台（含「空」）；
- 「推荐」标记只出现在该槽位对应的平台上：

  | 功能 | 优先 | 候补 1 | 候补 2 |
  | --- | --- | --- | --- |
  | 搜索 | Parallel | DeepSeek 官方 | （可空） |
  | 抓取 | Tavily | Firecrawl | DeepSeek 官方 |

- 候补位留空等于没有这一级，链会自动跳过。

**替换规则**：优先平台只要这一次调用不能用 —— 没有 key、key 无效、额度耗尽、限流、被反爬、超时、
没抓到正文 —— 就换下一个候补，直到某一家成功或全部失败。
唯一不降级的情况是页面确实 404/410：换哪家都是 404，不值得再花一次额度。

整条链共用一份总预算（默认 28 s），保证落在工具层 `web_fetch` 的 30 s 超时之内。

## 设置项

设置页只暴露开关、链与密钥；下面这些是宿主配置里的完整字段（`Config`），一般不需要手改。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enableDelete` | `true` | 对话删除功能 |
| `enableMove` | `true` | 工作区修改功能 |
| `enableSearch` | `true` | 搜索功能替换（关闭时同时关闭抓取替换） |
| `enableFetch` | `true` | 抓取功能替换（由同一个开关连带写入） |
| `searchChain` | `parallel,deepseek` | 搜索链，逗号分隔 |
| `fetchChain` | `tavily,firecrawl,deepseek` | 抓取链，逗号分隔 |
| `totalTimeoutMs` | `28000` | 整条链的总预算 |
| `platformTimeoutMs` | `15000` | 单个平台的超时 |
| `minChars` | `500` | 正文短于这个字数就认为没抓到，换下一家；`0` 关闭 |
| `maxResults` | `8` | 单次搜索最大结果数 |
| `onlyMainContent` | `true` | 抓取时只保留正文 |
| `<平台>ApiKey` | 空 | 该平台的 key（`secret` 字段，不写入设置文件） |
| `<平台>KeyEnv` | `PARALLEL_API_KEY` 等 | 凭据引用名 |
| `<平台>BaseURL` | 各平台默认端点 | 自建代理时改这里 |
| `<平台>TimeoutMs` | `15000` | 单平台默认超时 |

密钥只通过 `ctx.remote.credentials.set()` 写入凭据服务，不会落进设置文件，也不会出现在日志里。

## 实现要点

- **迁移走运行时 `sessions.create({ seed })`**，而不是直接写持久层。绕过 store 建出来的会话没有标题投影，
  列表里会显示成「未命名空对话」。新会话 `attachSession(newId)`、源工作区摘除之后，原会话**直接删除**。
- **原会话不归档**。归档会在归档列表里留下副本，看起来像多出一个对话，也容易让人误以为迁移失败。
- **删除**走 `sessionPersistence.locate(header)` 定位转录文件，先校验文件名符合 `session*.jsonl(.zstd)`，
  只有目录里只剩该会话自己的工件时才连目录一起删，绝不误伤同目录下的其它内容。
  迁移复用同一条删除通道，因此不会连带影响其它会话的归档状态。
- **批量迁移**先快照 `sessionIds` 再逐条处理，处理期间源工作区成员缩短不会影响遍历。

## 宿主路由

浏览器半边通过这四个路由调用宿主（只接受 POST，返回 JSON）：

| 路由 | 请求体 |
| --- | --- |
| `/dsh-enhance/move-session` | `{ sessionId, targetWorkspaceId }` |
| `/dsh-enhance/move-workspace` | `{ sourceWorkspaceId, targetWorkspaceId }` |
| `/dsh-enhance/delete-session` | `{ sessionId }` |
| `/dsh-enhance/list-workspaces` | `{}` |

开关关闭时，移动与删除路由会直接拒绝，不只是隐藏按钮。

## 宿主升级适配

插件的每一处外部依赖都做成了「缺失即降级」，不会因为一个接口改名就整体失效：

| 依赖 | 缺失 / 变化时的行为 |
| --- | --- |
| `web` seam（搜索 / 抓取） | 插件照常加载，只失去搜索替换；会话删除与工作区迁移仍可用 |
| `webServer` 路由 | 跳过路由注册，界面调用返回可读错误而不是卡在「迁移中…」 |
| `configForms` / `SettingsFormModel` | 设置页降级为只读，其余界面正常 |
| `@deepseek-ai/dsh-client-ui-primitives` | 删除菜单退化为原生按钮，选择框退化为原生下拉 |
| 侧边栏 DOM（菜单 / 行结构） | 观察器吞掉异常并停止注入，不影响宿主自身菜单 |
| 客户端包 `dsh.client.inject` | 置空，改用服务级 `inject` 声明必需项，避免写死内部包名 |

宿主侧 `inject` 是空数组，`web` 通过 `ctx.inject(["web"], …)` 可选挂载。

## 常见问题

**迁移后原对话去哪了？**
被删除了。迁移是「建新 + 删旧」，原对话不会留在源工作区，也不会进归档列表。

**归档列表里为什么没有多出来的副本？**
因为迁移不调用 `archiveSession`。旧版本会归档，正是「归档列表凭空多一条」的来源。

**设置页整页点不动 / 全部是灰的？**
说明配置表单没拿到可写状态（通常是 `configForms` / `remote` 服务没注入成功）。
先整页刷新；仍不行请提 issue 并附上浏览器控制台里 `[dsh-enhance]` 开头的告警。

**搜索没走我配的平台？**
检查三点：`搜索功能替换` 开关是否打开、对应平台是否排在优先位、该平台 key 是否已保存。
另外页面确实 404/410 时不会降级，这是有意为之。

**key 存在哪里？**
DSH 的凭据服务里，按 `<平台>KeyEnv` 的引用名存放。设置文件、日志、仓库里都不会出现明文 key。

**能同时装 dsh-webenhance 或 archive-manager 吗？**
不建议。三者会争用同一个会话菜单槽位与 web provider id。安装前先禁用旧插件。

## 开发

```bash
npm test
```

测试用 `test/register-shims.mjs` 把 `@deepseek-ai/*` 的裸导入指向 `test/shims/` 下的替身，
因此不需要 DSH 本体也能跑；替身目录刻意不叫 `node_modules`，否则会被 `link:` 安装带进 profile 并遮蔽真包。

改完代码后：

1. 宿主侧（`lib/index.js`、`lib/chain.js`、`lib/session-ops.js` 等）需要重载插件或重启 DSH；
2. 浏览器侧（`lib/client.js`）需要整页刷新（`Ctrl+R`）让 bundle 重新下发。

## 许可

MIT
