# DSH-Enhance

DSH（DeepSeek Harness）插件，四件事合一：

1. **对话删除** —— 会话与归档会话的「…」菜单里多一项「删除对话」，二次确认后删掉转录、工作区记账、归档标记与 spill。
2. **工作区迁移** —— 把对话拖到别的工作区，或用工作区「…」菜单里的「迁移工作区」一次迁走整个工作区。
3. **迁移记录** —— 每次迁移前把完整对话备份到 `~/.dsh/workspace-mover/backups`，在「设置 → 增强设置」里可把对话恢复到迁移前的工作区；记录与备份保留 3 天。
4. **搜索 / 抓取替换** —— 按「优先 → 候补」链依次尝试多个网页平台，优先那家不可用时自动换下一家。

## 安装

```bash
git clone https://github.com/AnbaoIy/DSH-Enhance.git
dsh plugin --profile desktop add link:C:/path/to/DSH-Enhance
```

或直接改 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": { "dsh-enhance": "link:C:/path/to/DSH-Enhance" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-enhance"] } }
}
```

插件自带 `cordis.patch.yml`，把 `web` 的 `searchProvider` / `fetchProvider` 指向 `dsh-enhance`。重启 DSH 后出现 `设置 → 增强设置`。

> 不要与 `dsh-webenhance`、`@michengai/dsh-archive-manager` 同时启用：三者争用同一个会话菜单槽位与 web provider id。

## 使用

- **删除**：会话或归档会话行「…」→「删除对话」→ 确认。
- **迁移单条**：把对话行拖到目标工作区行（落点有虚线高亮）。
- **迁移整个工作区**：工作区「…」→「迁移工作区」→ 选目标（或「选择其他目录…」新建）→ 确认。
- **恢复**：`设置 → 增强设置` → 「迁移记录」→ 在对应记录上点「恢复」。
- **配置搜索**：`设置 → 增强设置` → 打开「搜索功能替换」→ 选平台 → 填 key → 保存。

迁移语义：在目标路径下**重建**一份带完整历史的新会话，然后**删除**原会话；原对话不进归档。
重建前会把完整历史（header + 全部事件）写入备份，所以 3 天内可以从「迁移记录」恢复到迁移前的工作区。
（工作区成员资格由会话 header 的 `cwd` 决定，header 不可改写，所以只能重建。）

## 平台

| 平台 | 搜索 | 抓取 | 密钥 | 免费额度 |
| --- | --- | --- | --- | --- |
| DeepSeek 官方 | ✅ | ✅ | DSH 内置，本插件不管 | 由「设置 → 网页搜索」管理 |
| Parallel | ✅ | — | 本插件设置页 | 每月 5,000 次请求 |
| Tavily | ✅ | ✅ | 本插件设置页 | 每月 1,000 credits |
| Firecrawl | ✅ | ✅ | 本插件设置页 | 每月 1,000 credits |

选择 DeepSeek 官方时请求原样转交宿主的 `deepseek-official`（搜索）与 `http`（抓取）provider：key、账号令牌、端点、超时全由宿主决定，本插件不复制、不改写、不单独存 key；链上只有官方一项时，它的错误也原样上抛。

Parallel 没有抓取接口，所以抓取侧只有三个平台。

## 优先 / 候补

搜索与抓取各一条链，固定三个槽位（优先、候补 1、候补 2），一行三等分。空槽位等于没有这一级。

| 功能 | 优先 | 候补 1 | 候补 2 |
| --- | --- | --- | --- |
| 搜索 | Parallel | DeepSeek 官方 | 空 |
| 抓取 | Tavily | Firecrawl | DeepSeek 官方 |

「推荐」标记只出现在该槽位对应的平台上。**替换规则**：没有 key、key 无效、额度耗尽、限流、被反爬、超时、没抓到正文，都换下一个候补，直到成功或全部失败；只有页面确实 404/410 时不降级（换哪家都一样，不值得再花一次额度）。

整条链共用 28 s 总预算，落在工具层 `web_fetch` 的 30 s 超时之内。

## 配置字段

设置页只暴露开关、链与密钥；以下为完整 `Config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enableDelete` / `enableMove` | `true` | 删除 / 迁移功能 |
| `enableSearch` / `enableFetch` | `true` | 搜索 / 抓取替换（UI 上由同一个开关连带写入） |
| `searchChain` | `parallel,deepseek` | 搜索链 |
| `fetchChain` | `tavily,firecrawl,deepseek` | 抓取链 |
| `totalTimeoutMs` / `platformTimeoutMs` | `28000` / `15000` | 整链预算 / 单平台超时 |
| `minChars` | `500` | 正文短于此值视为没抓到，换下一家；`0` 关闭 |
| `maxResults` / `onlyMainContent` | `8` / `true` | 搜索结果数 / 只保留正文 |
| `parallelApiKey` 等 | 空 | 各平台 key，`secret` 字段，不写入设置文件 |
| `parallelKeyEnv` 等 | `PARALLEL_API_KEY` 等 | 凭据引用名 |
| `parallelBaseURL` 等 | 各平台端点 | 自建代理时改这里 |

密钥经 `ctx.remote.credentials.set()` 存入凭据服务，不进设置文件、不进日志。

## 实现要点

- **迁移**先 `sessions.prepare({ seed })` 只构造新会话（**不进入**运行时 store，否则之后打开它会撞上 `session already exists`），再用 `sessionPersistence.create/append/flush/close` 把同一份历史写进目标目录；写盘成功后才 `attachSession` 并**删除**原会话。只建内存会话会让对话「看着在、点不开、重启就没」。不调 `archiveSession` —— 归档会在列表里留下副本，看起来像多出一个对话。
- **备份**在删除原会话**之前**写入 `$DSH_HOME/workspace-mover/backups/<uuid>.json`（header + 完整事件 + 源/目标工作区），记录追加到同目录的 `history.json`。备份写失败就中止迁移，绝不出现「原对话已删、备份没写」。
- **恢复**读备份 → 在迁移前的工作区（按 id、再按路径匹配；都找不到才退回目标工作区）用同一套 `prepare + sessionPersistence` 通道重建会话。备份保留，可重复恢复。
- **标题**迁移/恢复后会立刻调用 `sessionProjectionCache.coldSnapshot(header, inheritedEventCount, events)` 预热投影缓存。持久化会话的侧边栏标题读的是缓存行，新 id 没有缓存行就只能显示「未命名」，直到用户点开触发冷读；预热让标题从第一帧就正确。
- **保留期** 3 天：插件每次加载（DSH 启动）清一次过期记录与对应备份，同时清掉超过 3 天且无记录指向的孤儿备份。
- **删除**用 `sessionPersistence.locate(header)` 定位转录文件，先校验文件名符合 `session*.jsonl(.zstd)`，仅当目录里只剩该会话自己的工件时才连目录一起删；随后摘工作区记账、清归档标记与 spill，并留一个墓碑挡住 stale `list()` 重新编入。迁移复用这条通道，不会连带影响其它会话。

## 宿主路由

六个 POST 路由（开关关闭时直接拒绝，不只是隐藏按钮）：

| 路由 | 请求体 |
| --- | --- |
| `/dsh-enhance/move-session` | `{ sessionId, targetWorkspaceId }` |
| `/dsh-enhance/move-workspace` | `{ sourceWorkspaceId, targetWorkspaceId }` |
| `/dsh-enhance/delete-session` | `{ sessionId }` |
| `/dsh-enhance/move-history` | `{}` |
| `/dsh-enhance/restore-session` | `{ backupId }` |
| `/dsh-enhance/list-workspaces` | `{}` |

## 宿主升级适配

每处外部依赖都做成「缺失即降级」：`web` 不在 → 只失去搜索替换；`webServer` 不在 → 跳过路由；`configForms` / `SettingsFormModel` 缺失 → 设置页只读；`dsh-client-ui-primitives` 缺失 → 菜单退化成原生按钮、选择框退化成原生下拉；侧边栏 DOM 变化 → 观察器吞掉异常并停止注入。宿主 `inject` 为空数组，`web` 通过 `ctx.inject(["web"], …)` 可选挂载。

## 常见问题

- **迁移后原对话在哪？** 已删除，不进归档；3 天内可在「设置 → 增强设置 → 迁移记录」里点「恢复」找回。
- **迁移记录里的「恢复」是灰的？** 那条记录来自旧版插件，没有对应备份文件。
- **迁移后侧边栏显示「未命名」？** 早期版本没预热投影缓存，点开一次即恢复；当前版本迁移完就会写好缓存。
- **设置页整页变灰 / 点不动？** 配置表单没拿到可写状态，先整页刷新；仍有问题请附浏览器控制台里 `[dsh-enhance]` 开头的告警提 issue。
- **搜索没走我配的平台？** 确认开关已开、该平台在优先位、key 已保存；另外 404/410 不降级是有意为之。

## 开发

```bash
npm test
```

测试用 `test/register-shims.mjs` 把 `@deepseek-ai/*` 的裸导入指向 `test/shims/` 替身，不需要 DSH 本体（替身目录刻意不叫 `node_modules`，否则会被 `link:` 安装带进 profile 遮蔽真包）。

改完宿主侧代码需重载插件或重启 DSH；改完 `lib/client.js` 需整页刷新（`Ctrl+R`）。

## 许可

MIT
