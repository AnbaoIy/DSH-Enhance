/**
 * 测试替身：@deepseek-ai/dsh-web
 *
 * lib/ 只用到 WebError 的 code 字段（seam 用 code 区分 WEB_PROVIDER_ERROR 等）。
 * 真实包由 dsh 自带。
 */
export class HarnessError extends Error {
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = "HarnessError";
    this.code = code;
  }
}

export class WebError extends HarnessError {
  constructor(message, code, options = {}) {
    super(message, code, options);
    this.name = "WebError";
  }
}
