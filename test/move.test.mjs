/**
 * 迁移语义的回归测试。
 *
 * 重点盯住三个曾经出错的行为：
 *   1. 重建的会话必须真的写入持久层（只建内存会话会让它「点不开、重启就没」）；
 *   2. 重建的会话不能进入运行时 store（否则之后的 resume 会撞 "session already exists"）；
 *   3. 原会话必须被删除，而不是 archiveSession（否则归档列表里会多出一份）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { moveSession, moveWorkspace } from "../lib/session-ops.js";

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
        ],
      };
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
  assert.equal(world.prepares[0].options.seed.length, 2);

  // 历史真的落到目标目录，句柄被关闭，后续 resume 才能 open(write)。
  assert.equal(world.persisted.length, 1, "必须调用一次 sessionPersistence.create");
  const record = world.persisted[0];
  assert.equal(record.header.id, result.newSessionId);
  assert.equal(record.header.cwd, world.target.path);
  assert.equal(record.events.length, 2);
  assert.equal(record.flushed, 1);
  assert.equal(record.closed, true);

  // 目标工作区接管、源工作区摘除。
  assert.deepEqual(world.target.sessionIds, [result.newSessionId]);
  assert.deepEqual(world.source.sessionIds, []);

  // 原会话被物理删除（目录里只剩它自己的工件时整目录一起删，所以两种都算通过）。
  assert.equal(world.archived.length, 0);
  const leftovers = await readdir(world.root).catch(() => []);
  assert.equal(leftovers.includes("session.v4.jsonl"), false);
});

test("批量迁移按快照遍历，全部走同一条落盘路径", async () => {
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
});

test("写盘失败时保留原会话，不做半吊子迁移", async () => {
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
});

test("宿主没有持久化后端时退回纯内存重建", async () => {
  const world = await makeWorld({ withoutPersistence: true });
  const result = await moveSession(world.ctx, "session-old", world.target.id);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(world.persisted.length, 0);
  assert.equal(world.created.length, 1);
  assert.equal(world.prepares.length, 0);
  assert.deepEqual(world.target.sessionIds, [result.newSessionId]);
});

test("目标工作区不存在时给出可读错误，不创建任何会话", async () => {
  const world = await makeWorld();
  const result = await moveSession(world.ctx, "session-old", "ws-missing");

  assert.equal(result.ok, false);
  assert.match(result.error, /目标工作区不存在/u);
  assert.equal(world.created.length, 0);
  assert.equal(world.prepares.length, 0);
});
