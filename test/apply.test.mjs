import assert from "node:assert/strict";
import test from "node:test";

import { apply, Config, inject, name, PROVIDER_ID } from "../lib/index.js";
import { parseChain } from "../lib/chain.js";
import { PLATFORMS, platformMeta } from "../lib/platforms.js";

/** cordis 交给 apply 的 config 里，叶子字段是 reactive 的。 */
const field = (value) => ({ get: () => value });

function makeConfig(overrides = {}) {
  return {
    enableDelete: field(true),
    enableMove: field(true),
    enableSearch: field(true),
    enableFetch: field(true),
    searchChain: field("deepseek,parallel"),
    fetchChain: field("deepseek,tavily"),
    totalTimeoutMs: field(28000),
    platformTimeoutMs: field(15000),
    minChars: field(500),
    maxResults: field(8),
    onlyMainContent: field(true),
    ...overrides,
  };
}

/** 造一个带内置 provider 的假宿主。 */
function makeCtx(options = {}) {
  const searchProviders = [];
  const fetchProviders = [];
  const builtinSearch = new Map();
  const builtinFetch = new Map();
  if (options.deepseekSearch) builtinSearch.set("deepseek-official", options.deepseekSearch);
  if (options.deepseekFetch) builtinFetch.set("http", options.deepseekFetch);
  const ctx = {
    get: () => undefined,
    inject(keys, callback) {
      if (keys.includes("webServer")) return () => {};
      return callback(ctx);
    },
    logger: { warn() {} },
    web: {
      searchProviders: builtinSearch,
      fetchProviders: builtinFetch,
      registerSearchProvider(provider) {
        searchProviders.push(provider);
        builtinSearch.set(provider.id, provider);
        return () => {};
      },
      registerFetchProvider(provider) {
        fetchProviders.push(provider);
        builtinFetch.set(provider.id, provider);
        return () => {};
      },
    },
  };
  return { ctx, searchProviders, fetchProviders };
}

test("插件名、provider id 与 inject 稳定", () => {
  assert.equal(name, "dsh-enhance");
  assert.equal(PROVIDER_ID, "dsh-enhance");
  // 不硬依赖任何服务：web 缺失时只降级搜索替换，不允许整插件加载失败。
  assert.deepEqual(inject, []);
});

test("apply 各注册一个搜索与抓取提供方", () => {
  const { ctx, searchProviders, fetchProviders } = makeCtx();
  const dispose = apply(ctx, makeConfig());
  assert.deepEqual(searchProviders.map((provider) => provider.id), ["dsh-enhance"]);
  assert.deepEqual(fetchProviders.map((provider) => provider.id), ["dsh-enhance"]);
  assert.equal(typeof dispose, "function");
});

test("平台表只有 DeepSeek 官方 + 三个第三方平台", () => {
  assert.deepEqual(PLATFORMS.map((platform) => platform.id), ["deepseek", "parallel", "tavily", "firecrawl"]);
});

test("只有 DeepSeek 官方标为宿主托管，其余都要自己配 key", () => {
  const managed = platformMeta().filter((platform) => platform.managed === true).map((platform) => platform.id);
  assert.deepEqual(managed, ["deepseek"]);
});

test("Config 不再暴露搜索强度字段，只保留链与开关", () => {
  const keys = Object.keys(Config.meta.shape);
  assert.ok(keys.includes("searchChain"));
  assert.ok(keys.includes("fetchChain"));
  assert.ok(keys.includes("enableDelete"));
  assert.ok(keys.includes("enableMove"));
  assert.ok(keys.includes("enableSearch"));
  assert.ok(!keys.includes("searchMode"));
  assert.ok(!keys.includes("fetchMode"));
});

test("parseChain 丢弃未知平台、去重、保留顺序", () => {
  assert.deepEqual(parseChain("deepseek,parallel", "deepseek"), ["deepseek", "parallel"]);
  assert.deepEqual(parseChain("tavily,,tavily,unknown,firecrawl", "deepseek"), ["tavily", "firecrawl"]);
  assert.deepEqual(parseChain("", "deepseek,tavily"), ["deepseek", "tavily"]);
  assert.deepEqual(parseChain(undefined, "deepseek,parallel"), ["deepseek", "parallel"]);
});

