import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import { ROOM_PROTOCOL_VERSION } from "../shared/protocol";
import { appendOptimisticHumanMessage } from "./optimistic-message";
import { reconcileRoomEvent } from "./room-reconciliation";
import type { HumanPresence, RoomMessage, RoomState } from "./types";

const human: HumanPresence = { id: "human-1234", name: "Human", style: DEFAULT_PARTICIPANT_STYLES.you };

function state(messages: RoomMessage[] = [], overrides: Partial<RoomState> = {}): RoomState {
  return {
    messages,
    settings: {
      roomName: "Delta Lab",
      topic: "Reconciliation",
      conversationEnergy: "balanced",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
    server: { instanceId: "server-1", protocolVersion: ROOM_PROTOCOL_VERSION },
    ...overrides,
  };
}

function snapshot(room: RoomState, streamId = "stream-1", version = 0) {
  return { kind: "snapshot", reason: "initial", continuity: "fresh", streamId, version, state: room } as const;
}

function message(id: string, clientMessageId?: string): RoomMessage {
  return { id, clientMessageId, speaker: "you", text: id, timestamp: "2026-08-24T12:00:00.000Z" };
}

describe("room delta reconciliation", () => {
  it("installs a snapshot then applies contiguous state and message deltas without replacing unrelated state", () => {
    const initial = reconcileRoomEvent(state(), undefined, snapshot(state([message("one")])));
    expect(initial.kind).toBe("applied");
    if (initial.kind !== "applied") return;

    const { messages: _messages, ...nonMessageState } = state([], { status: "working", activeGenerations: { run: "codex-sol" } });
    const stateDelta = reconcileRoomEvent(initial.room, initial.position, {
      kind: "state-delta", streamId: "stream-1", fromVersion: 0, version: 1,
      state: nonMessageState,
    });
    expect(stateDelta.kind).toBe("applied");
    if (stateDelta.kind !== "applied") return;
    expect(stateDelta.room.messages.map(({ id }) => id)).toEqual(["one"]);
    expect(stateDelta.room.activeGenerations).toEqual({ run: "codex-sol" });

    const appended = reconcileRoomEvent(stateDelta.room, stateDelta.position, {
      kind: "messages-appended", streamId: "stream-1", fromVersion: 1, version: 2, messages: [message("two")],
    });
    expect(appended.kind).toBe("applied");
    if (appended.kind === "applied") expect(appended.room.messages.map(({ id }) => id)).toEqual(["one", "two"]);
  });

  it("requires resync for gaps, stream changes, reset events, and unknown protocol events", () => {
    const position = { streamId: "stream-1", version: 4 };
    const current = state([message("safe")]);
    expect(reconcileRoomEvent(current, position, { kind: "messages-appended", streamId: "stream-1", fromVersion: 5, version: 6, messages: [] }).kind).toBe("resync");
    expect(reconcileRoomEvent(current, position, { kind: "state-delta", streamId: "stream-2", fromVersion: 4, version: 5, state: current }).kind).toBe("resync");
    expect(reconcileRoomEvent(current, position, { kind: "reset", streamId: "stream-1", version: 5 }).kind).toBe("resync");
    expect(reconcileRoomEvent(current, position, { surprise: true }).kind).toBe("resync");
  });

  it("rejects partial state deltas before they can erase required room fields", () => {
    const current = state([message("safe")], { status: "working" });
    const position = { streamId: "stream-1", version: 2 };
    const partialDelta = {
      kind: "state-delta",
      streamId: "stream-1",
      fromVersion: 2,
      version: 3,
      state: { server: { instanceId: "server-1", protocolVersion: ROOM_PROTOCOL_VERSION } },
    };

    expect(reconcileRoomEvent(current, position, partialDelta)).toEqual({ kind: "resync" });
    expect(current.settings.roomName).toBe("Delta Lab");
    expect(current.status).toBe("working");
    expect(current.messages.map(({ id }) => id)).toEqual(["safe"]);
  });

  it("replaces an optimistic message exactly once whether delta or acknowledgement arrives first", () => {
    const clientMessageId = "message-correlation-1234";
    const optimistic = appendOptimisticHumanMessage(state(), human, `pending-${clientMessageId}`, "hello", "2026-08-24T11:59:00.000Z", [], clientMessageId);
    const installed = reconcileRoomEvent(optimistic, undefined, snapshot(state(), "stream-1", 0));
    expect(installed.kind).toBe("applied");
    if (installed.kind !== "applied") return;
    expect(installed.room.messages).toHaveLength(1);

    const authoritative = message("server-message", clientMessageId);
    const delta = { kind: "messages-appended", streamId: "stream-1", fromVersion: 0, version: 1, messages: [authoritative] } as const;
    const delivered = reconcileRoomEvent(installed.room, installed.position, delta);
    expect(delivered.kind).toBe("applied");
    if (delivered.kind !== "applied") return;
    expect(delivered.room.messages).toEqual([authoritative]);

    const duplicate = reconcileRoomEvent(delivered.room, delivered.position, delta);
    expect(duplicate.kind).toBe("ignored");
    const authoritativeSnapshot = reconcileRoomEvent(installed.room, installed.position, snapshot(state([authoritative]), "stream-2", 0));
    expect(authoritativeSnapshot.kind).toBe("applied");
    if (authoritativeSnapshot.kind === "applied") expect(authoritativeSnapshot.room.messages).toEqual([authoritative]);
  });

  it("detects an incompatible snapshot and accepts an authoritative restart snapshot", () => {
    const incompatible = snapshot(state([], { server: { instanceId: "server-2", protocolVersion: ROOM_PROTOCOL_VERSION + 1 } }));
    expect(reconcileRoomEvent(state(), undefined, incompatible)).toMatchObject({ kind: "incompatible", instanceId: "server-2" });
    const restarted = reconcileRoomEvent(state([message("old")]), { streamId: "old-stream", version: 9 }, snapshot(state([message("new")]), "new-stream", 0));
    expect(restarted.kind).toBe("applied");
    if (restarted.kind === "applied") expect(restarted.room.messages.map(({ id }) => id)).toEqual(["new"]);
  });

  it("accepts a fresh snapshot with a server-derived implementation status for an enabled dynamic roster participant", () => {
    const dynamicAgent = "agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const dynamicRoster = {
      schemaVersion: 3 as const,
      revision: 2,
      entries: [{
        agentId: dynamicAgent,
        conversationalName: "Dynamic writer",
        providerId: "openrouter",
        modelId: "example/dynamic-writer",
        enabled: true,
        supportsProjectWrites: true,
        configurationRevision: 1,
      }],
    };
    const dynamicState = state([], {
      roster: dynamicRoster,
      implementationCapabilities: { [dynamicAgent]: { eligible: true, available: false, unavailableReason: "no-active-assignment" } },
    });

    expect(reconcileRoomEvent(state(), undefined, snapshot(dynamicState))).toMatchObject({
      kind: "applied",
      room: { implementationCapabilities: { [dynamicAgent]: { eligible: true, available: false, unavailableReason: "no-active-assignment" } } },
    });
  });

  it("replaces implementation status across a reconnect snapshot without retaining a removed dynamic participant", () => {
    const dynamicAgent = "agent-ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb";
    const current = state([], { implementationCapabilities: { [dynamicAgent]: { eligible: true, available: true } } });
    const next = state([], { roster: { schemaVersion: 3, revision: 3, entries: [] }, implementationCapabilities: {} });
    const reconciled = reconcileRoomEvent(current, { streamId: "old", version: 2 }, snapshot(next, "new", 0));
    expect(reconciled).toMatchObject({ kind: "applied", room: { implementationCapabilities: {} } });
  });

  it("clears recovered provider state from an authoritative refresh", () => {
    const current = state([], { providerHealth: { cursor: { status: "action_required", reason: "usage_exhausted", message: "Cursor usage is exhausted; increase the limit or change provider mode.", since: "2026-08-27T12:00:00.000Z" } } });
    const reconciled = reconcileRoomEvent(current, { streamId: "old", version: 2 }, snapshot(state([], { providerHealth: {} }), "new", 0));
    expect(reconciled).toMatchObject({ kind: "applied", room: { providerHealth: {} } });
  });
});
