/**
 * DSH-Enhance — 平台适配器表。
 *
 * 每个平台声明：可用在哪些功能（search / fetch）、密钥引用、免费额度说明、
 * 获取密钥的官方地址，以及真正的调用实现。
 *
 * 约定：适配器只返回结果，或抛出 {@link PlatformFailure}。
 * 上层（chain.js）按「优先 → 候补」顺序调用，任何 PlatformFailure 都意味着
 * 「这家现在用不了，换下一家」；只有调用方主动取消才不降级。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { endpoint, errorDetail } from "./config.js";
import { postJSON, throwIfAborted } from "./http.js";
import { isSparse, looksBlocked } from "./heuristics.js";

/** 单条结果摘录的截断长度。 */
const SNIPPET_CHARS = 1200;
/** 返回给工具层的正文上限。 */
const MAX_BODY_CHARS = 200000;

/** 一次不可用尝试：kind 决定上层怎么处理。 */
export class PlatformFailure extends Error {
  /**
   * @param kind - credential / quota / rate-limit / blocked / not-found / empty / error。
   * @param message - 面向用户的一行说明。
   * @param status - 相关 HTTP 状态码（可空）。
   */
  constructor(kind, message, status) {
    super(message);
    this.name = "PlatformFailure";
    this.kind = kind;
    this.status = status;
  }
}

/** 额度类状态码：402/432/433 表示本月套餐额度已经用光。 */
const QUOTA_STATUSES = new Set([402, 432, 433]);

/** 把 HTTP 状态码归到「下一步该做什么」。 */
function classifyStatus(status) {
  if (QUOTA_STATUSES.has(status)) return "quota";
  if (status === 429) return "rate-limit";
  if (status === 401 || status === 407) return "credential";
  if (status === 403) return "blocked";
  if (status === 404 || status === 410) return "not-found";
  return "error";
}

/** 缺少密钥。 */
function credentialFailure(label, envName) {
  return new PlatformFailure(
    "credential",
    `${label} 没有可用 API Key；请在 设置 → 功能增强 里填写，或设置环境变量 ${envName}`,
  );
}

/** 统一把「非 2xx」变成 PlatformFailure。 */
function httpFailure(label, response) {
  const kind = classifyStatus(response.status);
  return new PlatformFailure(kind, `${label} 请求失败（HTTP ${response.status}）${errorDetail(response)}`, response.status);
}

/** 把多条摘录拼成一段并按上限截断。 */
function excerptText(excerpts) {
  if (!Array.isArray(excerpts)) return undefined;
  const joined = excerpts
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n\n")
    .trim();
  if (joined.length === 0) return undefined;
  return joined.length <= SNIPPET_CHARS ? joined : `${joined.slice(0, SNIPPET_CHARS)}…`;
}

