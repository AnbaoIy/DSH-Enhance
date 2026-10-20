/**
 * DSH-Enhance — 宿主侧的会话操作：移动到其它工作区、永久删除。
 *
 * HTTP 契约（浏览器半边用 fetch 调用，见 lib/client.js）：
 *   POST /dsh-enhance/move-session    { sessionId, targetWorkspaceId }
 *   POST /dsh-enhance/move-workspace  { sourceWorkspaceId, targetWorkspaceId }
 *   POST /dsh-enhance/delete-session  { sessionId }
 *   POST /dsh-enhance/list-workspaces {}
 *
 * 移动的实现要点：工作区成员资格由会话 header.cwd 的 canonical 路径决定，
 * 而 header 不可改写，所以「移动」= 在目标工作区路径下重建一份携带完整历史的
 * 新会话（同一个 createdAt / agentPreset），再归档并摘除原会话。
 */
import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 一次删除记下的墓碑身份，用来挡住 stale list() 把已删会话重新编入索引。 */
const GUARDS = new WeakMap();

function messageOf(error) {
  return (error && error.message) || String(error);
}

function fail(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** 取一个服务，缺失时给出可读错误。 */
function requireServices(ctx, keys) {
  const missing = [];
  const services = {};
  for (const key of keys) {
    const value = ctx.get(key);
    if (value === undefined) missing.push(key);
    services[key] = value;
  }
  if (missing.length > 0) {
    return { error: `宿主服务不可用：${missing.join("、")}` };
  }
  return { services };
}

/**
 * 读取一个会话的 header。
 * 顺序按代价从低到高：实时实例 → 按 id 直读 → 全量列表（最后兜底，
 * 因为 list() 会把整个会话目录扫一遍）。
 */
async function readHeader(ctx, sessionId) {
  const live = ctx.get("sessions")?.get?.(sessionId);
  if (live?.header !== undefined) return live.header;
  const sessionQuery = ctx.get("sessionQuery");
  if (sessionQuery !== undefined && typeof sessionQuery.readSession === "function") {
    try {
      const snapshot = await sessionQuery.readSession(sessionId);
      if (snapshot?.session !== undefined) return snapshot.session;
    } catch {
      // 直读不到时退回全量列表。
    }
  }
  const persistence = ctx.get("sessionPersistence");
  if (persistence !== undefined && typeof persistence.list === "function") {
    try {
      const listed = await persistence.list();
      const hit = listed.find((item) => item.header?.id === sessionId);
      if (hit !== undefined) return hit.header;
    } catch {
      // 列表也读不到就只能返回 undefined。
    }
  }
  return undefined;
}

/** 判断某个会话此刻是否有 agent 在跑。 */
function agentStatus(ctx, sessionId) {
  try {
    return ctx.get("agents")?.get?.(sessionId)?.status;
  } catch {
    return undefined;
  }
}

/**
 * 把会话从所有工作区的成员列表里摘掉。
 * 迁移与删除都需要这一步，此前两处各写了一遍。
 */
async function detachFromWorkspaces(registry, sessionId) {
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue;
    try {
      await workspace.detachSession(sessionId);
    } catch {
      // 单个工作区摘除失败不影响后续步骤。
    }
  }
}

/** 迁移后新会话的 id：与宿主 createMinted 一致，避免和磁盘上已有的 `session-<n>` 撞号。 */
function mintedSessionId() {
  return `session-${randomUUID()}`;
}

/**
 * 在目标工作区里重建迁移后的会话。
 *
 * 两条通道：
 *   1. 有持久化后端时，先 `sessions.prepare()` 只构造、**不进入**运行时 store，
 *      再用 `sessionPersistence.create/append/flush/close` 把同一份历史写到目标
 *      目录，最后关闭写句柄。
 *      —— 必须写盘：`sessions.create()` 只往内存 store 里塞一个会话，持久层不会
 *      收到 `session/created`，也就不会为它开写句柄；随后 `sessions.flush()` 找不到
 *      writer 直接空转。于是文件从未产生，用户点开会话时 `agents.resume()` 在
 *      `sessionPersistence.open(id, "write")` 上抛 NotFound（表现为「无法连接模型 /
 *      找不到对话」），重启后会话也从列表里消失。
 *      —— 必须不进入 store：会话一旦 live，之后的 resume 会走到
 *      `SessionStore.prepare()` 并以 "session already exists" 失败，等于点不开。
 *   2. 没有持久化后端时退回纯内存 `sessions.create()`（此时没有磁盘可写，
 *      它至少还能被目标工作区接管）。
 */
