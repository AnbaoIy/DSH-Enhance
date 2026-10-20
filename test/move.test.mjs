/**
 * 迁移语义的回归测试。
 *
 * 重点盯住三个曾经出错的行为：
 *   1. 重建的会话必须真的写入持久层（只建内存会话会让它「点不开、重启就没」）；
 *   2. 重建的会话不能进入运行时 store（否则之后的 resume 会撞 "session already exists"）；
 *   3. 原会话必须被删除，而不是 archiveSession（否则归档列表里会多出一份）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listMoveHistory, moveSession, moveWorkspace, pruneMoveHistory, restoreSession } from "../lib/session-ops.js";

/** 迁移记录与备份的落盘根（register-shims.mjs 已把 DSH_HOME 指到临时目录）。 */
function moverDir() {
  return join(process.env.DSH_HOME, "workspace-mover");
}

/** 每个用例从空的记录目录开始，避免用例之间互相干扰。 */
async function resetMoverDir() {
  await rm(moverDir(), { recursive: true, force: true });
  await mkdir(moverDir(), { recursive: true });
}

/** 读 history.json。 */
async function readHistory() {
  return JSON.parse(await readFile(join(moverDir(), "history.json"), "utf8"));
}

/**
 * 造一个最小的假宿主，只实现迁移路径用到的成员。
 * @param options.failCreate - 让持久层 create 抛错，用于验证失败时不删原会话。
 * @param options.withoutPersistence - 模拟没有持久化后端的宿主。
 */
async function makeWorld(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-enhance-move-"));
  // 官方 JSONL 后端的工件名是 session.v<N>.jsonl，删除前会校验这个名字。
  const transcript = join(root, "session.v4.jsonl");
  await writeFile(transcript, "{}\n", "utf8");

  const created = [];
  const archived = [];
  const removedNotifications = [];
  const persisted = [];
  const prepares = [];
  let flushAll = 0;

  const target = {
    id: "ws-target",
    path: join(root, "target"),
    title: "Target",
    sessionIds: [],
    async attachSession(id) { this.sessionIds.push(id); },
    async detachSession(id) { this.sessionIds = this.sessionIds.filter((item) => item !== id); },
  };
  const source = {
    id: "ws-source",
    path: join(root, "source"),
    title: "Source",
    sessionIds: ["session-old"],
    async attachSession(id) { this.sessionIds.push(id); },
    async detachSession(id) { this.sessionIds = this.sessionIds.filter((item) => item !== id); },
  };

  const registry = {
    get(id) {
      if (id === target.id) return target;
      if (id === source.id) return source;
      return undefined;
    },
    list() { return [source, target]; },
    async archiveSession(id, opts) { archived.push({ id, options: opts }); },
    async unarchiveSession() {},
  };

  const sessions = {
    create(id, opts) {
      created.push({ id, options: opts });
      return { id, header: { id } };
    },
    prepare(id, opts) {
      prepares.push({ id, options: opts });
      const header = {
        version: 4,
        id,
        createdAt: opts?.meta?.createdAt ?? 1,
        cwd: opts?.meta?.cwd,
        isSeeded: opts?.meta?.isSeeded === true,
        ...(opts?.meta?.agentPreset === undefined ? {} : { agentPreset: opts.meta.agentPreset }),
        ...(opts?.meta?.origin === undefined ? {} : { origin: opts.meta.origin }),
      };
      return {
        header,
        inheritedEventCount: opts?.inheritedEventCount ?? 0,
        snapshotEvents() { return [...(opts?.seed ?? [])]; },
      };
    },
    async flush() { flushAll += 1; },
    get() { return undefined; },
  };

  const sessionQuery = {
    async readSession() {
      return {
        session: { id: "session-old", cwd: source.path, createdAt: 1_700_000_000_000 },
        inheritedEventCount: 0,
        events: [
          { seq: 0, time: 1, type: "session/start", data: {} },
          { seq: 1, time: 2, type: "message/user", data: { text: "hi" } },
          { seq: 2, time: 3, type: "session/title", data: { title: "真实标题", source: "user" } },
        ],
      };
    },
    // 标题应从日志事件折叠，而不是依赖宿主 readTitle。
    async readTitle() { return "宿主标题"; },
    async readTitleSnapshots(ids) {
      return ids.map((id) => ({ status: "fulfilled", value: { session: { id }, title: "补回来的标题" } }));
    },
  };

  const sessionPersistence = {
    async locate(header) {
      // 真实后端按 header.cwd + id 定位；原会话的工件就是 transcript。
      if (header.id === "session-old") return { path: transcript };
      return { path: join(root, "target", header.id, "session.v4.jsonl") };
    },
    async create(header, opts) {
      if (options.failCreate === true) throw new Error("disk full");
      const record = { header, inheritedEventCount: opts?.inheritedEventCount ?? 0, events: [], flushed: 0, closed: false };
      persisted.push(record);
      return {
        async append(events) { record.events.push(...events); },
        async flush() { record.flushed += 1; },
        async close() { record.closed = true; },
      };
    },
  };

  const services = {
    workspaceRegistry: registry,
    sessions,
    sessionQuery,
    sessionPersistence: options.withoutPersistence === true ? undefined : sessionPersistence,
    sessionProjectionCache: { async delete() {} },
    agents: { get() { return undefined; } },
    spillStore: undefined,
  };

  const ctx = {
    get(key) { return services[key]; },
    emit(name, payload) { removedNotifications.push({ name, payload }); },
  };

  return {
    ctx, root, transcript, created, archived, removedNotifications, target, source,
    persisted, prepares, flushAll: () => flushAll,
  };
}

