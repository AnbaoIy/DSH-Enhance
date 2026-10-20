/**
 * 测试启动钩子：注册 @deepseek-ai/* 的解析替身。
 *
 * 用法：node --test --test-isolation=none --import ./test/register-shims.mjs 'test/**\/*.test.mjs'
 * （见 package.json 的 scripts.test）
 *
 * 为什么不在 node_modules/ 里放 shim：安装插件用的是 `link:`，整个插件目录会被
 * 链进 profile，插件自己的 node_modules 会遮蔽 dsh 自带的真包。曾经因此让
 * @deepseek-ai/schemastery 解析到替身，缺少 Config["~standard"]，插件激活失败。
 */
import { mkdtempSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 插件把迁移记录与备份写在 $DSH_HOME/workspace-mover 下；测试绝不能碰用户真实目录，
// 所以这里无条件改写（宿主进程本身会带一个指向 ~/.dsh 的 DSH_HOME）。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-enhance-test-home-"));

register("./shims-resolver.mjs", pathToFileURL(import.meta.filename));