async function rebuildSession(ctx, services, target, snapshot, newId) {
  const header = snapshot.session;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const inherited = header.isSeeded === true ? (snapshot.inheritedEventCount ?? 0) : 0;
  const options = {
    seed: events,
    ...(inherited > 0 ? { inheritedEventCount: inherited } : {}),
    meta: {
      cwd: target.path,
      createdAt: header.createdAt,
      isSeeded: header.isSeeded === true,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    },
  };

  const persistence = ctx.get("sessionPersistence");
  if (typeof persistence?.create === "function" && typeof services.sessions.prepare === "function") {
    const session = services.sessions.prepare(newId, options);
    const log = session.snapshotEvents();
    let handle;
    try {
      handle = await persistence.create(session.header, { inheritedEventCount: session.inheritedEventCount });
      if (log.length > 0) await handle.append(log);
      await handle.flush();
      await handle.close();
    } catch (error) {
      try {
        await handle?.close?.();
      } catch {
        // 关闭失败不掩盖真正的写入错误。
      }
      // 只按我们自己知道的那份 header 回滚，绝不走 deleteSession 的重新读取
      // （那会把「重建失败」变成「顺手删掉别的会话」）。
      await discardRebuilt(ctx, persistence, session.header);
      throw error;
    }
    return newId;
  }

  const created = services.sessions.create(newId, options);
  return created?.id ?? created?.header?.id ?? newId;
}

/** 清掉重建失败留下的半成品：会话目录与 spill。 */
async function discardRebuilt(ctx, persistence, header) {
  try {
    const location = await persistence.locate?.(header);
    if (location !== undefined && typeof location.path === "string") {
      await removeTranscript(location.path);
    }
  } catch {
    // 半成品清理失败不改变主结论。
  }
  await cleanSpill(ctx, header.id);
}

/**
 * 迁移所需的宿主服务与目标工作区，一次解析、多次复用。
 * 批量迁移时避免对每个会话重复 ctx.get()。
 */
function resolveMove(ctx, targetWorkspaceId, sourceWorkspaceId) {
  if (typeof targetWorkspaceId !== "string" || targetWorkspaceId.length === 0) {
    return { error: "targetWorkspaceId 必须是非空字符串" };
  }
  const { services, error } = requireServices(ctx, ["sessions", "sessionQuery", "workspaceRegistry"]);
  if (error !== undefined) return { error };
  const target = services.workspaceRegistry.get(targetWorkspaceId);
  if (target === undefined) return { error: "目标工作区不存在" };

  let source;
  if (sourceWorkspaceId !== undefined) {
    source = services.workspaceRegistry.get(sourceWorkspaceId);
    if (source === undefined) return { error: "源工作区不存在" };
    if (source.id === target.id) return { error: "源工作区与目标工作区相同" };
  }
  return { services, target, source };
}

/** 新建的会话没被目标工作区接管时把它清掉，避免留下空对话。 */
async function rollbackCreated(ctx, sessionId) {
  if (typeof sessionId !== "string") return;
  try {
    await deleteSession(ctx, sessionId);
  } catch {
    // 回滚失败不改变主结论。
  }
}

/**
 * 迁移一个会话：在目标工作区路径下用完整历史重建一份，然后**删除**原会话。
 *
 * 两个关键决定：
 *   1. 重建必须真的落到目标目录（见 {@link rebuildSession}），且不进入运行时
 *      store；只写内存不写盘会让会话「看着在、点不开、重启就没」。
 *   2. 原会话删除而不是归档。归档会把它留在归档列表里，看起来像多出一份。
 */
