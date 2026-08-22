import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "../room-store.js";
import { importJsonWorkspaceToSqlite } from "./import-json-workspace-to-sqlite.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("workspace-only JSON to SQLite import", () => {
  it("is retry-safe for identical state and reports a typed collision for different state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-workspace-import-")); roots.push(root);
    const sourceDirectory = path.join(root, "json"); const databasePath = path.join(root, "sqlite", "room.sqlite");
    const source = await RoomStore.open(root, sourceDirectory);
    await source.createWorkspaceDocument({ id: "portable", path: "shared/a.md", content: "portable" }, { participantId: "alice", timestamp: "2026-08-21T00:00:00.000Z" });
    const target = await SqliteRoomRepository.open(root, databasePath); target.close();

    await expect(importJsonWorkspaceToSqlite({ projectRoot: root, sourceStateDirectory: sourceDirectory, databasePath })).resolves.toMatchObject({ imported: true, documents: 1 });
    await expect(importJsonWorkspaceToSqlite({ projectRoot: root, sourceStateDirectory: sourceDirectory, databasePath })).resolves.toMatchObject({ imported: false, documents: 1 });

    const changed = await RoomStore.open(root, sourceDirectory);
    const document = (await changed.listWorkspaceDocuments())[0];
    await changed.updateWorkspaceDocument(document.id, { expectedRevisionId: document.currentRevisionId, content: "different" }, { participantId: "bob", timestamp: "2026-08-21T00:01:00.000Z" });
    await expect(importJsonWorkspaceToSqlite({ projectRoot: root, sourceStateDirectory: sourceDirectory, databasePath })).rejects.toMatchObject({ code: "IMPORT_COLLISION" });
  });
});
