/**
 * DSH-Enhance — 优先/候补链。
 *
 * 一次搜索（或抓取）从「优先」平台开始，任何不可用的失败——key 失效、
 * 额度不足、被反爬、超时、抓不到正文——都直接换成下一个候补平台，直到某一个
 * 成功或全部失败。只有调用方主动取消时不降级。
 *
 * 关闭「搜索功能替换」后，本 provider 把请求原样转交给宿主里注册的其它
 * provider（内置的 DeepSeek 官方搜索 / HTTP 抓取），等于恢复原状。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { createCredentialResolver, describeError, normaliseBaseURL } from "./config.js";
import { abortError, isAborted } from "./http.js";
import {
  PLATFORM_BY_ID,
  PlatformFailure,
  chainFailure,
  platformOptions,
  platformSupports,
} from "./platforms.js";

/** 本插件在 seam 注册表里的 id（搜索与抓取各一个注册表，可同名）。 */
export const PROVIDER_ID = "dsh-enhance";

/** 链的默认值：优先 1 个 + 候补 1 个。 */
export const DEFAULT_SEARCH_CHAIN = "deepseek,parallel";
export const DEFAULT_FETCH_CHAIN = "deepseek,tavily";

/** 平台 id 全表。 */
const PLATFORM_IDS = new Set(PLATFORM_BY_ID.keys());

/** 读一个 schemastery 字段的当前值；兼容 reactive（.get()）与普通值。 */
export function readField(config, key) {
  const field = config?.[key];
  if (field === undefined || field === null) return undefined;
  return typeof field.get === "function" ? field.get() : field;
}

/** 布尔字段：认不出时用兜底值。 */
function readBoolean(config, key, fallback) {
  const value = readField(config, key);
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 解析「优先,候补,候补,候补」形式的链。
 * 未知平台与重复项被丢弃；空串只是占位，不参与链。
 */
export function parseChain(value, fallback) {
  const raw = typeof value === "string" && value.length > 0 ? value : fallback;
  const seen = new Set();
  const ids = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id.length === 0 || !PLATFORM_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length > 0) return ids;
  return fallback === "deepseek" ? [] : parseChain(fallback, "deepseek");
}

/**
 * 把插件配置快照成一次操作要用的运行时选项。
 * @param ctx - 插件上下文。
 * @param config - schemastery 配置对象。
 */
export function buildRuntime(ctx, config) {
  const platformTimeoutMs = readField(config, "platformTimeoutMs") ?? 15000;

  /** 单平台超时：不超过整链剩余预算。 */
  const timeoutMsFor = (platformId, remaining) => {
    const configured = readField(config, `${platformId}TimeoutMs`);
    const base = Number.isInteger(configured) && configured > 0 ? configured : platformTimeoutMs;
    return Number.isInteger(remaining) && remaining > 0 ? Math.min(base, remaining) : base;
  };

  return {
    ctx,
    deleteEnabled: readBoolean(config, "enableDelete", true),
    moveEnabled: readBoolean(config, "enableMove", true),
    searchEnabled: readBoolean(config, "enableSearch", true),
    fetchEnabled: readBoolean(config, "enableFetch", true),
    searchChain: parseChain(readField(config, "searchChain"), DEFAULT_SEARCH_CHAIN),
    fetchChain: parseChain(readField(config, "fetchChain"), DEFAULT_FETCH_CHAIN),
    minChars: readField(config, "minChars") ?? 500,
    maxResults: readField(config, "maxResults") ?? 8,
    totalTimeoutMs: readField(config, "totalTimeoutMs") ?? 28000,
    platformTimeoutMs,
    onlyMainContent: readField(config, "onlyMainContent") !== false,
    fetchImpl: undefined,
    timeoutMsFor,
    /** 平台基础地址（可被配置覆盖）。 */
    baseURLFor(platformId) {
      const platform = PLATFORM_BY_ID.get(platformId);
      return normaliseBaseURL(readField(config, `${platformId}BaseURL`), platform.defaultBaseURL);
    },
    /** 平台密钥解析器；config 里的字面量优先，其次凭据服务/启动环境。 */
    resolverFor(platformId) {
      const platform = PLATFORM_BY_ID.get(platformId);
      return createCredentialResolver(ctx, {
        literalApiKey: readField(config, `${platformId}ApiKey`),
        apiKeyEnv: readField(config, `${platformId}KeyEnv`) ?? platform.keyRef,
      });
    },
  };
}

