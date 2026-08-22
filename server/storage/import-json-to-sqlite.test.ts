import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "../room-store.js";
import { importJsonRoomToSqlite } from "./import-json-to-sqlite.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";
import type { AssignmentRecord } from "../assignment-record.js";

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
    const firstWorkspace = await legacyStore.createWorkspaceDocument({ id: "imported-document", path: "shared/design.md", content: "first", attachments: [{ id: "imported-attachment", name: "design.txt", mediaType: "text/plain", dataBase64: Buffer.from("asset").toString("base64") }] }, { participantId: "importer", timestamp: "2026-08-21T01:00:00.000Z" });
    const secondWorkspace = await legacyStore.updateWorkspaceDocument(firstWorkspace.document.id, { expectedRevisionId: firstWorkspace.revision.id, content: "second" }, { participantId: "codex-sol", timestamp: "2026-08-21T02:00:00.000Z" });
    await legacyStore.archiveWorkspaceDocument(firstWorkspace.document.id, { expectedRevisionId: secondWorkspace.revision.id }, { participantId: "importer", timestamp: "2026-08-21T03:00:00.000Z" });
    const sourceWorkspace = await legacyStore.exportWorkspace();
    const sourcePath = path.join(sourceStateDirectory, "room.json");
    const sourceBefore = await readFile(sourcePath, "utf8");

    const result = await importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath });

    expect(result.messages).toBe(3);
    expect(result.sessions).toBe(1);
    expect(result.assignments).toBe(1);
    expect(result.workspaceDocuments).toBe(1);
    expect(result.workspaceRevisions).toBe(2);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    const importedStore = await SqliteRoomRepository.open(projectRoot, databasePath);
    expect(importedStore.snapshot().settings.roomName).toBe("Imported Room");
    expect(importedStore.snapshot().sessions["codex-terra"]?.id).toBe("imported-session");
    expect(importedStore.snapshot().messages.at(-1)).toMatchObject({
      text: "Keep this transcript",
      speakerName: "Importer",
    });
    expect(await importedStore.getAssignment("imported-assignment")).toEqual(assignment);
    expect(await importedStore.exportWorkspace()).toEqual(sourceWorkspace);
    importedStore.close();

    await expect(importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath }))
      .rejects.toThrow("already contains the default room");
  });
});
