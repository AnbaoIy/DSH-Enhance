/**
 * 迁移语义的回归测试。
 *
 * 重点盯住两个曾经出错的行为：
 *   1. 迁移必须通过运行时 sessions.create 重建（否则列表里是「未命名空对话」）；
 *   2. 原会话必须被删除，而不是 archiveSession（否则归档列表里会多出一份）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { moveSession, moveWorkspace } from "../lib/session-ops.js";

/** 造一个最小的假宿主，只实现迁移路径用到的成员。 */
async function makeWorld() {
  const root = await mkdtemp(join(tmpdir(), "dsh-enhance-move-"));
  // 官方 JSONL 后端的工件名是 session.v<N>.jsonl，删除前会校验这个名字。
  const transcript = join(root, "session.v4.jsonl");
  await writeFile(transcript, "{}\n", "utf8");

  const created = [];
  const archived = [];
  const removedNotifications = [];

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
    async archiveSession(id, options) { archived.push({ id, options }); },
    async unarchiveSession() {},
  };

  const sessions = {
    create(id, options) {
      created.push({ id, options });
      return { id: "session-new", header: { id: "session-new" } };
    },
    async flush() {},
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
    async locate() { return { path: transcript }; },
  };

  const services = {
    workspaceRegistry: registry,
    sessions,
    sessionQuery,
    sessionPersistence,
    sessionProjectionCache: { async delete() {} },
    agents: { get() { return undefined; } },
    spillStore: undefined,
  };

  const ctx = {
    get(key) { return services[key]; },
    emit(name, payload) { removedNotifications.push({ name, payload }); },
  };

  return { ctx, root, transcript, created, archived, removedNotifications, target, source };
}

test("迁移用 sessions.create 重建，并删除原会话而不是归档", async () => {
  const world = await makeWorld();
  const result = await moveSession(world.ctx, "session-old", world.target.id);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.newSessionId, "session-new");
  assert.equal(result.removedSessionId, "session-old");

  // 走了运行时 store，而不是直接写持久层。
  assert.equal(world.created.length, 1);
  const { options } = world.created[0];
  assert.equal(options.meta.cwd, world.target.path);
  assert.equal(options.meta.createdAt, 1_700_000_000_000);
  assert.equal(options.seed.length, 2);

  // 目标工作区接管、源工作区摘除。
  assert.deepEqual(world.target.sessionIds, ["session-new"]);
  assert.deepEqual(world.source.sessionIds, []);

  // 原会话被物理删除（目录里只剩它自己的工件时整目录一起删，所以两种都算通过）。
  assert.equal(world.archived.length, 0);
  const leftovers = await readdir(world.root).catch(() => []);
  assert.equal(leftovers.includes("session.v4.jsonl"), false);
});

test("批量迁移按快照遍历，全部走同一条路径", async () => {
  const world = await makeWorld();
  world.source.sessionIds = ["session-old"];
  const result = await moveWorkspace(world.ctx, world.source.id, world.target.id);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.movedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(world.archived.length, 0);
  assert.deepEqual(world.target.sessionIds, ["session-new"]);
});

test("目标工作区不存在时给出可读错误，不创建任何会话", async () => {
  const world = await makeWorld();
  const result = await moveSession(world.ctx, "session-old", "ws-missing");

  assert.equal(result.ok, false);
  assert.match(result.error, /目标工作区不存在/);
  assert.equal(world.created.length, 0);
});
