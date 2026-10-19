/**
 * DSH-Enhance — 出站 HTTP：统一超时、取消与错误归一。
 *
 * 所有网络失败都归一成 WebError，上层只需要判断「要不要换下一个候选平台」，
 * 不必分辨 Node 的各种底层异常。
 */
import { WebError } from "@deepseek-ai/dsh-web";
import { USER_AGENT, describeError } from "./config.js";

/** 调用方主动取消。 */
export function abortError(signal, what) {
  return new WebError(`${what} aborted`, "WEB_ABORTED", {
    cause: signal?.aborted === true ? signal.reason : undefined,
  });
}

/** 进入网络调用前先看一次取消信号。 */
export function throwIfAborted(signal, what) {
  if (signal?.aborted === true) throw abortError(signal, what);
}

/** 调用方是否已经取消（用于决定「不再降级」）。 */
export function isAborted(signal) {
  return signal?.aborted === true;
}

async function readBody(response, signal, what, fail) {
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    throw fail(error);
  }
  let json;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, ok: response.ok, headers: response.headers, json, text };
}

/**
 * 发一次 JSON POST，返回 `{ status, ok, headers, json, text }`。
 * HTTP 状态码原样返回，由各平台适配器决定哪些状态码意味着「该换下一家」。
 */
export async function postJSON(url, { body, headers, signal, timeoutMs, what, fetchImpl = fetch }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const fail = (error) => {
    if (signal?.aborted === true) return abortError(signal, what);
    if (timeoutSignal.aborted === true) {
      return new WebError(`${what} timed out after ${timeoutMs} ms`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    return new WebError(`${what} failed: ${describeError(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    throw fail(error);
  }
  return readBody(response, signal, what, fail);
}

/** 发一次 GET，返回与 postJSON 相同的形状。 */
export async function getText(url, { headers, signal, timeoutMs, what, fetchImpl = fetch }) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const fail = (error) => {
    if (signal?.aborted === true) return abortError(signal, what);
    if (timeoutSignal.aborted === true) {
      return new WebError(`${what} timed out after ${timeoutMs} ms`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    return new WebError(`${what} failed: ${describeError(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "accept": "text/plain, text/markdown, */*",
        "user-agent": USER_AGENT,
        ...headers,
      },
      redirect: "follow",
      signal: combined,
    });
  } catch (error) {
    throw fail(error);
  }
  return readBody(response, signal, what, fail);
}
