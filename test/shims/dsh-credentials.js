/**
 * 测试替身：@deepseek-ai/dsh-credentials
 *
 * credentialRef 把配置里的环境变量名规整成一个引用标识。真实包由 dsh 自带。
 */
export function credentialRef(name) {
  return typeof name === "string" && name.length > 0 ? name : "UNKNOWN_CREDENTIAL";
}