test("DeepSeek 官方直接委托内置 provider，不再自己解析 key", async () => {
  const seen = [];
  const { ctx } = makeCtx({
    deepseekSearch: {
      id: "deepseek-official",
      available: () => true,
      async search(request) {
        seen.push(request.query);
        return { sources: [{ url: "https://official.example" }], truncated: false };
      },
    },
  });
  apply(ctx, makeConfig({ searchChain: field("deepseek") }));
  const provider = ctx.web.searchProviders.get("dsh-enhance");
  const result = await provider.search({ query: "hello" });
  assert.deepEqual(seen, ["hello"]);
  assert.equal(result.sources[0].url, "https://official.example");
});

test("内置抓取 provider 返回时同样被转交", async () => {
  const { ctx } = makeCtx({
    deepseekFetch: {
      id: "http",
      available: () => true,
      async fetch(request) {
        return { url: request.url, statusCode: 200, body: { kind: "text", content: "hello" }, truncated: false };
      },
    },
  });
  apply(ctx, makeConfig({ fetchChain: field("deepseek") }));
  const provider = ctx.web.fetchProviders.get("dsh-enhance");
  const result = await provider.fetch({ url: "https://a.example" });
  assert.equal(result.body.content, "hello");
});

test("内置 provider 不可用时换候补平台", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ results: [{ url: "https://b.example" }] }), { status: 200 });
  };
  try {
    const { ctx } = makeCtx();
    apply(ctx, makeConfig({
      searchChain: field("deepseek,tavily"),
      tavilyApiKey: field("tvly-key"),
    }));
    const provider = ctx.web.searchProviders.get("dsh-enhance");
    const result = await provider.search({ query: "x" });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /tavily\.com\/search$/u);
    assert.equal(result.sources[0].url, "https://b.example");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("关闭搜索替换后转交宿主其它 provider", async () => {
  const seen = [];
  const { ctx } = makeCtx();
  ctx.web.searchProviders.set("shipped", {
    id: "shipped",
    available: () => true,
    async search(request) {
      seen.push(request.query);
      return { sources: [], truncated: false };
    },
  });
  apply(ctx, makeConfig({ enableSearch: field(false) }));
  const provider = ctx.web.searchProviders.get("dsh-enhance");
  await provider.search({ query: "hello" });
  assert.deepEqual(seen, ["hello"]);
});

test("关闭搜索替换且没有其它 provider 时报 WEB_PROVIDER_UNAVAILABLE", async () => {
  const { ctx } = makeCtx();
  apply(ctx, makeConfig({ enableSearch: field(false) }));
  const provider = ctx.web.searchProviders.get("dsh-enhance");
  await assert.rejects(
    () => provider.search({ query: "hello" }),
    (error) => error.code === "WEB_PROVIDER_UNAVAILABLE",
  );
});