/** 截断字符串值。 */
function clip(text, limit = SNIPPET_CHARS) {
  if (typeof text !== "string" || text.length === 0) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/** 归一成 seam 认识的结果。 */
function fetchResult(url, statusCode, content) {
  const text = typeof content === "string" ? content : "";
  const truncated = text.length > MAX_BODY_CHARS;
  return {
    url,
    statusCode,
    // 拿到手的就是 markdown，必须声明成 text：工具层只对 kind === "html" 跑转换。
    body: { kind: "text", content: truncated ? text.slice(0, MAX_BODY_CHARS) : text },
    truncated,
  };
}

/** 页面确实不存在：返回结果而不是抛错，避免再花一个 credit 去别的平台。 */
function notFoundResult(url, statusCode = 404) {
  return { url, statusCode, body: { kind: "text", content: "" }, truncated: false, notFound: true };
}

//#region DeepSeek 官方
/**
 * DeepSeek 官方不在本插件里直连 API：DSH 自带的
 *   - 搜索  @deepseek-ai/dsh-web-search-deepseek  (provider id: deepseek-official)
 *   - 抓取  @deepseek-ai/dsh-web-fetch-http       (provider id: http)
 * 已经处理好了凭据（API Key / DeepSeek 账号令牌）与端点，本插件只把它当成链上
 * 的第一家来调用，因此设置页不需要、也不应该再让用户填一次 DeepSeek 的 key。
 */
const DEEPSEEK_SEARCH_PROVIDER_ID = "deepseek-official";
const DEEPSEEK_FETCH_PROVIDER_ID = "http";

/** 取宿主已注册的内置 provider。 */
function builtinProvider(ctx, registryKey, providerId) {
  const registry = ctx?.web?.[registryKey];
  if (!(registry instanceof Map)) return undefined;
  return registry.get(providerId);
}

/** 转交给内置 provider：请求与响应原样透传，不做任何加工。 */
async function delegate(ctx, registryKey, providerId, fn, request, signal) {
  const provider = builtinProvider(ctx, registryKey, providerId);
  if (provider === undefined) {
    throw new PlatformFailure("error", `宿主没有注册内置提供方 ${providerId}`);
  }
  return provider[fn](request, signal);
}

const deepseek = {
  id: "deepseek",
  label: "DeepSeek 官方",
  quota: "由 DSH 内置「网页搜索」设置管理",
  keyUrl: "https://platform.deepseek.com/api_keys",
  keyRef: "DEEPSEEK_API_KEY",
  /** 该平台的 key 由宿主插件管理，设置页不再单列配置栏。 */
  managed: true,
  functions: ["search", "fetch"],
  defaultBaseURL: "https://api.deepseek.com/v1/tools",

  async search(ctx, request, _options, signal) {
    return delegate(ctx, "searchProviders", DEEPSEEK_SEARCH_PROVIDER_ID, "search", request, signal);
  },

  async fetch(ctx, request, _options, signal) {
    return delegate(ctx, "fetchProviders", DEEPSEEK_FETCH_PROVIDER_ID, "fetch", request, signal);
  },
};
//#endregion

//#region Parallel（搜索）
const PARALLEL_DEFAULT_BASE_URL = "https://api.parallel.ai";

const parallel = {
  id: "parallel",
  label: "Parallel",
  quota: "每月最多 5,000 次请求免费（搜索/抓取共用）",
  keyUrl: "https://platform.parallel.ai/",
  keyRef: "PARALLEL_API_KEY",
  functions: ["search"],
  defaultBaseURL: PARALLEL_DEFAULT_BASE_URL,
  /** 推荐理由：参考 dsh-webenhance 的分工，搜索固定走 Parallel，额度与抓取互不挤占。 */
  tips: { search: "tipParallelSearch" },

  async search(ctx, request, options, signal) {
    const limit = Math.max(1, Math.min(options.maxResults, request.maxResults ?? options.maxResults));
    const response = await postJSON(endpoint(options.baseURL, "/v1/search"), {
      headers: { "x-api-key": options.apiKey },
      body: {
        search_queries: [request.query],
        mode: "basic",
        advanced_settings: { max_results: limit },
      },
      signal,
      timeoutMs: options.timeoutMs,
      what: "Parallel 搜索",
      fetchImpl: options.fetchImpl,
    });
    if (!response.ok) throw httpFailure("Parallel 搜索", response);
    const results = Array.isArray(response.json?.results) ? response.json.results : [];
    return {
      sources: results.slice(0, limit).map((item) => {
        if (item === null || typeof item !== "object" || typeof item.url !== "string" || item.url.length === 0) return undefined;
        const snippet = excerptText(item.excerpts);
        return {
          url: item.url,
          ...(clip(item.title) !== undefined ? { title: clip(item.title) } : {}),
          ...(snippet !== undefined ? { snippet } : {}),
          ...(typeof item.publish_date === "string" && item.publish_date.length > 0 ? { publishedAt: item.publish_date } : {}),
        };
      }).filter(Boolean),
      truncated: false,
    };
  },
};
//#endregion

//#region Tavily（搜索 + 抓取）
const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";

const tavily = {
  id: "tavily",
  label: "Tavily",
  quota: "每月 1,000 credits 免费（无需信用卡）",
  keyUrl: "https://app.tavily.com/home",
  keyRef: "TAVILY_API_KEY",
  functions: ["search", "fetch"],
  defaultBaseURL: TAVILY_DEFAULT_BASE_URL,
  /** 推荐理由：抓取首选。 */
  tips: { fetch: "tipTavilyFetch" },

  async search(ctx, request, options, signal) {
    const limit = Math.max(1, Math.min(options.maxResults, request.maxResults ?? options.maxResults));
    const response = await postJSON(endpoint(options.baseURL, "/search"), {
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: {
        query: request.query,
        max_results: limit,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
      },
      signal,
      timeoutMs: options.timeoutMs,
      what: "Tavily 搜索",
      fetchImpl: options.fetchImpl,
    });
    if (!response.ok) throw httpFailure("Tavily 搜索", response);
    const results = Array.isArray(response.json?.results) ? response.json.results : [];
    return {
      sources: results.slice(0, limit).map((item) => {
        if (item === null || typeof item !== "object" || typeof item.url !== "string" || item.url.length === 0) return undefined;
        const snippet = clip(item.content);
        return {
          url: item.url,
          ...(clip(item.title) !== undefined ? { title: clip(item.title) } : {}),
          ...(snippet !== undefined ? { snippet } : {}),
          ...(typeof item.published_date === "string" && item.published_date.length > 0 ? { publishedAt: item.published_date } : {}),
        };
      }).filter(Boolean),
      truncated: false,
    };
  },

  async fetch(ctx, request, options, signal) {
    const response = await postJSON(endpoint(options.baseURL, "/extract"), {
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: {
        urls: [request.url],
        extract_depth: "basic",
        format: "markdown",
        include_images: false,
      },
      signal,
      timeoutMs: options.timeoutMs,
      what: "Tavily 抓取",
      fetchImpl: options.fetchImpl,
    });
    if (!response.ok) {
      const failure = httpFailure("Tavily 抓取", response);
      if (failure.kind === "not-found") return notFoundResult(request.url, response.status);
      throw failure;
    }
    const results = Array.isArray(response.json?.results) ? response.json.results : [];
    const hit = results.find((item) => item?.url === request.url) ?? results[0];
    if (hit !== undefined) {
      const content = typeof hit.raw_content === "string" ? hit.raw_content : "";
      if (looksBlocked(content)) throw new PlatformFailure("blocked", "Tavily 返回的是反爬/登录页");
      if (isSparse(content, options.minChars)) throw new PlatformFailure("empty", "Tavily 没有取到可用正文");
      return fetchResult(typeof hit.url === "string" && hit.url.length > 0 ? hit.url : request.url, 200, content);
    }
    const failed = Array.isArray(response.json?.failed_results) ? response.json.failed_results : [];
    const miss = failed.find((item) => item?.url === request.url) ?? failed[0];
    const message = typeof miss?.error === "string" && miss.error.length > 0 ? miss.error : "Tavily 未能抓取该地址";
    if (/(404|410)|not found/iu.test(message)) return notFoundResult(request.url, 404);
    throw new PlatformFailure("error", `Tavily 抓取失败: ${message}`);
  },
};
//#endregion

//#region Firecrawl（搜索 + 抓取）
const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";

/** Firecrawl 的搜索响应在不同版本里既可能是数组也可能挂在 data.web 上。 */
function firecrawlSearchItems(json) {
  const data = json?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.web)) return data.web;
  if (Array.isArray(json?.results)) return json.results;
  return [];
}