async function moveOne(ctx, services, target, sessionId) {
  if (agentStatus(ctx, sessionId) === "running") {
    return fail("该对话正在运行，请等它结束或先中断后再移动");
  }

  let snapshot;
  try {
    snapshot = await services.sessionQuery.readSession(sessionId);
  } catch (readError) {
    return fail(`读取会话失败：${messageOf(readError)}`);
  }
  const header = snapshot.session;
  if (header.cwd === target.path) return fail("该对话已经属于这个工作区");
  if (header.origin === "subagent") return fail("子代理会话不支持移动");

  // 显式 mint：store 的 `session-<n>` 计数器重启后归零，会和磁盘上已有的同号会话撞车。
  const newId = mintedSessionId();

  try {
    await rebuildSession(ctx, services, target, snapshot, newId);
  } catch (createError) {
    return fail(`创建目标会话失败：${messageOf(createError)}`);
  }

  try {
    await target.attachSession(newId);
  } catch (attachError) {
    await rollbackCreated(ctx, newId);
    return fail(`目标工作区接管失败：${messageOf(attachError)}`);
  }

  // 先从源工作区记账里摘掉，随后的删除再兜一次。
  await detachFromWorkspaces(services.workspaceRegistry, sessionId);

  const removal = await deleteSession(ctx, sessionId);
  if (removal.ok !== true) {
    return {
      ok: true,
      newSessionId: newId,
      targetWorkspaceId: target.id,
      targetTitle: target.title,
      warning: `新对话已建好，但原对话未能删除：${removal.error}`,
    };
  }

  return {
    ok: true,
    newSessionId: newId,
    removedSessionId: sessionId,
    targetWorkspaceId: target.id,
    targetTitle: target.title,
  };
}

/**
 * 把一个会话迁移到另一个工作区（拖动单条对话走这里）。
 * @param ctx - 宿主上下文。
 * @param sessionId - 源会话。
 * @param targetWorkspaceId - 目标工作区。
 */
export async function moveSession(ctx, sessionId, targetWorkspaceId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return fail("sessionId 必须是非空字符串");
  const resolved = resolveMove(ctx, targetWorkspaceId);
  if (resolved.error !== undefined) return fail(resolved.error);
  return moveOne(ctx, resolved.services, resolved.target, sessionId);
}

/**
 * 把一个工作区的全部对话迁移到另一个工作区（工作区菜单的「修改工作区」）。
 * @param ctx - 宿主上下文。
 * @param sourceWorkspaceId - 源工作区。
 * @param targetWorkspaceId - 目标工作区。
 */
export async function moveWorkspace(ctx, sourceWorkspaceId, targetWorkspaceId) {
  if (typeof sourceWorkspaceId !== "string" || sourceWorkspaceId.length === 0) {
    return fail("sourceWorkspaceId 必须是非空字符串");
  }
  const resolved = resolveMove(ctx, targetWorkspaceId, sourceWorkspaceId);
  if (resolved.error !== undefined) return fail(resolved.error);
  const { services, target, source } = resolved;

  // 先快照成员列表：迁移过程中源工作区的 sessionIds 会因删除而缩短。
  const ids = [...source.sessionIds];
  if (ids.length === 0) return fail("该工作区没有可迁移的对话");

  const moved = [];
  const failed = [];
  for (const sessionId of ids) {
    const result = await moveOne(ctx, services, target, sessionId);
    if (result.ok === true) moved.push(sessionId);
    else failed.push({ sessionId, error: result.error });
  }
  return {
    ok: moved.length > 0,
    movedCount: moved.length,
    failedCount: failed.length,
    failed: failed.slice(0, 20),
    targetWorkspaceId: target.id,
    targetTitle: target.title,
    ...(moved.length === 0 ? { error: failed[0]?.error ?? "没有对话被迁移" } : {}),
  };
}

/** 官方 JSONL 后端的工件命名。 */
const SESSION_ARTIFACT = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?/u;

/**
 * 删除会话的转录工件。只有当会话目录里只剩该会话自己的工件时才连同目录一起删，
 * 否则只删定位到的那个文件，绝不误伤同目录下的其它内容。
 */
