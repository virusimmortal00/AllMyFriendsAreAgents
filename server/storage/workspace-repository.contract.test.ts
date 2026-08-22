import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "../room-store.js";
import { JsonWorkspaceRepository } from "./json-workspace-repository.js";
import { DEFAULT_ROOM_ID, SqliteRoomRepository } from "./sqlite-room-repository.js";
import { WorkspaceRepositoryError, type WorkspaceRepository } from "./workspace-repository.js";

const roots: string[] = [];
const actor = (participantId: string, second: number) => ({ participantId, timestamp: `2026-08-21T10:00:${String(second).padStart(2, "0")}.000Z` });

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function exercise(repository: WorkspaceRepository) {
  const created = await repository.createWorkspaceDocument({ id: "doc-stable", path: "notes/plan.md", content: "one", attachments: [{ id: "att-stable", name: "proof.txt", mediaType: "text/plain", dataBase64: Buffer.from("proof").toString("base64") }] }, actor("human:alice", 1));
  expect(created.document.roomId).toBe(DEFAULT_ROOM_ID);
  expect(created.revision.contentHash).toHaveLength(64);
  expect(created.revision.attachments[0]).not.toHaveProperty("path");

  await expect(repository.updateWorkspaceDocument(created.document.id, { expectedRevisionId: "stale", content: "bad" }, actor("agent:sol", 2)))
    .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  const updated = await repository.updateWorkspaceDocument(created.document.id, { expectedRevisionId: created.revision.id, content: "two" }, actor("agent:sol", 3));
  await repository.renameOrMoveWorkspaceDocument(created.document.id, { expectedRevisionId: updated.revision.id, path: "archive/plan.md" }, actor("human:alice", 4));
  await repository.archiveWorkspaceDocument(created.document.id, { expectedRevisionId: updated.revision.id }, actor("human:alice", 5));
  expect(await repository.listWorkspaceDocuments()).toEqual([]);
  await repository.restoreWorkspaceDocument(created.document.id, { expectedRevisionId: updated.revision.id }, actor("human:bob", 6));

  const original = await repository.getWorkspaceRevision(created.document.id, created.revision.id);
  expect(original).toMatchObject({ id: created.revision.id, content: "one", attachments: [{ id: "att-stable", revisionId: created.revision.id }] });
  const history = await repository.getWorkspaceHistory(created.document.id);
  expect(history?.revisions.map(({ content }) => content)).toEqual(["one", "two"]);
  expect(history?.events.map(({ operation }) => operation)).toEqual(["CREATE", "UPDATE", "RENAME_OR_MOVE", "ARCHIVE", "RESTORE"]);
  expect(history?.events.every((event) => event.roomId === DEFAULT_ROOM_ID && event.participantId && event.timestamp && event.resultingRevisionId)).toBe(true);
  expect(history?.events.find(({ operation }) => operation === "RENAME_OR_MOVE")).toMatchObject({ previousPath: "notes/plan.md", path: "archive/plan.md" });
  return repository.exportWorkspace();
}

describe("workspace repository contract", () => {
  it("round-trips immutable history in the legacy JSON backend without creating state on open", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-workspace-json-")); roots.push(root);
    const stateDirectory = path.join(root, "state");
    const initial = await RoomStore.open(root, stateDirectory);
    await expect(readFile(path.join(stateDirectory, "workspace.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const exported = await exercise(initial);
    const reopened = await RoomStore.open(root, stateDirectory);
    expect(await reopened.exportWorkspace()).toEqual(exported);
  });

  it("survives SQLite reopen with the same identities, hashes, attachments, archive state, and audit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-workspace-sqlite-")); roots.push(root);
    const databasePath = path.join(root, "state", "room.sqlite");
    const initial = await SqliteRoomRepository.open(root, databasePath);
    const exported = await exercise(initial); initial.close();
    const reopened = await SqliteRoomRepository.open(root, databasePath);
    expect(await reopened.exportWorkspace()).toEqual(exported); reopened.close();
  });

  it("enforces deterministic document, content, revision, and aggregate quotas atomically", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-workspace-quota-")); roots.push(root);
    const repository = await JsonWorkspaceRepository.open(DEFAULT_ROOM_ID, root, { documentCount: 1, contentSizeBytes: 4, revisionCount: 1, aggregateRoomBytes: 5 });
    const created = await repository.createWorkspaceDocument({ path: "a.md", content: "1234" }, actor("alice", 1));
    const cases: Array<[Promise<unknown>, string]> = [
      [repository.createWorkspaceDocument({ path: "b.md", content: "1" }, actor("alice", 2)), "QUOTA_DOCUMENT_COUNT"],
      [repository.updateWorkspaceDocument(created.document.id, { expectedRevisionId: created.revision.id, content: "12345" }, actor("alice", 3)), "QUOTA_CONTENT_SIZE"],
      [repository.updateWorkspaceDocument(created.document.id, { expectedRevisionId: created.revision.id, content: "1" }, actor("alice", 4)), "QUOTA_REVISION_COUNT"],
    ];
    for (const [promise, code] of cases) await expect(promise).rejects.toMatchObject({ code });
    expect((await repository.getWorkspaceHistory(created.document.id))?.revisions).toHaveLength(1);

    const aggregate = await JsonWorkspaceRepository.open("room-aggregate", path.join(root, "aggregate"), { documentCount: 2, contentSizeBytes: 4, revisionCount: 2, aggregateRoomBytes: 4 });
    await aggregate.createWorkspaceDocument({ path: "a", content: "1234" }, actor("alice", 1));
    await expect(aggregate.createWorkspaceDocument({ path: "b", content: "1" }, actor("alice", 2))).rejects.toEqual(expect.objectContaining<Partial<WorkspaceRepositoryError>>({ code: "QUOTA_AGGREGATE_ROOM" }));
    expect(await aggregate.listWorkspaceDocuments()).toHaveLength(1);
  });
});
