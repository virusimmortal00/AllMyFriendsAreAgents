import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../../shared/chat-style.js";
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
    const sourcePath = path.join(sourceStateDirectory, "room.json");
    const sourceState = JSON.parse(await readFile(sourcePath, "utf8"));
    sourceState.sessions["codex-terra"] = { id: "retired-session", permission: "read-only" };
    await writeFile(sourcePath, `${JSON.stringify(sourceState, null, 2)}\n`, "utf8");
    const sourceBefore = await readFile(sourcePath, "utf8");

    const result = await importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath });

    expect(result.messages).toBe(4);
    expect(result.sessions).toBe(1);
    expect(result.assignments).toBe(1);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
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
    importedStore.close();

    await expect(importJsonRoomToSqlite({ projectRoot, sourceStateDirectory, databasePath }))
      .rejects.toThrow("already contains the default room");
  });
});
