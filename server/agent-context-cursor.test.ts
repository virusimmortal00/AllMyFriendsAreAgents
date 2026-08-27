import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeRoomAgentRoster, roomAgentTurnEpoch } from "../shared/roster.js";
import { advanceAgentContextCursor } from "./agent-context-cursor.js";
import { RoomStore } from "./room-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("agent context cursor advancement", () => {
  it("does not advance for a failed turn or a completed turn whose roster assignment went stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-context-cursor-rule-"));
    temporaryDirectories.push(root);
    const store = await RoomStore.open(root, path.join(root, "state"));
    const message = await store.addMessage("you", "Replay this delta");
    const roster = normalizeRoomAgentRoster(store.snapshot().roster);
    const epoch = roomAgentTurnEpoch(roster, "codex-sol")!;
    expect(await advanceAgentContextCursor(store, "codex-sol", epoch, undefined)).toBe(false);
    expect(normalizeRoomAgentRoster(store.snapshot().roster).entries.find(({ agentId }) => agentId === "codex-sol")?.lastSeenMessageId ?? null).toBeNull();
    expect((await store.updateRoster(roster.revision, roster.entries.map((entry) => ({ ...entry, enabled: entry.agentId === "claude-sonnet" ? false : entry.enabled })))).kind).toBe("accepted");
    expect(await advanceAgentContextCursor(store, "codex-sol", epoch, { cursorMessageId: message.id })).toBe(false);
    expect(normalizeRoomAgentRoster(store.snapshot().roster).entries.find(({ agentId }) => agentId === "codex-sol")?.lastSeenMessageId ?? null).toBeNull();
  });
});