test("迁移把完整历史写进持久层，并且不把新会话塞进运行时 store", async () => {
  await resetMoverDir();
  const world = await makeWorld();
  const result = await moveSession(world.ctx, "session-old", world.target.id);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.newSessionId, /^session-[0-9a-f-]{36}$/u, "新 id 必须自己 mint，避免撞磁盘上已有的 session-<n>");
  assert.equal(result.removedSessionId, "session-old");

  // 走 prepare + 持久层，而不是 sessions.create（后者只写内存）。
  assert.equal(world.created.length, 0, "不能再用 sessions.create 造会话");
  assert.equal(world.prepares.length, 1);
  assert.equal(world.prepares[0].id, result.newSessionId);
  assert.equal(world.prepares[0].options.meta.cwd, world.target.path);
  assert.equal(world.prepares[0].options.meta.createdAt, 1_700_000_000_000);
  assert.equal(world.prepares[0].options.seed.length, 3);

  // 历史真的落到目标目录，句柄被关闭，后续 resume 才能 open(write)。
  assert.equal(world.persisted.length, 1, "必须调用一次 sessionPersistence.create");
  const record = world.persisted[0];
  assert.equal(record.header.id, result.newSessionId);
  assert.equal(record.header.cwd, world.target.path);
  assert.equal(record.events.length, 3);
  assert.equal(record.flushed, 1);
  assert.equal(record.closed, true);

  // 目标工作区接管、源工作区摘除。
  assert.deepEqual(world.target.sessionIds, [result.newSessionId]);
  assert.deepEqual(world.source.sessionIds, []);

  // 原会话被物理删除（目录里只剩它自己的工件时整目录一起删，所以两种都算通过）。
  assert.equal(world.archived.length, 0);
  const leftovers = await readdir(world.root).catch(() => []);
  assert.equal(leftovers.includes("session.v4.jsonl"), false);

  // 删除之前必须留下备份：备份文件 + history.json 各一份。
  assert.match(result.backupId, /^[0-9a-f-]{36}$/u);
  const backups = await readdir(join(moverDir(), "backups"));
  assert.deepEqual(backups, [`${result.backupId}.json`]);
  const backup = JSON.parse(await readFile(join(moverDir(), "backups", `${result.backupId}.json`), "utf8"));
  assert.equal(backup.title, "真实标题");
  assert.equal(backup.events.length, 3);
  assert.equal(backup.header.cwd, world.source.path);
  const history = await readHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].backupId, result.backupId);
  assert.equal(history[0].sourceTitle, "Source");
  assert.equal(history[0].targetTitle, "Target");
  assert.equal(history[0].from, world.source.path);
  assert.equal(history[0].to, world.target.path);
});