async function removeTranscript(locationPath) {
  const name = basename(locationPath);
  if (!SESSION_ARTIFACT.test(name)) {
    throw new Error(`refusing to delete unexpected session artifact "${locationPath}"`);
  }
  const directory = dirname(locationPath);
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch {
    entries = [];
  }
  const onlyOwnArtifacts = entries.length > 0 && entries.every((entry) => SESSION_ARTIFACT.test(entry));
  const target = onlyOwnArtifacts ? directory : locationPath;
  await rm(target, { recursive: true, force: true });
  return target;
}

/** spill 目录名与 dsh-spill-local 的 sessionDir 保持一致。 */
function spillDirectory(root, sessionId) {
  return join(root, `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`);
}

/** 尽力而为的 spill 清理。 */
async function cleanSpill(ctx, sessionId) {
  try {
    const spill = ctx.get("spillStore");
    if (typeof spill?.root !== "string") return;
    await rm(spillDirectory(spill.root, sessionId), { recursive: true, force: true });
  } catch {
    // spill 清理失败不影响删除结论。
  }
}

/**
 * 让工作区注册表忘掉这个会话，并留一个墓碑挡住 stale list() 的重新编入。
 * 首次调用时给注册表实例装一层 indexHeader 守卫，插件卸载时还原。
 */
function forgetSession(registry, sessionId, header) {
  let guard = GUARDS.get(registry);
  if (guard === undefined) {
    const tombstones = new Map();
    const hadOwn = Object.hasOwn(registry, "indexHeader");
    const original = registry.indexHeader;
    if (typeof original === "function") {
      const guarded = async function (candidate) {
        const identity = tombstones.get(candidate?.id);
        if (identity !== undefined && identity.createdAt === candidate.createdAt && (identity.cwd ?? null) === (candidate.cwd ?? null)) {
          return;
        }
        if (identity !== undefined) tombstones.delete(candidate.id);
        return original.call(this, candidate);
      };
      registry.indexHeader = guarded;
      guard = {
        tombstones,
        restore() {
          if (registry.indexHeader === guarded) {
            if (hadOwn) registry.indexHeader = original;
            else delete registry.indexHeader;
          }
        },
      };
    } else {
      guard = { tombstones, restore() {} };
    }
    GUARDS.set(registry, guard);
  }
  if (header !== undefined) {
    guard.tombstones.set(sessionId, { createdAt: header.createdAt, cwd: header.cwd ?? null });
  }
  try {
    registry.headers?.delete?.(sessionId);
    registry.sessionPaths?.delete?.(sessionId);
    registry.missingSessionPaths?.delete?.(sessionId);
    registry.invalidSessionPaths?.delete?.(sessionId);
  } catch {
    // 内存索引不可写时跳过。
  }
}

/**
 * 永久删除一个会话及其全部痕迹：转录目录、工作区记账、归档标记、spill。
 * @param ctx - 宿主上下文。
 * @param sessionId - 要删除的会话。
 */