test("第三方平台 429 时换到候补平台", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("tavily")) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    return new Response(JSON.stringify({ results: [{ url: "https://b.example" }] }), { status: 200 });
  };
  try {
    const { ctx } = makeCtx();
    apply(ctx, makeConfig({
      searchChain: field("tavily,firecrawl"),
      tavilyApiKey: field("tvly"),
      firecrawlApiKey: field("fc"),
    }));
    const provider = ctx.web.searchProviders.get("dsh-enhance");
    const result = await provider.search({ query: "x" });
    assert.equal(calls.length, 2);
    assert.match(calls[1], /firecrawl\.dev\/v2\/search$/u);
    assert.equal(result.sources[0].url, "https://b.example");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("全部平台失败时抛出带每次尝试的 WebError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
  try {
    const { ctx } = makeCtx();
    apply(ctx, makeConfig({
      searchChain: field("parallel,tavily"),
      parallelApiKey: field("a"),
      tavilyApiKey: field("b"),
    }));
    const provider = ctx.web.searchProviders.get("dsh-enhance");
    await assert.rejects(
      () => provider.search({ query: "x" }),
      (error) => error.code === "WEB_PROVIDER_ERROR" && /Parallel/u.test(error.message) && /Tavily/u.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("抓取时优先平台返回反爬页会换到候补平台", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("tavily")) {
      return new Response(JSON.stringify({
        results: [{ url: "https://target.example", raw_content: "Just a moment... checking your browser" }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      success: true,
      data: { markdown: "# 正文\n\n这是一段足够长的内容，用来通过稀疏判定。".repeat(40), metadata: { statusCode: 200, url: "https://target.example" } },
    }), { status: 200 });
  };
  try {
    const { ctx } = makeCtx();
    apply(ctx, makeConfig({
      fetchChain: field("tavily,firecrawl"),
      tavilyApiKey: field("tvly"),
      firecrawlApiKey: field("fc"),
    }));
    const provider = ctx.web.fetchProviders.get("dsh-enhance");
    const result = await provider.fetch({ url: "https://target.example" });
    assert.equal(calls.length, 2);
    assert.equal(result.statusCode, 200);
    assert.match(result.body.content, /正文/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("只有官方一项时，内置接口的错误原样抛出，不换成插件措辞", async () => {
  const original = Object.assign(new Error("deepseek official exploded"), { code: "WEB_PROVIDER_CREDENTIAL_MISSING" });
  const { ctx } = makeCtx({
    deepseekSearch: {
      id: "deepseek-official",
      available: () => true,
      async search() { throw original; },
    },
  });
  apply(ctx, makeConfig({ searchChain: field("deepseek") }));
  const provider = ctx.web.searchProviders.get("dsh-enhance");
  await assert.rejects(() => provider.search({ query: "x" }), (error) => error === original);
});

test("官方在链首失败时仍然换到候补平台", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ results: [{ url: "https://fallback.example" }] }), { status: 200 });
  };
  try {
    const { ctx } = makeCtx({
      deepseekSearch: {
        id: "deepseek-official",
        available: () => true,
        async search() { throw new Error("official down"); },
      },
    });
    apply(ctx, makeConfig({
      searchChain: field("deepseek,tavily"),
      tavilyApiKey: field("tvly"),
    }));
    const provider = ctx.web.searchProviders.get("dsh-enhance");
    const result = await provider.search({ query: "x" });
    assert.equal(result.sources[0].url, "https://fallback.example");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("推荐平台带提示文案键", () => {
  const meta = platformMeta();
  assert.equal(meta.find((platform) => platform.id === "parallel").tips.search, "tipParallelSearch");
  assert.equal(meta.find((platform) => platform.id === "tavily").tips.fetch, "tipTavilyFetch");
  assert.equal(meta.find((platform) => platform.id === "firecrawl").tips.fetch, "tipFirecrawlFetch");
});

test("宿主没有 web 服务时插件仍能加载，只失去搜索替换", () => {
  const routes = [];
  const ctx = {
    get: () => undefined,
    inject(keys, callback) {
      // web 缺失：cordis 永远不回调；webServer 存在：照常挂路由。
      if (keys.includes("web")) return () => {};
      if (keys.includes("webServer")) {
        callback({ webServer: { register(route) { routes.push(route.path); return () => {}; } } });
      }
      return () => {};
    },
    logger: { warn() {} },
  };
  const dispose = apply(ctx, makeConfig());
  assert.deepEqual(routes, [
    "/dsh-enhance/move-session",
    "/dsh-enhance/move-workspace",
    "/dsh-enhance/delete-session",
    "/dsh-enhance/list-workspaces",
  ]);
  assert.equal(typeof dispose, "function");
});

test("抓取遇到 404 时直接返回结果，不降级再花一次额度", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
  try {
    const { ctx } = makeCtx();
    apply(ctx, makeConfig({
      fetchChain: field("tavily,firecrawl"),
      tavilyApiKey: field("tvly"),
      firecrawlApiKey: field("fc"),
    }));
    const provider = ctx.web.fetchProviders.get("dsh-enhance");
    const result = await provider.fetch({ url: "https://gone.example" });
    assert.equal(result.statusCode, 404);
    assert.equal(result.body.content, "");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