test("批量迁移按快照遍历，全部走同一条落盘路径", async () => {
  await resetMoverDir();
  const world = await makeWorld();
  world.source.sessionIds = ["session-old"];
  const result = await moveWorkspace(world.ctx, world.source.id, world.target.id);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.movedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(world.persisted.length, 1);
  assert.equal(world.archived.length, 0);
  assert.equal(world.target.sessionIds.length, 1);
  assert.equal(world.target.sessionIds[0], world.persisted[0].header.id);
  assert.equal((await readHistory()).length, 1);
});

test("写盘失败时保留原会话，不做半吊子迁移", async () => {
  await resetMoverDir();
  const world = await makeWorld({ failCreate: true });
  const result = await moveSession(world.ctx, "session-old", world.target.id);

  assert.equal(result.ok, false);
  assert.match(result.error, /创建目标会话失败/u);
  assert.equal(world.persisted.length, 0);
  // 原会话仍在源工作区记账里，文件也没被删。
  assert.deepEqual(world.source.sessionIds, ["session-old"]);
  assert.deepEqual(world.target.sessionIds, []);
  const leftovers = await readdir(world.root).catch(() => []);
  assert.equal(leftovers.includes("session.v4.jsonl"), true);
  // 失败不写迁移记录。
  assert.deepEqual(await readHistory().catch(() => []), []);
});

test("宿主没有持久化后端时退回纯内存重建", async () => {
  await resetMoverDir();
  const world = await makeWorld({ withoutPersistence: true });
  const result = await moveSession(world.ctx, "session-old", world.target.id);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(world.persisted.length, 0);
  assert.equal(world.created.length, 1);
  assert.equal(world.prepares.length, 0);
  assert.deepEqual(world.target.sessionIds, [result.newSessionId]);
});

test("目标工作区不存在时给出可读错误，不创建任何会话", async () => {
  await resetMoverDir();
  const world = await makeWorld();
  const result = await moveSession(world.ctx, "session-old", "ws-missing");

  assert.equal(result.ok, false);
  assert.match(result.error, /目标工作区不存在/u);
  assert.equal(world.created.length, 0);
  assert.equal(world.prepares.length, 0);
});

test("迁移记录可以列出来，并能用备份恢复到源工作区", async () => {
  await resetMoverDir();
  const world = await makeWorld();
  const moved = await moveSession(world.ctx, "session-old", world.target.id);
  assert.equal(moved.ok, true, JSON.stringify(moved));

  const listed = await listMoveHistory(world.ctx);
  assert.equal(listed.ok, true);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].backupId, moved.backupId);
  assert.equal(listed.items[0].title, "真实标题");
  assert.equal(listed.items[0].fromTitle, "Source");
  assert.equal(listed.items[0].toTitle, "Target");
  assert.equal(listed.items[0].restorable, true);

  const restored = await restoreSession(world.ctx, moved.backupId);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.match(restored.sessionId, /^session-[0-9a-f-]{36}$/u);
  assert.equal(restored.workspaceId, world.source.id, "恢复应回到迁移前的源工作区");

  // 恢复出来的会话同样落盘、被源工作区接管。
  const restoredRecord = world.persisted.at(-1);
  assert.equal(restoredRecord.header.id, restored.sessionId);
  assert.equal(restoredRecord.header.cwd, world.source.path);
  assert.equal(restoredRecord.events.length, 3);
  assert.equal(restoredRecord.closed, true);
  assert.ok(world.source.sessionIds.includes(restored.sessionId));

  // 记录被标记为已恢复，备份仍保留（允许再次恢复）。
  const after = await readHistory();
  assert.equal(typeof after[0].restoredAt, "string");
  assert.equal(after[0].restoredSessionId, restored.sessionId);
  assert.deepEqual(await readdir(join(moverDir(), "backups")), [`${moved.backupId}.json`]);
});