export async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return fail("sessionId 必须是非空字符串");

  const { services, error } = requireServices(ctx, ["sessions", "sessionPersistence", "workspaceRegistry"]);
  if (error !== undefined) return fail(error);
  const { sessions, sessionPersistence: persistence, workspaceRegistry: registry } = services;

  if (agentStatus(ctx, sessionId) === "running") {
    return fail("该对话正在运行，请等它结束后再删除");
  }

  let header;
  try {
    header = await readHeader(ctx, sessionId);
  } catch (readError) {
    return fail(`读取会话失败：${messageOf(readError)}`);
  }
  if (header === undefined) return fail("找不到该对话");

  const live = sessions.get?.(sessionId);
  if (live !== undefined) {
    try {
      await sessions.flush?.(live);
    } catch {
      // 落盘失败也要继续删，删掉的就是磁盘上的那份。
    }
    try {
      const entry = typeof sessions.liveEntryFor === "function" ? sessions.liveEntryFor(live) : undefined;
      if (entry !== undefined && typeof sessions.detachEntered === "function") sessions.detachEntered(entry);
    } catch {
      // 摘除实时实例失败时仍继续，避免留着文件更糟。
    }
  }

  try {
    await ctx.get("sessionProjectionCache")?.delete?.(sessionId);
  } catch {
    // 投影缓存没有 delete（旧版本）时跳过。
  }

  try {
    await registry.unarchiveSession(sessionId);
  } catch {
    // 未归档或归档集合不可写都无妨。
  }

  await detachFromWorkspaces(registry, sessionId);

  if (typeof persistence.locate !== "function") {
    return fail("当前存储后端不支持定位会话文件，无法删除");
  }
  const location = await persistence.locate(header);
  if (location === undefined || typeof location.path !== "string") {
    return fail("存储后端没有给出会话文件位置，无法删除");
  }
  try {
    await removeTranscript(location.path);
  } catch (removeError) {
    return fail(`删除会话文件失败：${messageOf(removeError)}`);
  }

  await cleanSpill(ctx, sessionId);
  forgetSession(registry, sessionId, header);
  try {
    ctx.emit("api-session/removed", sessionId);
  } catch {
    // 通知失败不影响删除。
  }

  return { ok: true, sessionId, cwd: header.cwd, createdAt: header.createdAt };
}

/** 供客户端展示的工作区列表。 */
export function listWorkspaces(ctx) {
  const registry = ctx.get("workspaceRegistry");
  if (registry === undefined) return fail("宿主服务不可用：workspaceRegistry");
  return {
    ok: true,
    items: registry.list().map((workspace) => ({
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length,
    })),
  };
}

/** 读一个 JSON 请求体（上限 1 MiB）。 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

/**
 * 注册宿主路由。
 * @param ctx - 插件上下文。
 * @param runtime - 取当前配置快照的 thunk。
 * @returns 卸载函数。
 */
export function registerRoutes(ctx, runtime) {
  const disposers = [];

  const routes = [
    {
      name: "move-session",
      feature: "moveEnabled",
      handler: async (body) => moveSession(ctx, body?.sessionId, body?.targetWorkspaceId),
    },
    {
      name: "move-workspace",
      feature: "moveEnabled",
      handler: async (body) => moveWorkspace(ctx, body?.sourceWorkspaceId, body?.targetWorkspaceId),
    },
    {
      name: "delete-session",
      feature: "deleteEnabled",
      handler: async (body) => deleteSession(ctx, body?.sessionId),
    },
    {
      name: "list-workspaces",
      handler: async () => listWorkspaces(ctx),
    },
  ];

  const refusedFeature = {
    moveEnabled: "工作区修改功能已在 DSH-Enhance 设置中关闭",
    deleteEnabled: "对话删除功能已在 DSH-Enhance 设置中关闭",
  };

  ctx.inject(["webServer"], (hostCtx) => {
    const server = hostCtx.webServer;
    if (server === undefined || typeof server.register !== "function") return;
    for (const route of routes) {
      try {
        disposers.push(server.register({
          kind: "exact",
          path: `/dsh-enhance/${route.name}`,
          handler: async (request, response) => {
            try {
              if (request.method !== "POST") {
                sendJson(response, 405, { ok: false, error: "method not allowed" });
                return;
              }
              if (route.feature !== undefined && runtime()[route.feature] !== true) {
                sendJson(response, 200, { ok: false, error: refusedFeature[route.feature] });
                return;
              }
              const body = await readJsonBody(request);
              const result = await route.handler(body);
              sendJson(response, 200, result);
            } catch (routeError) {
              sendJson(response, 500, { ok: false, error: messageOf(routeError) });
            }
          },
        }));
      } catch (registerError) {
        ctx.logger?.warn?.(`dsh-enhance: 路由 /dsh-enhance/${route.name} 注册失败：${messageOf(registerError)}`);
      }
    }
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 路由卸载失败不影响插件卸载。
      }
    }
    for (const [registry, guard] of GUARDS.entries?.() ?? []) {
      guard.restore();
      GUARDS.delete(registry);
    }
  };
}