const firecrawl = {
  id: "firecrawl",
  label: "Firecrawl",
  quota: "每月 1,000 credits 免费（约 500 次搜索 / 1,000 页抓取）",
  keyUrl: "https://www.firecrawl.dev/app/api-keys",
  keyRef: "FIRECRAWL_API_KEY",
  functions: ["search", "fetch"],
  defaultBaseURL: FIRECRAWL_DEFAULT_BASE_URL,
  /** 推荐理由：抓取兜底。 */
  tips: { fetch: "tipFirecrawlFetch" },

  async search(ctx, request, options, signal) {
    const limit = Math.max(1, Math.min(options.maxResults, request.maxResults ?? options.maxResults));
    const response = await postJSON(endpoint(options.baseURL, "/v2/search"), {
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: { query: request.query, limit },
      signal,
      timeoutMs: options.timeoutMs,
      what: "Firecrawl 搜索",
      fetchImpl: options.fetchImpl,
    });
    if (!response.ok) throw httpFailure("Firecrawl 搜索", response);
    if (response.json?.success === false) {
      throw new PlatformFailure("error", `Firecrawl 搜索失败${errorDetail(response)}`);
    }
    return {
      sources: firecrawlSearchItems(response.json).slice(0, limit).map((item) => {
        if (item === null || typeof item !== "object" || typeof item.url !== "string" || item.url.length === 0) return undefined;
        const snippet = clip(item.description ?? item.snippet);
        return {
          url: item.url,
          ...(clip(item.title) !== undefined ? { title: clip(item.title) } : {}),
          ...(snippet !== undefined ? { snippet } : {}),
        };
      }).filter(Boolean),
      truncated: false,
    };
  },

  async fetch(ctx, request, options, signal) {
    const body = {
      url: request.url,
      // 显式锁定 formats，避免命中加价选项。
      formats: ["markdown"],
      onlyMainContent: options.onlyMainContent !== false,
    };
    const response = await postJSON(endpoint(options.baseURL, "/v2/scrape"), {
      headers: { authorization: `Bearer ${options.apiKey}` },
      body,
      signal,
      timeoutMs: options.timeoutMs,
      what: "Firecrawl 抓取",
      fetchImpl: options.fetchImpl,
    });
    if (!response.ok) {
      const failure = httpFailure("Firecrawl 抓取", response);
      if (failure.kind === "not-found") return notFoundResult(request.url, response.status);
      throw failure;
    }
    if (response.json?.success !== true) {
      const detail = errorDetail(response);
      if (/(404|410)|not found/iu.test(detail)) return notFoundResult(request.url, 404);
      throw new PlatformFailure("error", `Firecrawl 抓取失败（HTTP ${response.status}）${detail}`);
    }
    const data = response.json.data ?? {};
    const metadata = data.metadata ?? {};
    const statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200;
    const finalUrl = typeof metadata.url === "string" && metadata.url.length > 0 ? metadata.url : request.url;
    const content = typeof data.markdown === "string" ? data.markdown : "";
    if (statusCode >= 400) return fetchResult(finalUrl, statusCode, content);
    if (content.length === 0 || isSparse(content, options.minChars)) {
      throw new PlatformFailure("empty", "Firecrawl 返回了空文档");
    }
    return fetchResult(finalUrl, 200, content);
  },
};
//#endregion

