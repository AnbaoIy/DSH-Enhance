/**
 * DSH-Enhance — 宿主侧的会话操作：移动到其它工作区、永久删除。
 *
 * HTTP 契约（浏览器半边用 fetch 调用，见 lib/client.js）：
 *   POST /dsh-enhance/move-session     { sessionId, targetWorkspaceId }
 *   POST /dsh-enhance/move-workspace   { sourceWorkspaceId, targetWorkspaceId }
 *   POST /dsh-enhance/delete-session   { sessionId }
 *   POST /dsh-enhance/move-history     {}
 *   POST /dsh-enhance/restore-session  { backupId }
 *   POST /dsh-enhance/list-workspaces  {}
 *
 * 移动的实现要点：工作区成员资格由会话 header.cwd 的 canonical 路径决定，
 * 而 header 不可改写，所以「移动」= 在目标工作区路径下重建一份携带完整历史的
 * 新会话（同一个 createdAt / agentPreset），再归档并摘除原会话。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** 一次删除记下的墓碑身份，用来挡住 stale list() 把已删会话重新编入索引。 */
const GUARDS = new WeakMap();

/**
 * 迁移记录与备份的落盘位置。
 * 与老版 workspace-mover 共用同一个目录和 history.json，历史记录可以直接续读。
 */
function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === "string" && configured.trim().length > 0) return resolve(configured.trim());
  return join(homedir(), ".dsh");
}

/** 迁移记录与备份所在的目录。 */
function moverDir() {
  return join(dshHome(), "workspace-mover");
}

function backupDir() {
  return join(moverDir(), "backups");
}

function historyFile() {
  return join(moverDir(), "history.json");
}

/** 备份文件名的白名单：恢复路由的入参直接来自浏览器，不能拼路径。 */
const BACKUP_ID = /^[0-9a-f-]{36}$/u;

/** 迁移记录保留时间：超过 3 天的记录连同备份一起清掉。 */
const HISTORY_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** history.json 的读改写串行化：批量迁移会连续写多条记录。 */
let historyTail = Promise.resolve();

function withHistoryLock(operation) {
  const result = historyTail.then(operation, operation);
  historyTail = result.then(() => {}, () => {});
  return result;
}

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
    return {
      header: session.header,
      inheritedEventCount: session.inheritedEventCount ?? inherited,
      events: log,
    };
  }

  const created = services.sessions.create(newId, options);
  return {
    header: created?.header ?? { ...header, id: newId, cwd: target.path },
    inheritedEventCount: created?.inheritedEventCount ?? inherited,
    events: typeof created?.snapshotEvents === "function" ? created.snapshotEvents() : events,
  };
}

/**
 * 把重建出来的会话预热进投影缓存。
 *
 * 持久化会话在列表里的标题/预览来自 `sessionProjectionCache` 的行；新 id 没有行，
 * 列表就只能显示「未命名」，等用户点开（触发冷读）才补上。这里迁移完直接做一次
 * 冷读，让缓存行立刻存在。缓存服务缺失或失败都只是降级，不影响迁移结果。
 */
