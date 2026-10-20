# DSH-Enhance

把三件事合进一个 DSH 插件：

1. **对话删除** —— 会话与归档会话的「…」菜单里出现「删除对话」，带二次确认，删转录、工作区记账、归档标记与 spill。
2. **工作区修改** —— 把一个对话拖到别的工作区，或在工作区「…」菜单里点「修改工作区」把整个工作区的对话一次迁走。
3. **搜索 / 抓取替换** —— 按「优先 → 候补」的链条调用多个网页平台，优先那家 key 失效、额度不足、被反爬、抓不到正文时自动换下一家。

## 平台

| 平台 | 搜索 | 抓取 | 密钥归属 | 免费额度 |
| --- | --- | --- | --- | --- |
| DeepSeek 官方 | ✅ | ✅ | **DSH 内置，不由本插件管** | 由「设置 → 网页搜索」管理 |
| Parallel | ✅ | — | 本插件设置页 | 每月 5,000 次请求 |
| Tavily | ✅ | ✅ | 本插件设置页 | 每月 1,000 credits |
| Firecrawl | ✅ | ✅ | 本插件设置页 | 每月 1,000 credits |

**DeepSeek 官方不做任何包装**：链上选到它时，请求直接转交 DSH 已注册的内置提供方 ——
搜索交给 `@deepseek-ai/dsh-web-search-deepseek`（provider id `deepseek-official`），
抓取交给 `@deepseek-ai/dsh-web-fetch-http`（provider id `http`）。它的 API Key、
DeepSeek 账号令牌、端点、超时都由宿主自己决定，本插件不复制、不改写、不单独存 key。
链上只有官方一项时，它的错误也原样上抛。

参考 dsh-webenhance 的分工，三家第三方平台各有一条推荐提示：

- **Parallel** —— 推荐用于搜索。额度与抓取完全独立，搜索不会吃掉抓取的配额。
- **Tavily** —— 推荐作为抓取首选。正文抽取质量最好。
- **Firecrawl** —— 推荐作为抓取兜底。Tavily 额度耗尽或被反爬时接手。

默认链因此是：搜索 `Parallel → DeepSeek 官方`，抓取 `Tavily → Firecrawl → DeepSeek 官方`。

## 优先 / 候补

设置页里搜索与抓取各有一条链，**固定三个槽位**（优先、候补 1、候补 2），一行三等分排开：

- 每个槽位是一个**弹出式选择按钮**，菜单里列出该功能支持的全部平台（含「空」）；
- 「推荐」标记只出现在该槽位对应的平台上：搜索是 `优先 Parallel`、`候补1 DeepSeek 官方`；
  抓取是 `优先 Tavily`、`候补1 Firecrawl`、`候补2 DeepSeek 官方`；
- 候补位留空等于没有这一级，链会自动跳过。

**替换规则**：优先平台只要这一次调用不能用 —— 没有 key、key 无效、额度耗尽、
限流、被反爬、超时、没抓到正文 —— 就换下一个候补，直到某一家成功或全部失败。
唯一不降级的情况是页面确实 404/410：换哪家都是 404，不值得再花一次额度。

整条链共用一份总预算（默认 28 s），保证落在工具层 `web_fetch` 的 30 s 超时之内。

## 设置

`设置 → 功能增强`：

- **对话删除功能** —— 开关。
- **工作区修改功能** —— 开关。
- **搜索功能替换** —— 开关；关闭时本插件的 provider 把请求原样转交宿主其它提供方，等于恢复原状。
  开启后才出现下面的链条与密钥配置。
- **平台密钥** —— 三家第三方平台都会出现，即使它当前不在链里，也不会缺少配置入口。
  每行显示平台名、免费额度、「获取 Key」直达链接与输入框。

## 移动与删除的实现要点

- **工作区成员资格由会话 header 的 `cwd` 决定，而 header 不可改写**。所以「移动」不是在原文件上改字段，而是
  在目标工作区路径下重建一份携带完整历史（同 `createdAt` / `agentPreset` / 事件序列）的新会话。
  重建走运行时 `sessions.create({ seed })` 而不是直接写持久层：绕过 store 建出来的会话没有标题投影，
  列表里会显示成「未命名空对话」。新会话 `attachSession(newId)`、源工作区 `detachSession` 之后，
  **原会话直接删除**（不 `archiveSession`）—— 归档会在归档列表里留下一份副本，看起来像多出一个对话。
- **删除**走 `sessionPersistence.locate(header)` 找到转录文件，先校验文件名符合 `session*.jsonl(.zstd)`，
  只有目录里只剩该会话自己的工件时才连目录一起删，绝不误伤同目录下的其它文件。
  删完再摘工作区记账、清归档标记、清 spill，并给注册表的内存索引留一个墓碑，挡住 stale `list()` 把已删会话重新编入。
  迁移复用的就是这个删除通道，所以迁移不会连带影响任何其它会话的归档状态。

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

宿主版本迭代时，插件的每一处外部依赖都做成了「缺失即降级」，不会因为一个接口改名就整体失效：

| 依赖 | 缺失 / 变化时的行为 |
| --- | --- |
| `web` seam（搜索 / 抓取） | 插件照常加载，只失去搜索替换；会话删除与工作区迁移仍可用 |
| `webServer` 路由 | 跳过路由注册，界面调用返回可读错误而不是卡在「迁移中…」 |
| `configForms` / `SettingsFormModel` | 设置页降级为只读，其余界面正常 |
| `@deepseek-ai/dsh-client-ui-primitives` | 删除菜单退化为原生按钮，选择框退化为原生下拉 |
| `dashboard` 侧边栏 DOM（菜单 / 行结构） | 观察器吞掉异常并停止注入，不影响宿主自身菜单 |
| 客户端包 `dsh.client.inject` | 置空，只用服务级 `inject` 声明必需项，避免写死内部包名 |

宿主侧的 `inject` 也是空数组，`web` 通过 `ctx.inject(["web"], …)` 可选挂载。

## 安装

```bash
dsh plugin --profile web add link:<这个目录的绝对路径>
```

或在 profile 的 `package.json` 里加

```json
"dependencies": { "dsh-enhance": "link:C:/path/to/dsh-enhance" },
"dsh": { "profile": { "bundles": [ ..., "dsh-enhance" ] } }
```

插件自带 `cordis.patch.yml`，会把 `web` 的 `searchProvider` / `fetchProvider` 指到 `dsh-enhance`。

## 开发

```bash
npm test
```

测试用 `test/register-shims.mjs` 把 `@deepseek-ai/*` 的裸导入指向 `test/shims/` 下的替身，
因此不需要 dsh 本体也能跑；替身目录刻意不叫 `node_modules`，否则会被 `link:` 安装带进 profile 并遮蔽真包。
