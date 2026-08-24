import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../../shared/chat-style.js";
import { RoomStore } from "../room-store.js";
import { importJsonRoomToSqlite } from "./import-json-to-sqlite.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";
import type { AssignmentRecord } from "../assignment-record.js";
import { createTask } from "../../shared/task-domain.js";
import { DEFAULT_ROOM_ID } from "./sqlite-room-repository.js";
import { CONTINUATION_POLICY_VERSION, projectPathHash, type ContinuationPolicy, type ContinuationRecord } from "../continuation-record.js";

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
    await legacyStore.addMessage(
      "codex-terra",
      "Keep this historical speaker",
      "chat",
      DEFAULT_PARTICIPANT_STYLES["codex-terra"],
    );
    await legacyStore.setSession("codex-sol", "imported-session", "read-only");
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
    const continuationPolicy: ContinuationPolicy = { schemaVersion: 1, policyVersion: CONTINUATION_POLICY_VERSION, revision: 1, roomId: DEFAULT_ROOM_ID, projectPathHash: projectPathHash(projectRoot), enabled: true, maxConcurrentPerAgent: 1, defaultBudget: { timeMs: 1000, tokenLimit: 10, toolCallLimit: 2, retryLimit: 0 }, maxInboxEntriesPerAgent: 10, inboxTtlMs: 1000, retryBackoffMs: 100, updatedAt: "2026-08-21T01:02:00.000Z", updatedBy: "owner" };
    await legacyStore.compareAndSetContinuationPolicy(0, continuationPolicy);
    const continuation: ContinuationRecord = { schemaVersion: 1, jobId: "imported-job", jobRevision: 1, roomId: DEFAULT_ROOM_ID, projectPathHash: projectPathHash(projectRoot), owner: "codex-sol", task: taskIdentity, taskRevision: 2, assignmentReferenceId: "assignment-ref", authority: { assignmentId: assignment.assignmentId, developerMemberId: assignment.developerMemberId, developerMemberConfigRevision: assignment.developerMemberConfigRevision, agent: assignment.agent, fencingToken: assignment.fencingToken, manifestRevision: assignment.manifestRevision, pinnedBaseSha: assignment.pinnedBaseSha }, objective: "Preserve continuation", trigger: "migration test", policyRevision: 1, policyVersion: CONTINUATION_POLICY_VERSION, capabilities: ["ANALYZE"], status: "QUEUED", budget: continuationPolicy.defaultBudget, usage: { elapsedMs: 0, tokens: 0, toolCalls: 0, attempts: 0 }, cancellationRequested: false, resultDisposition: "PENDING", resultSummary: null, blocker: null, nextEligibilityAt: null, createdAt: "2026-08-21T01:03:00.000Z", startedAt: null, updatedAt: "2026-08-21T01:03:00.000Z", completedAt: null };
    await legacyStore.createContinuation(continuation, { schemaVersion: 1, eventId: "imported-created-event", jobId: continuation.jobId, jobRevision: 1, attempt: 0, trigger: continuation.trigger, policyRevision: 1, at: continuation.createdAt, action: "CREATED", fromStatus: null, toStatus: "QUEUED", usage: continuation.usage, attemptUsage: { elapsedMs: 0, tokens: 0, toolCalls: 0 }, result: null, nextEligibilityAt: null });
    const sourcePath = path.join(sourceStateDirectory, "room.json");
    const sourceState = JSON.parse(await readFile(sourcePath, "utf8"));
    sourceState.sessions["codex-terra"] = { id: "retired-session", permission: "read-only" };
    await writeFile(sourcePath, `${JSON.stringify(sourceState, null, 2)}\n`, "utf8");
    const sourceBefore = await readFile(sourcePath, "utf8");
    const sourceTasksPath = path.join(sourceStateDirectory, "tasks.json");
    const sourceTasksBefore = await readFile(sourceTasksPath, "utf8");
    const sourceContinuationsPath = path.join(sourceStateDirectory, "continuations.json");
    const sourceContinuationsBefore = await readFile(sourceContinuationsPath, "utf8");

    const result = await importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath });

    expect(result.messages).toBe(4);
    expect(result.sessions).toBe(1);
    expect(result.assignments).toBe(1);
    expect(result.tasks).toBe(1);
    expect(result.taskEvents).toBe(2);
    expect(result.continuations).toBe(1);
    expect(result.continuationAudit).toBe(1);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    expect(await readFile(sourceTasksPath, "utf8")).toBe(sourceTasksBefore);
    expect(await readFile(sourceContinuationsPath, "utf8")).toBe(sourceContinuationsBefore);
    const importedStore = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(importedStore.snapshot().settings.roomName).toBe("Imported Room");
    expect(importedStore.snapshot().sessions["codex-sol"]?.id).toBe("imported-session");
    expect(importedStore.snapshot().sessions["codex-terra"]).toBeUndefined();
    expect(importedStore.snapshot().messages.find(({ speaker }) => speaker === "codex-terra")).toMatchObject({
      text: "Keep this historical speaker",
      style: DEFAULT_PARTICIPANT_STYLES["codex-terra"],
    });
    expect(importedStore.snapshot().messages.find(({ humanId }) => humanId === "import-human-1234")).toMatchObject({
      text: "Keep this transcript",
      speakerName: "Importer",
    });
    expect(await importedStore.getAssignment("imported-assignment")).toEqual(assignment);
    expect(await importedStore.getTask(taskIdentity)).toMatchObject({ revision: 2, description: "history survives" });
    expect((await importedStore.listTaskEvents(taskIdentity)).map(({ revision }) => revision)).toEqual([1, 2]);
    expect(await importedStore.getContinuation("imported-job")).toEqual(continuation);
    expect(await importedStore.listContinuationAudit("imported-job")).toHaveLength(1);
    importedStore.close();

    await expect(importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath })).resolves.toEqual(result);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    expect(await readFile(sourceTasksPath, "utf8")).toBe(sourceTasksBefore);
    expect(await readFile(sourceContinuationsPath, "utf8")).toBe(sourceContinuationsBefore);
    const reopenedStore = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect((await reopenedStore.listTaskEvents(taskIdentity)).map(({ revision }) => revision)).toEqual([1, 2]);
    expect((await reopenedStore.listTasks()).items).toHaveLength(1);
    expect(await reopenedStore.listAssignments()).toHaveLength(1);
    expect(await reopenedStore.listContinuations()).toHaveLength(1);
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
