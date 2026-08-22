import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTask, type TaskActor } from "../../shared/task-domain.js";
import { RoomStore } from "../room-store.js";
import type { RoomRepository } from "./room-repository.js";
import { DEFAULT_ROOM_ID, SqliteRoomRepository } from "./sqlite-room-repository.js";

const owner: TaskActor = { id: "owner" };
const temporaryDirectories: string[] = [];
type Fixture = { repository: RoomRepository; reopen(): Promise<RoomRepository>; close(): void };

const factories: ReadonlyArray<readonly [string, (root: string) => Promise<Fixture>]> = [
  ["JSON", async (root) => {
    const directory = path.join(root, "json");
    let repository: RoomRepository = await RoomStore.open(root, directory);
    return { get repository() { return repository; }, async reopen() { repository = await RoomStore.open(root, directory); return repository; }, close() {} };
  }],
  ["SQLite", async (root) => {
    const database = path.join(root, "sqlite", "room.sqlite");
    let repository: RoomRepository = await SqliteRoomRepository.open(root, database);
    return { get repository() { return repository; }, async reopen() { (repository as SqliteRoomRepository).close(); repository = await SqliteRoomRepository.open(root, database); return repository; }, close() { (repository as SqliteRoomRepository).close(); } };
  }],
];

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function initial(taskId: string) {
  return createTask({ roomId: DEFAULT_ROOM_ID, taskId, title: `Task ${taskId}`, actor: owner, now: "2026-08-21T12:00:00.000Z" });
}

describe.each(factories)("%s task repository", (_backend, makeFixture) => {
  it("persists projection/history and permits only one concurrent revision winner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-task-contract-")); temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      expect(await fixture.repository.createTask(initial("race"))).toMatchObject({ kind: "created", task: { revision: 1 } });
      const identity = { roomId: DEFAULT_ROOM_ID, taskId: "race" };
      const results = await Promise.all([
        fixture.repository.applyTaskChange(identity, 1, { kind: "set_title", title: "winner A" }, owner, "2026-08-21T12:01:00.000Z"),
        fixture.repository.applyTaskChange(identity, 1, { kind: "set_title", title: "winner B" }, owner, "2026-08-21T12:01:01.000Z"),
      ]);
      expect(results.filter(({ kind }) => kind === "accepted")).toHaveLength(1);
      expect(results.filter(({ kind }) => kind === "conflict")).toEqual([{ kind: "conflict", expectedRevision: 1, actualRevision: 2 }]);
      const reopened = await fixture.reopen();
      expect(await reopened.getTask(identity)).toMatchObject({ revision: 2 });
      expect((await reopened.listTaskEvents(identity)).map(({ revision }) => revision)).toEqual([1, 2]);
    } finally { fixture.close(); }
  });

  it("rejects missing, cross-room, self, direct, and transitive dependency cycles atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-task-contract-")); temporaryDirectories.push(root);
    const fixture = await makeFixture(root);
    try {
      for (const id of ["a", "b", "c"]) await fixture.repository.createTask(initial(id));
      const id = (taskId: string) => ({ roomId: DEFAULT_ROOM_ID, taskId });
      expect(await fixture.repository.applyTaskChange(id("a"), 1, { kind: "add_dependency", task: id("missing") }, owner, "2026-08-21T12:01:00.000Z")).toMatchObject({ kind: "rejected" });
      expect(await fixture.repository.applyTaskChange(id("a"), 1, { kind: "add_dependency", task: id("a") }, owner, "2026-08-21T12:01:00.000Z")).toMatchObject({ kind: "rejected" });
      expect(await fixture.repository.applyTaskChange(id("a"), 1, { kind: "add_dependency", task: { roomId: "other", taskId: "b" } }, owner, "2026-08-21T12:01:00.000Z")).toMatchObject({ kind: "rejected" });
      expect(await fixture.repository.applyTaskChange(id("a"), 1, { kind: "add_dependency", task: id("b") }, owner, "2026-08-21T12:01:00.000Z")).toMatchObject({ kind: "accepted", task: { revision: 2 } });
      expect(await fixture.repository.applyTaskChange(id("b"), 1, { kind: "add_dependency", task: id("c") }, owner, "2026-08-21T12:01:00.000Z")).toMatchObject({ kind: "accepted", task: { revision: 2 } });
      expect(await fixture.repository.applyTaskChange(id("c"), 1, { kind: "add_dependency", task: id("a") }, owner, "2026-08-21T12:01:00.000Z")).toMatchObject({ kind: "rejected" });
      expect(await fixture.repository.getTask(id("c"))).toMatchObject({ revision: 1, dependencies: [] });
      expect(await fixture.repository.getTaskDependencies(id("b"))).toMatchObject({ dependencies: [id("c")], dependents: [id("a")] });
    } finally { fixture.close(); }
  });
});