test("老记录没有备份文件时只展示、不可恢复", async () => {
  await resetMoverDir();
  await writeFile(join(moverDir(), "history.json"), JSON.stringify([{
    id: "session-legacy",
    sessionId: "session-legacy",
    title: "旧记录",
    sourceWorkspaceId: null,
    targetWorkspaceId: "ws-target",
    from: "C:/old",
    to: "C:/new",
    movedAt: new Date().toISOString(),
  }]), "utf8");
  const world = await makeWorld();

  const listed = await listMoveHistory(world.ctx);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].restorable, false);

  const restored = await restoreSession(world.ctx, "session-legacy");
  assert.equal(restored.ok, false);
  assert.match(restored.error, /备份 id 不合法/u);
});

test("标题被存成会话 id 的记录会用迁移后的会话补回真实标题", async () => {
  await resetMoverDir();
  const backupId = "44444444-4444-4444-8444-444444444444";
  await writeFile(join(moverDir(), "history.json"), JSON.stringify([{
    id: backupId,
    backupId,
    sessionId: "session-old",
    newSessionId: "session-abcdef01-2345-4678-9abc-def012345678",
    title: "session-old",
    sourceWorkspaceId: null,
    targetWorkspaceId: "ws-target",
    from: "C:/old",
    to: "C:/new",
    movedAt: new Date().toISOString(),
  }]), "utf8");
  await mkdir(join(moverDir(), "backups"), { recursive: true });
  const world = await makeWorld();

  const listed = await listMoveHistory(world.ctx);
  assert.equal(listed.items[0].title, "补回来的标题");
  assert.equal(listed.items[0].newSessionId, undefined, "内部字段不能漏给客户端");
});

test("超过保留期的记录与备份在启动清理时被删除", async () => {
  await resetMoverDir();
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  const staleId = "11111111-1111-4111-8111-111111111111";
  const freshId = "22222222-2222-4222-8222-222222222222";
  await mkdir(join(moverDir(), "backups"), { recursive: true });
  for (const id of [staleId, freshId]) {
    await writeFile(join(moverDir(), "backups", `${id}.json`), JSON.stringify({
      version: 1,
      backupId: id,
      header: { id: "session-x", cwd: "C:/x", createdAt: 1 },
      events: [],
    }), "utf8");
  }
  await writeFile(join(moverDir(), "history.json"), JSON.stringify([
    { id: staleId, backupId: staleId, movedAt: "2026-10-10T00:00:00.000Z" },
    { id: freshId, backupId: freshId, movedAt: "2026-10-19T12:00:00.000Z" },
  ]), "utf8");

  const result = await pruneMoveHistory(now);
  assert.equal(result.removedRecords, 1);
  assert.equal(result.removedBackups, 1);
  const kept = await readHistory();
  assert.deepEqual(kept.map((item) => item.id), [freshId]);
  assert.deepEqual(await readdir(join(moverDir(), "backups")), [`${freshId}.json`]);
});

test("没有记录指向的孤儿备份也会按年龄清掉", async () => {
  await resetMoverDir();
  const orphanId = "33333333-3333-4333-8333-333333333333";
  await mkdir(join(moverDir(), "backups"), { recursive: true });
  await writeFile(join(moverDir(), "backups", `${orphanId}.json`), "{}", "utf8");
  // 把文件改成 10 天前。
  const { utimes } = await import("node:fs/promises");
  const old = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  await utimes(join(moverDir(), "backups", `${orphanId}.json`), old, old);
  await writeFile(join(moverDir(), "history.json"), "[]", "utf8");

  const result = await pruneMoveHistory();
  assert.equal(result.removedBackups, 1);
  assert.deepEqual(await readdir(join(moverDir(), "backups")), []);
});
