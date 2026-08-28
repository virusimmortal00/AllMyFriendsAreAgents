import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import type { RoomState } from "./types.js";
import { publicRoomState, roomStateWithAvailability } from "./state-response.js";

describe("room state responses", () => {
  it("hides legacy orchestration instructions without deleting ordinary status messages", () => {
    const snapshot: RoomState = {
      messages: [
        { id: "legacy", speaker: "system", kind: "status", text: "The discussion remains open. Use Actions → Continue discussion to start another bounded round.", timestamp: "2026-08-19T12:00:00.000Z" },
        { id: "provider", speaker: "system", kind: "status", text: "Claude [Claude Opus 5] is unavailable: Provider usage limit reached. It can be tried again after 5:20 PM. Other agents will keep going.", timestamp: "2026-08-19T12:00:00.500Z" },
        { id: "presence", speaker: "system", kind: "status", text: "Alice joined the room.", timestamp: "2026-08-19T12:00:01.000Z" },
      ],
      sessions: {},
      settings: {
        roomName: "The Agent Room",
        topic: "Open conversation",
        writableAgent: "nobody",
        conversationEnergy: "balanced",
        projectPath: "/tmp/project",
        participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
      },
      status: "idle",
    };

    expect(publicRoomState(snapshot).messages.map(({ id }) => id)).toEqual(["presence"]);
  });

  it("takes the room snapshot after the slower availability check finishes", async () => {
    let messageText = "before";
    let releaseAvailability!: () => void;
    const availability = new Promise<void>((resolve) => { releaseAvailability = resolve; });
    const snapshot = (): RoomState => ({
      messages: [{ id: "message", speaker: "you", text: messageText, timestamp: "2026-08-19T12:00:00.000Z" }],
      sessions: { "codex-sol": { id: "private-session-id", permission: "read-only" } },
      settings: {
        roomName: "The Agent Room",
        topic: "Open conversation",
        writableAgent: "nobody",
        conversationEnergy: "balanced",
        projectPath: "/tmp/project",
        participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
      },
      status: "idle",
    });

    const response = roomStateWithAvailability(snapshot, async () => {
      await availability;
      return {
        "codex-sol": true,
        "claude-sonnet": true,
        "cursor-grok": true,
        "cursor-gemini": true,
        "cursor-composer": true,
        "cursor-gemini-flash": true,
        "cursor-glm": true,
      };
    });
    messageText = "after";
    releaseAvailability();

    const resolved = await response;
    expect(resolved.messages[0].text).toBe("after");
    expect(resolved).not.toHaveProperty("sessions");
    expect(resolved).not.toHaveProperty("error");
    expect(resolved.settings).not.toHaveProperty("projectPath");
    expect(resolved.settings).not.toHaveProperty("writableAgent");
  });

  it("exposes bounded deployment evidence without exposing provider sessions or the project path", () => {
    const snapshot: RoomState = {
      messages: [], sessions: { "codex-sol": { id: "secret", permission: "read-only", codeEpoch: `deployment-v1:${"a".repeat(64)}` } },
      settings: { roomName: "Room", topic: "Topic", writableAgent: "nobody", conversationEnergy: "balanced", projectPath: "/secret/project", participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) },
      status: "idle",
      deployment: { schemaVersion: 1, commitSha: "b".repeat(40), reference: { kind: "detached" }, worktree: "clean", epoch: `deployment-v1:${"c".repeat(64)}`, observedAt: "2026-08-26T00:00:00.000Z" },
    };
    const publicState = publicRoomState(snapshot, {
      "codex-sol": { eligible: true, available: false, unavailableReason: "confinement-unavailable" },
    });
    expect(publicState.deployment).toEqual(snapshot.deployment);
    expect(publicState).not.toHaveProperty("sessions");
    expect(publicState.settings).not.toHaveProperty("projectPath");
    expect(publicState.settings).not.toHaveProperty("writableAgent");
    expect(publicState.implementationCapabilities).toEqual({
      "codex-sol": { eligible: true, available: false, unavailableReason: "confinement-unavailable" },
    });
    expect(JSON.stringify(publicState)).not.toMatch(/secret|project|session|workspace|broker/i);
  });

  it("keeps context cursors and summary cache server-owned", () => {
    const snapshot: RoomState = {
      messages: [], sessions: {},
      settings: { roomName: "Room", topic: "Topic", writableAgent: "nobody", conversationEnergy: "balanced", projectPath: "/tmp/project", participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) },
      roster: { schemaVersion: 3, revision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Sol", modelId: "gpt-5.6-sol", enabled: true, lastSeenMessageId: "private-cursor" }] },
      agentContextSummaries: [{ agentId: "codex-sol", spanStartId: "one", spanEndId: "two", configRevision: 0, summary: "private cache" }],
      roomConfigurationAudit: [],
      status: "idle",
    };
    const publicState = publicRoomState(snapshot);
    expect(publicState).not.toHaveProperty("agentContextSummaries");
    expect(publicState).not.toHaveProperty("roomConfigurationAudit");
    expect(publicState.roster?.entries[0]).not.toHaveProperty("lastSeenMessageId");
  });

  it("projects private transcript nodes only to their human and strips the recipient identifier", () => {
    const snapshot: RoomState = {
      messages: [
        { id: "public", speaker: "system", text: "public", timestamp: "2026-08-27T00:00:00Z" },
        { id: "private", speaker: "system", text: "private marker", timestamp: "2026-08-27T00:00:01Z", recipientHumanId: "human-a" },
      ],
      sessions: {}, settings: { roomName: "Room", topic: "Topic", writableAgent: "nobody", conversationEnergy: "balanced", projectPath: "/tmp", participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) }, status: "idle",
    };
    expect(publicRoomState(snapshot).messages.map(({ id }) => id)).toEqual(["public"]);
    expect(publicRoomState(snapshot, undefined, "human-b").messages.map(({ id }) => id)).toEqual(["public"]);
    const own = publicRoomState(snapshot, undefined, "human-a");
    expect(own.messages.map(({ id }) => id)).toEqual(["public", "private"]);
    expect(JSON.stringify(own)).not.toContain("human-a");
  });

  it("projects only sanitized provider action guidance", () => {
    const snapshot: RoomState = {
      messages: [], sessions: { "cursor-grok": { id: "private-provider-session", permission: "read-only" } },
      settings: { roomName: "Room", topic: "Topic", writableAgent: "nobody", conversationEnergy: "balanced", projectPath: "/secret/project", participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) },
      status: "idle",
    };
    const publicState = publicRoomState(snapshot, undefined, undefined, { providerHealth: {
      cursor: { status: "action_required", reason: "usage_exhausted", message: "Cursor usage is exhausted; increase the limit or change provider mode.", since: "2026-08-27T12:00:00.000Z" },
    } });

    expect(publicState.providerHealth?.cursor).toEqual({
      status: "action_required",
      reason: "usage_exhausted",
      message: "Cursor usage is exhausted; increase the limit or change provider mode.",
      since: "2026-08-27T12:00:00.000Z",
    });
    expect(JSON.stringify(publicState)).not.toMatch(/private-provider-session|\/secret\/project|credential|account/i);
  });
});
