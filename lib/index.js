/**
 * DSH-Enhance — 宿主半边。
 *
 * 三块能力：
 *   1. 对话移动（单个 / 整个工作区）：重建携带完整历史的新会话并归档原会话。
 *   2. 对话删除：删转录工件、工作区记账、归档标记、spill，并留墓碑挡住重编入。
 *   3. 搜索 / 抓取替换：优先平台失败时按候补顺序换下一家。
 *
 * config 的每个字段都放在顶层：dsh 设置页的表单模型只按顶层字段名读写
 * （SettingsFormModel 内部是 `snapshot.value?.[field]`、`path: [field]`），
 * 嵌套字段在设置页里根本显示不出来。
 */
import z from "@deepseek-ai/schemastery";
import { buildRuntime, DEFAULT_FETCH_CHAIN, DEFAULT_SEARCH_CHAIN, EnhanceFetchProvider, EnhanceSearchProvider, PROVIDER_ID } from "./chain.js";
import { registerRoutes } from "./session-ops.js";
import { PLATFORMS } from "./platforms.js";

/** Cordis 插件名，出现在加载器诊断里。 */
const name = "dsh-enhance";
/**
 * 不硬依赖任何服务：web seam、webServer 都通过 ctx.inject 可选挂载。
 * 这样宿主升级后即使 web 相关服务改名或拆分，会话删除与工作区迁移仍然可用，
 * 而不是整个插件加载失败。
 */
const inject = [];

/** 平台 id 列表，用于生成每个平台自己的配置字段。 */
const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id);

/** 平台字段的默认基础地址。 */
const DEFAULT_BASE_URLS = Object.fromEntries(PLATFORMS.map((platform) => [platform.id, platform.defaultBaseURL]));
/** 平台字段的默认凭据引用。 */
const DEFAULT_KEY_ENVS = Object.fromEntries(PLATFORMS.map((platform) => [platform.id, platform.keyRef]));

/** 每个平台四组字段：字面量 key、凭据引用、基础地址、单次超时。 */
const platformFields = Object.fromEntries(PLATFORM_IDS.flatMap((id) => [
  [`${id}ApiKey`, z.string().role("secret").volatile()],
  [`${id}KeyEnv`, z.string().role("credential-ref").default(DEFAULT_KEY_ENVS[id]).volatile()],
  [`${id}BaseURL`, z.string().default(DEFAULT_BASE_URLS[id]).volatile()],
  [`${id}TimeoutMs`, z.number().step(1).min(1).default(15000).volatile()],
]));

const Config = z.object({
  // ── 功能开关（设置页的三个按钮写这里） ────────────────────────────────
  /** 对话删除按钮是否可用。 */
  enableDelete: z.boolean().default(true).volatile(),
  /** 拖动对话 / 工作区菜单「修改工作区」是否可用。 */
  enableMove: z.boolean().default(true).volatile(),
  /** 搜索功能替换是否生效；关闭后转交宿主内置 provider。 */
  enableSearch: z.boolean().default(true).volatile(),
  /** 抓取功能替换是否生效；关闭后转交宿主内置 provider。 */
  enableFetch: z.boolean().default(true).volatile(),

  // ── 优先 / 候补链 ────────────────────────────────────────────────────
  /** 搜索链：逗号分隔的平台 id，第一个是优先，其余是候补。 */
  searchChain: z.string().default(DEFAULT_SEARCH_CHAIN).volatile(),
  /** 抓取链：同上。 */
  fetchChain: z.string().default(DEFAULT_FETCH_CHAIN).volatile(),

  // ── 链的公共参数 ─────────────────────────────────────────────────────
  /** 整条链的总预算，必须小于 tool-web 的 fetchTimeoutMs（默认 30000）。 */
  totalTimeoutMs: z.number().step(1).min(1).default(28000).volatile(),
  /** 单平台默认超时；留出预算给后面的候补。 */
  platformTimeoutMs: z.number().step(1).min(1).default(15000).volatile(),
  /** 正文短于这个字符数（忽略空白）就认为没抓到，换下一家；0 关闭该判定。 */
  minChars: z.number().step(1).min(0).default(500).volatile(),
  /** 单次搜索返回的最大结果数。 */
  maxResults: z.number().step(1).min(1).max(50).default(8).volatile(),
  /** 抓取时是否只保留正文（Firecrawl 的确定性过滤）。 */
  onlyMainContent: z.boolean().default(true).volatile(),

  // ── 每个平台的凭据与端点 ─────────────────────────────────────────────
  ...platformFields,
});

/** 每次操作前快照一份配置（设置页改动因此无需重启）。 */
function snapshot(ctx, config) {
  return buildRuntime(ctx, config);
}

/** 把两个链式 provider 注册进 ctx.web，并挂上宿主路由。 */
function apply(ctx, config) {
  const runtime = () => snapshot(ctx, config);
  const disposers = [];

  // web seam 是可选依赖：宿主没有它时只是失去搜索/抓取替换。
  ctx.inject(["web"], (webCtx) => {
    try {
      disposers.push(webCtx.web.registerSearchProvider(new EnhanceSearchProvider(runtime)));
      disposers.push(webCtx.web.registerFetchProvider(new EnhanceFetchProvider(runtime)));
    } catch (error) {
      ctx.logger?.warn?.(`dsh-enhance: web provider 注册失败：${(error && error.message) || error}`);
    }
  });

  // 路由本身在 registerRoutes 里等待 webServer；这里再兜一层，避免注册异常外溢。
  try {
    disposers.push(registerRoutes(ctx, runtime));
  } catch (error) {
    ctx.logger?.warn?.(`dsh-enhance: 路由注册失败：${(error && error.message) || error}`);
  }

  return async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose?.();
      } catch {
        // 单个卸载失败不阻断其余卸载。
      }
    }
  };
}

export {
  Config,
  DEFAULT_FETCH_CHAIN,
  DEFAULT_SEARCH_CHAIN,
  EnhanceFetchProvider,
  EnhanceSearchProvider,
  PLATFORM_IDS,
  PROVIDER_ID,
  apply,
  inject,
  name,
};
