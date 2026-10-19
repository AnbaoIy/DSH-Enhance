/**
 * DSH-Enhance — 配置与凭据解析。
 *
 * 凭据来源优先级（与 dsh 内置 provider 一致）：
 *   1. config 里写的字面量 apiKey
 *   2. ctx.get("credentials") 凭据服务里按引用名存的值（设置页写入的那份）
 *   3. dsh 启动环境里的同名环境变量
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

/** 出站请求的 User-Agent。 */
export const USER_AGENT = "dsh-enhance/1.0.0";

/**
 * 为一条凭据建解析器。
 * @param ctx - 插件上下文，用于取 credentials 服务与启动环境。
 * @param apiKeyEnv - 凭据引用名 / 环境变量名。
 * @param literalApiKey - config 里的字面量 key（可为空）。
 */
export function createCredentialResolver(ctx, { apiKeyEnv, literalApiKey }) {
  const envName = credentialRef(apiKeyEnv);
  const literal = typeof literalApiKey === "string" && literalApiKey.trim().length > 0
    ? literalApiKey.trim()
    : undefined;

  const ambientValue = () => {
    const entry = launchEnvironmentOf(ctx)?.get?.(envName);
    return typeof entry?.value === "string" && entry.value.length > 0 ? entry.value : undefined;
  };

  return {
    envName,
    /** 解析出真正用于请求的 key；没有则返回 undefined。 */
    async resolve() {
      if (literal !== undefined) return literal;
      const credentials = ctx.get?.("credentials");
      if (credentials !== undefined) {
        try {
          const credential = await credentials.resolve(envName);
          if (typeof credential?.value === "string" && credential.value.length > 0) return credential.value;
        } catch {
          // 凭据服务读不到时退回启动环境。
        }
      }
      return ambientValue();
    },
  };
}

/** 正整数校验。 */
export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** 规范化 baseURL：必须是 http(s) 且去掉尾部斜杠。 */
export function normaliseBaseURL(value, fallback) {
  const raw = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  if (!URL.canParse(raw)) throw new Error(`dsh-enhance: invalid baseURL "${raw}"`);
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`dsh-enhance: baseURL must be http(s), got "${raw}"`);
  }
  return raw.replace(/\/+$/u, "");
}

/** 把 baseURL 与路径拼成完整端点。 */
export function endpoint(baseURL, path) {
  return `${baseURL.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** 从响应体里尽量抠出一条人类可读的错误说明。 */
export function errorDetail(response) {
  const json = response?.json;
  const message = typeof json?.error === "string" ? json.error
    : typeof json?.error?.message === "string" ? json.error.message
    : typeof json?.detail === "string" ? json.detail
    : typeof json?.message === "string" ? json.message
    : undefined;
  if (message !== undefined && message.length > 0) return `: ${message}`;
  const text = typeof response?.text === "string" ? response.text.trim() : "";
  return text.length > 0 ? `: ${text.slice(0, 300)}` : "";
}

/** 把任意异常压成一行可读文本。 */
export function describeError(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message.length > 0 && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}