function warmProjectionCache(ctx, built) {
  try {
    const cache = ctx.get("sessionProjectionCache");
    if (cache === undefined || typeof cache.coldSnapshot !== "function") return;
    const result = cache.coldSnapshot(built.header, built.inheritedEventCount, built.events);
    if (result !== null && typeof result === "object" && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch {
    // 预热失败不影响迁移；用户首次打开会话时会重新冷读。
  }
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

//#region 迁移备份与记录

/** 路径最后一段，用于记录里没有工作区标题时的兜底展示。 */
function basenameOf(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  try {
    return basename(path);
  } catch {
    return path;
  }
}

/** 读 history.json；文件不存在或损坏都当空表，迁移本身不因记录坏掉而失败。 */
async function readHistoryFile() {
  try {
    const parsed = JSON.parse(await readFile(historyFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => item !== null && typeof item === "object") : [];
  } catch {
    return [];
  }
}

/** 先写临时文件再改名，避免中途失败留下半截 JSON。 */
async function writeHistoryFile(records) {
  await mkdir(moverDir(), { recursive: true });
  const target = historyFile();
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

/**
 * 把一次迁移的完整会话写进备份目录，返回 backupId。
 * 备份必须在删除原会话之前完成：迁移链路任何一步出错，它都是唯一的还原来源。
 */
async function writeBackup(snapshot, meta) {
  const backupId = randomUUID();
  await mkdir(backupDir(), { recursive: true });
  const payload = {
    version: 1,
    backupId,
    createdAt: new Date().toISOString(),
    ...meta,
    header: snapshot.session,
    inheritedEventCount: snapshot.inheritedEventCount ?? 0,
    events: Array.isArray(snapshot.events) ? snapshot.events : [],
  };
  await writeFile(join(backupDir(), `${backupId}.json`), JSON.stringify(payload), "utf8");
  return backupId;
}

/** 读一份备份；id 必须过白名单，永远不拿浏览器给的字符串直接拼路径。 */
async function readBackup(backupId) {
  if (typeof backupId !== "string" || !BACKUP_ID.test(backupId)) throw new Error("备份 id 不合法");
  const parsed = JSON.parse(await readFile(join(backupDir(), `${backupId}.json`), "utf8"));
  if (parsed === null || typeof parsed !== "object" || typeof parsed.header !== "object" || !Array.isArray(parsed.events)) {
    throw new Error("备份文件内容不完整");
  }
  return parsed;
}

/** 追加一条迁移记录，最新的排在最前。 */
function appendHistory(record) {
  return withHistoryLock(async () => {
    const records = await readHistoryFile();
    await writeHistoryFile([record, ...records.filter((item) => item?.id !== record.id)]);
  });
}

/** 给一条记录打上恢复时间（备份本身保留，允许再次恢复）。 */
function markHistoryRestored(backupId, sessionId) {
  return withHistoryLock(async () => {
    const records = await readHistoryFile();
    let touched = false;
    const next = records.map((item) => {
      if (item?.id !== backupId) return item;
      touched = true;
      return { ...item, restoredAt: new Date().toISOString(), restoredSessionId: sessionId };
    });
    if (touched) await writeHistoryFile(next);
  });
}

/** 从会话日志里折叠最新标题（与宿主 session-title 的 fold 规则一致）。 */
function titleFromEvents(events) {
  if (!Array.isArray(events)) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "session/title") continue;
    const title = event.data?.title;
    if (typeof title === "string" && title.trim().length > 0) return title.trim();
  }
  return undefined;
}

/**
 * 会话标题读取，优先级：日志里的 session/title 事件 → 宿主的 readTitle → id。
 * 日志 fold 不额外读盘，且与备份内容一致，避免标题落成 sessionId。
 */
async function readSessionTitle(services, sessionId, snapshot) {
  const fromEvents = titleFromEvents(snapshot?.events);
  if (fromEvents !== undefined) return fromEvents;
  try {
    const title = await services.sessionQuery.readTitle?.(sessionId);
    if (typeof title === "string" && title.trim().length > 0) return title.trim();
  } catch {
    // 标题读不到就继续往下兜。
  }
  return sessionId;
}

/** 看起来像会话 id 的标题说明当时没折叠到真实标题。 */
function looksLikeSessionId(value) {
  return typeof value === "string" && /^session-[0-9a-z-]+$/iu.test(value);
}

/** 恢复时优先回到迁移前的源工作区，其次按路径、最后回到目标工作区。 */
function pickRestoreWorkspace(registry, backup) {
  const list = registry.list();
  const byId = (id) => (typeof id === "string" ? list.find((workspace) => workspace.id === id) : undefined);
  const byPath = (path) => (typeof path === "string" && path.length > 0 ? list.find((workspace) => workspace.path === path) : undefined);
  return byId(backup.sourceWorkspaceId) ?? byPath(backup.sourcePath) ?? byId(backup.targetWorkspaceId) ?? byPath(backup.targetPath);
}

/**
 * 清掉超过保留期的迁移记录与对应备份，顺带清掉没有记录的孤儿备份。
 * 每次插件加载（DSH 启动）跑一次；失败只记日志，不影响其它功能。
 * @param now - 当前毫秒时间戳，测试可注入。
 * @returns 被删除的记录数与备份数。
 */
export async function pruneMoveHistory(now = Date.now()) {
  return withHistoryLock(async () => {
    const records = await readHistoryFile();
    const kept = [];
    const dropped = [];
    for (const record of records) {
      const movedAt = typeof record.movedAt === "string" ? Date.parse(record.movedAt) : Number.NaN;
      if (Number.isFinite(movedAt) && now - movedAt > HISTORY_RETENTION_MS) dropped.push(record);
      else kept.push(record);
    }

    let removedBackups = 0;
    const known = new Set();
    for (const record of kept) {
      const id = typeof record.backupId === "string" ? record.backupId : record.id;
      if (typeof id === "string" && BACKUP_ID.test(id)) known.add(id);
    }
    for (const record of dropped) {
      const id = typeof record.backupId === "string" ? record.backupId : record.id;
      if (typeof id === "string" && BACKUP_ID.test(id)) {
        try {
          await rm(join(backupDir(), `${id}.json`), { force: true });
          removedBackups += 1;
        } catch {
          // 单个备份删除失败不影响其余清理。
        }
      }
    }

    // 没有记录指向的孤儿备份（记录写失败过）也按文件年龄清掉。
    let entries = [];
    try {
      entries = await readdir(backupDir());
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      if (!BACKUP_ID.test(id) || known.has(id)) continue;
      try {
        const info = await stat(join(backupDir(), entry));
        if (now - info.mtimeMs > HISTORY_RETENTION_MS) {
          await rm(join(backupDir(), entry), { force: true });
          removedBackups += 1;
        }
      } catch {
        // 读不到年龄就保留，宁可多留一天。
      }
    }

    if (dropped.length > 0) await writeHistoryFile(kept);
    return { removedRecords: dropped.length, removedBackups };
  });
}

/** 供客户端展示的迁移记录，最新在前。 */
export async function listMoveHistory(ctx) {
  const registry = ctx.get("workspaceRegistry");
  if (registry === undefined) return fail("宿主服务不可用：workspaceRegistry");
  const records = await readHistoryFile();
  const workspaces = new Map(registry.list().map((workspace) => [workspace.id, workspace]));
  const items = [];
  for (const record of records.slice(0, 100)) {
    if (record === null || typeof record !== "object") continue;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const source = typeof record.sourceWorkspaceId === "string" ? workspaces.get(record.sourceWorkspaceId) : undefined;
    const target = typeof record.targetWorkspaceId === "string" ? workspaces.get(record.targetWorkspaceId) : undefined;
    const backupId = typeof record.backupId === "string" ? record.backupId : undefined;
    items.push({
      id: record.id,
      backupId: backupId ?? null,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      title: typeof record.title === "string" && record.title.length > 0
        ? record.title
        : (typeof record.sessionId === "string" ? record.sessionId : record.id),
      fromTitle: source?.title ?? record.sourceTitle ?? basenameOf(record.from),
      toTitle: target?.title ?? record.targetTitle ?? basenameOf(record.to),
      from: typeof record.from === "string" ? record.from : (source?.path ?? ""),
      to: typeof record.to === "string" ? record.to : (target?.path ?? ""),
      movedAt: typeof record.movedAt === "string" ? record.movedAt : null,
      restoredAt: typeof record.restoredAt === "string" ? record.restoredAt : null,
      // 老版记录没有备份文件，只能展示、不能恢复。
      restorable: backupId !== undefined && BACKUP_ID.test(backupId),
      // 内部字段：历史记录当时没折叠到标题时，用迁移后的新会话补名。
      newSessionId: typeof record.newSessionId === "string" ? record.newSessionId : null,
    });
  }

  // 早期写法把标题存成了 sessionId；这里按迁移后的会话一次性补回真实标题。
  const needTitle = items.filter((item) => looksLikeSessionId(item.title) && item.newSessionId !== null);
  if (needTitle.length > 0) {
    try {
      const query = ctx.get("sessionQuery");
      const ids = [...new Set(needTitle.map((item) => item.newSessionId))];
      const snapshots = await query?.readTitleSnapshots?.(ids);
      if (Array.isArray(snapshots)) {
        const titles = new Map();
        snapshots.forEach((result, index) => {
          const title = result?.status === "fulfilled" ? result.value?.title : undefined;
          if (typeof title === "string" && title.trim().length > 0) titles.set(ids[index], title.trim());
        });
        for (const item of needTitle) {
          const title = titles.get(item.newSessionId);
          if (title !== undefined) item.title = title;
        }
      }
    } catch {
      // 补名失败就保留原样，不影响记录展示。
    }
  }
  for (const item of items) delete item.newSessionId;
  return { ok: true, items };
}

/**
 * 用备份把一条已迁移的对话恢复到迁移前的工作区。
 * @param ctx - 宿主上下文。
 * @param backupId - 迁移时写下的备份 id。
 */
export async function restoreSession(ctx, backupId) {
  const { services, error } = requireServices(ctx, ["sessions", "sessionQuery", "workspaceRegistry"]);
  if (error !== undefined) return fail(error);
  if (ctx.get("sessionPersistence") === undefined) return fail("当前宿主没有会话持久化后端，无法恢复");

  let backup;
  try {
    backup = await readBackup(backupId);
  } catch (readError) {
    return fail(`读取备份失败：${messageOf(readError)}`);
  }

  const target = pickRestoreWorkspace(services.workspaceRegistry, backup);
  if (target === undefined) return fail("迁移前的工作区已不存在，无法恢复");

  const newId = mintedSessionId();
  let built;
  try {
    built = await rebuildSession(ctx, services, target, {
      session: backup.header,
      inheritedEventCount: backup.inheritedEventCount ?? 0,
      events: backup.events,
    }, newId);
  } catch (rebuildError) {
    return fail(`恢复会话失败：${messageOf(rebuildError)}`);
  }

  try {
    await target.attachSession(newId);
  } catch (attachError) {
    await rollbackCreated(ctx, newId);
    return fail(`目标工作区接管失败：${messageOf(attachError)}`);
  }

  // 恢复出来的同样是持久化会话：不预热缓存，侧边栏会显示「未命名」直到点开。
  warmProjectionCache(ctx, built);

  try {
    await markHistoryRestored(backupId, newId);
  } catch {
    // 记录写不上不影响恢复结果。
  }
  return {
    ok: true,
    sessionId: newId,
    workspaceId: target.id,
    workspaceTitle: target.title,
    title: typeof backup.title === "string" && backup.title.length > 0 ? backup.title : newId,
  };
}

//#endregion

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

  // 记录源工作区与标题，供「迁移记录」展示与恢复使用。
  const workspaces = services.workspaceRegistry.list();
  const source = workspaces.find((workspace) => workspace.path === header.cwd)
    ?? workspaces.find((workspace) => workspace.sessionIds.includes(sessionId));
  const title = await readSessionTitle(services, sessionId, snapshot);
  const route = {
    sessionId,
    title,
    sourceWorkspaceId: source?.id ?? null,
    sourceTitle: source?.title ?? basenameOf(header.cwd),
    sourcePath: source?.path ?? (typeof header.cwd === "string" ? header.cwd : ""),
    targetWorkspaceId: target.id,
    targetTitle: target.title,
    targetPath: target.path,
  };

  // 备份必须先于删除原会话：迁移链路任何一步出错，它就是唯一的还原来源。
  let backupId;
  try {
    backupId = await writeBackup(snapshot, route);
  } catch (backupError) {
    return fail(`备份原对话失败，已取消迁移：${messageOf(backupError)}`);
  }

  // 显式 mint：store 的 `session-<n>` 计数器重启后归零，会和磁盘上已有的同号会话撞车。
  const newId = mintedSessionId();

  let built;
  try {
    built = await rebuildSession(ctx, services, target, snapshot, newId);
  } catch (createError) {
    return fail(`创建目标会话失败：${messageOf(createError)}`);
  }

  try {
    await target.attachSession(newId);
  } catch (attachError) {
    await rollbackCreated(ctx, newId);
    return fail(`目标工作区接管失败：${messageOf(attachError)}`);
  }

  // 立即写投影缓存，否则侧边栏要等用户点开这条对话才显示标题。
  warmProjectionCache(ctx, built);

  const record = {
    id: backupId,
    backupId,
    sessionId,
    newSessionId: newId,
    title,
    sourceWorkspaceId: route.sourceWorkspaceId,
    sourceTitle: route.sourceTitle,
    targetWorkspaceId: target.id,
    targetTitle: target.title,
    from: route.sourcePath,
    to: route.targetPath,
    movedAt: new Date().toISOString(),
  };

  // 先从源工作区记账里摘掉，随后的删除再兜一次。
  await detachFromWorkspaces(services.workspaceRegistry, sessionId);

  const removal = await deleteSession(ctx, sessionId);
  const historyWarning = await appendHistory(record).then(
    () => undefined,
    (historyError) => `迁移记录写入失败：${messageOf(historyError)}`,
  );

  if (removal.ok !== true) {
    const warnings = [`新对话已建好，但原对话未能删除：${removal.error}`];
    if (historyWarning !== undefined) warnings.push(historyWarning);
    return {
      ok: true,
      newSessionId: newId,
      backupId,
      targetWorkspaceId: target.id,
      targetTitle: target.title,
      warning: warnings.join("；"),
    };
  }

  return {
    ok: true,
    newSessionId: newId,
    backupId,
    removedSessionId: sessionId,
    targetWorkspaceId: target.id,
    targetTitle: target.title,
    ...(historyWarning === undefined ? {} : { warning: historyWarning }),
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
 * 把一个工作区的全部对话迁移到另一个工作区（工作区菜单的「迁移工作区」）。
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
      name: "move-history",
      feature: "moveEnabled",
      handler: async () => listMoveHistory(ctx),
    },
    {
      name: "restore-session",
      feature: "moveEnabled",
      handler: async (body) => restoreSession(ctx, body?.backupId),
    },
    {
      name: "list-workspaces",
      handler: async () => listWorkspaces(ctx),
    },
  ];

  const refusedFeature = {
    moveEnabled: "工作区迁移功能已在 DSH-Enhance 设置中关闭",
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