/**
 * 在本 provider 被停用时，把请求转交给宿主里其它已注册且可用的 provider。
 * @param ctx - 宿主上下文。
 * @param fn - search 或 fetch。
 * @param request - 原始请求。
 * @param signal - 取消信号。
 */
async function delegate(ctx, fn, request, signal) {
  const registry = fn === "search" ? ctx.web?.searchProviders : ctx.web?.fetchProviders;
  if (!(registry instanceof Map)) {
    throw new WebError("DSH-Enhance: 宿主 web 服务不可用，无法转交请求", "WEB_PROVIDER_UNAVAILABLE");
  }
  const candidates = [];
  for (const [id, provider] of registry) {
    if (id === PROVIDER_ID) continue;
    try {
      if (provider.available?.() !== false) candidates.push(provider);
    } catch {
      // available() 抛错的 provider 不参与转交。
    }
  }
  const single = candidates[0];
  if (single === undefined) {
    throw new WebError(
      "DSH-Enhance: 搜索功能替换已关闭，且宿主没有其它可用的网页提供方",
      "WEB_PROVIDER_UNAVAILABLE",
    );
  }
  return single[fn](request, signal);
}

/** 链式执行：优先 → 候补。 */
async function runChain(runtime, fn, request, signal) {
  const chain = fn === "search" ? runtime.searchChain : runtime.fetchChain;
  const label = fn === "search" ? "搜索" : "抓取";
  const deadline = Date.now() + runtime.totalTimeoutMs;
  const attempts = [];
  let lastError;

  for (const platformId of chain) {
    const platform = PLATFORM_BY_ID.get(platformId);
    if (platform === undefined || !platformSupports(platform, fn)) continue;
    if (isAborted(signal)) throw abortError(signal, `web ${fn}`);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      attempts.push(`${platform.label}: 整链 ${runtime.totalTimeoutMs} ms 预算已用尽`);
      break;
    }

    let options;
    try {
      const slice = {
        minChars: runtime.minChars,
        maxResults: runtime.maxResults,
        onlyMainContent: runtime.onlyMainContent,
        fetchImpl: runtime.fetchImpl,
        resolverFor: (id) => runtime.resolverFor(id),
        baseURLFor: (id) => runtime.baseURLFor(id),
        timeoutMsFor: (id) => runtime.timeoutMsFor(id, deadline - Date.now()),
      };
      options = await platformOptions(runtime.ctx, platform, slice);
    } catch (error) {
      attempts.push(`${platform.label}: ${describeError(error)}`);
      continue;
    }

    try {
      return await platform[fn](runtime.ctx, request, options, signal);
    } catch (error) {
      if (isAborted(signal)) throw abortError(signal, `web ${fn}`);
      if (error instanceof PlatformFailure && error.kind === "not-found" && fn === "fetch") {
        // 页面确实不存在：换哪家都是 404，不值得再花一次额度。
        throw error;
      }
      // 官方接口完全透传：它是链上唯一一项时，直接抛出宿主自己的错误，
      // 不套上本插件的措辞，也不改写 code。
      if (platform.managed === true && chain.length === 1) throw error;
      attempts.push(`${platform.label}: ${describeError(error)}`);
      lastError = error;
    }
  }

  // 只有一家可选且它就是官方接口：原样抛出。
  if (chain.length === 1 && lastError instanceof Error) throw lastError;
  throw chainFailure(label, attempts.length > 0 ? attempts : [`没有配置可用的${label}平台`]);
}

/** web_search 的链式提供方。 */
export class EnhanceSearchProvider {
  constructor(runtime) {
    this.runtime = runtime;
    this.id = PROVIDER_ID;
  }

  available() {
    return true;
  }

  async search(request, signal) {
    const runtime = this.runtime();
    if (!runtime.searchEnabled) return delegate(runtime.ctx, "search", request, signal);
    return runChain(runtime, "search", request, signal);
  }
}

/** web_fetch 的链式提供方。 */
export class EnhanceFetchProvider {
  constructor(runtime) {
    this.runtime = runtime;
    this.id = PROVIDER_ID;
  }

  available() {
    return true;
  }

  async fetch(request, signal) {
    const runtime = this.runtime();
    if (!runtime.fetchEnabled) return delegate(runtime.ctx, "fetch", request, signal);
    return runChain(runtime, "fetch", request, signal);
  }
}
