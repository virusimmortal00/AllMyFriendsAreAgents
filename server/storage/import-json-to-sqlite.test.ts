import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "../room-store.js";
import { importJsonRoomToSqlite } from "./import-json-to-sqlite.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";
import type { AssignmentRecord } from "../assignment-record.js";
import { createTask } from "../../shared/task-domain.js";
import { DEFAULT_ROOM_ID } from "./sqlite-room-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JSON to SQLite import", () => {
  it("copies normalized room state without modifying the source JSON", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-json-import-test-"));
    temporaryDirectories.push(projectRoot);
    const sourceStateDirectory = path.join(projectRoot, "json-state");
    const databasePath = path.join(projectRoot, "sqlite-state", "amfaa.sqlite");
    const legacyStore = await RoomStore.open(projectRoot, sourceStateDirectory);
    await legacyStore.updateSettings({ roomName: "Imported Room" });
    await legacyStore.addMessage("you", "Keep this transcript", "chat", undefined, undefined, {
      id: "import-human-1234",
      name: "Importer",
    });
    await legacyStore.setSession("codex-terra", "imported-session", "read-only");
    const assignment: AssignmentRecord = {
      assignmentId: "imported-assignment", improvementId: "imp-1", developerMemberId: "builder", developerMemberConfigRevision: 1,
      agent: "codex-sol", fencingToken: 1, manifestRevision: 1, pinnedBaseSha: "a".repeat(40), branch: "amfaa/imported",
      observedHeadSha: "b".repeat(40), workspacePath: path.join(projectRoot, "assignment-worktree"), lifecycleStatus: "RECOVERABLE",
      recovery: { classification: "dirty", reconciledAt: "2026-08-21T00:00:00.000Z", previousStatus: "ACTIVE", detail: "preserve" },
      createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
    };
    await legacyStore.putAssignment(assignment);
    const taskIdentity = { roomId: DEFAULT_ROOM_ID, taskId: "imported-task" };
    await legacyStore.createTask(createTask({ ...taskIdentity, title: "Imported canonical task", actor: { id: "owner" }, now: "2026-08-21T01:00:00.000Z" }));
    await legacyStore.applyTaskChange(taskIdentity, 1, { kind: "set_description", description: "history survives" }, { id: "owner" }, "2026-08-21T01:01:00.000Z");
    const sourcePath = path.join(sourceStateDirectory, "room.json");
    const sourceBefore = await readFile(sourcePath, "utf8");
    const sourceTasksPath = path.join(sourceStateDirectory, "tasks.json");
    const sourceTasksBefore = await readFile(sourceTasksPath, "utf8");

    const result = await importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath });

    expect(result.messages).toBe(3);
    expect(result.sessions).toBe(1);
    expect(result.assignments).toBe(1);
    expect(result.tasks).toBe(1);
    expect(result.taskEvents).toBe(2);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    expect(await readFile(sourceTasksPath, "utf8")).toBe(sourceTasksBefore);
    const importedStore = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(importedStore.snapshot().settings.roomName).toBe("Imported Room");
    expect(importedStore.snapshot().sessions["codex-terra"]?.id).toBe("imported-session");
    expect(importedStore.snapshot().messages.at(-1)).toMatchObject({
      text: "Keep this transcript",
      speakerName: "Importer",
    });
    expect(await importedStore.getAssignment("imported-assignment")).toEqual(assignment);
    expect(await importedStore.getTask(taskIdentity)).toMatchObject({ revision: 2, description: "history survives" });
    expect((await importedStore.listTaskEvents(taskIdentity)).map(({ revision }) => revision)).toEqual([1, 2]);
    importedStore.close();

    await expect(importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath })).resolves.toEqual(result);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    expect(await readFile(sourceTasksPath, "utf8")).toBe(sourceTasksBefore);
    const reopenedStore = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect((await reopenedStore.listTaskEvents(taskIdentity)).map(({ revision }) => revision)).toEqual([1, 2]);
    expect((await reopenedStore.listTasks()).items).toHaveLength(1);
    expect(await reopenedStore.listAssignments()).toHaveLength(1);
    reopenedStore.close();
  });

  it("rejects importing a different room without explicit overwrite", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "amfaa-json-import-conflict-test-"));
    temporaryDirectories.push(projectRoot);
    const sourceStateDirectory = path.join(projectRoot, "json-state");
    const databasePath = path.join(projectRoot, "sqlite-state", "amfaa.sqlite");
    const source = await RoomStore.open(projectRoot, sourceStateDirectory);
    await source.updateSettings({ roomName: "Source Room" });
    const destination = await SqliteRoomRepository.open(projectRoot, databasePath);
    await destination.updateSettings({ roomName: "Different Room" });
    destination.close();

    await expect(importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath }))
      .rejects.toThrow("already contains a different default room");
  });
});