/** 平台表；顺序即设置页里的展示顺序。 */
export const PLATFORMS = [deepseek, parallel, tavily, firecrawl];
/** id → 平台。 */
export const PLATFORM_BY_ID = new Map(PLATFORMS.map((platform) => [platform.id, platform]));

/** 平台是否支持某个功能。 */
export function platformSupports(platform, fn) {
  return platform.functions.includes(fn);
}

/** 建设置页/README 用的平台元信息（不含实现）。 */
export function platformMeta() {
  return PLATFORMS.map(({ id, label, quota, keyUrl, keyRef, managed, tips, functions, defaultBaseURL }) => ({
    id, label, quota, keyUrl, keyRef, managed: managed === true, tips: tips ?? {}, functions, defaultBaseURL,
  }));
}

/**
 * 解析平台密钥；没有则抛出「缺少密钥」。
 * @param resolver - 该平台一次操作用的凭据解析器。
 * @param platform - 平台描述。
 */
async function requireKey(resolver, platform) {
  const value = await resolver.resolve();
  if (typeof value !== "string" || value.length === 0) throw credentialFailure(platform.label, resolver.envName);
  return value;
}

/**
 * 构造一次操作里某个平台要用的选项。
 * 由宿主自家凭据管理的平台（DeepSeek 官方）不需要本插件解析密钥。
 * @param ctx - 插件上下文。
 * @param platform - 平台描述。
 * @param config - 已快照的配置。
 */
export async function platformOptions(ctx, platform, config) {
  const apiKey = platform.managed === true
    ? undefined
    : await requireKey(config.resolverFor(platform.id), platform);
  return {
    apiKey,
    baseURL: config.baseURLFor(platform.id),
    minChars: config.minChars,
    maxResults: config.maxResults,
    timeoutMs: config.timeoutMsFor(platform.id),
    onlyMainContent: config.onlyMainContent,
    fetchImpl: config.fetchImpl,
  };
}

/** 平台是否配置了密钥（设置页与降级决策共用，不抛错）。 */
export async function hasPlatformKey(config, platformId) {
  const platform = PLATFORM_BY_ID.get(platformId);
  if (platform === undefined) return false;
  try {
    const value = await config.resolverFor(platformId).resolve();
    return typeof value === "string" && value.length > 0;
  } catch {
    return false;
  }
}

/** 让 WebError 在跨平台失败里也能保留语义。 */
export function chainFailure(label, attempts) {
  return new WebError(`${label}失败：${attempts.join("；")}`, "WEB_PROVIDER_ERROR");
}
