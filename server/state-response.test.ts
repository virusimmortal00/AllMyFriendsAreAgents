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
  });

  it("exposes bounded deployment evidence without exposing provider sessions or the project path", () => {
    const snapshot: RoomState = {
      messages: [], sessions: { "codex-sol": { id: "secret", permission: "read-only", codeEpoch: `deployment-v1:${"a".repeat(64)}` } },
      settings: { roomName: "Room", topic: "Topic", writableAgent: "nobody", conversationEnergy: "balanced", projectPath: "/secret/project", participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES) },
      status: "idle",
      deployment: { schemaVersion: 1, commitSha: "b".repeat(40), reference: { kind: "detached" }, worktree: "clean", epoch: `deployment-v1:${"c".repeat(64)}`, observedAt: "2026-08-26T00:00:00.000Z" },
    };
    const publicState = publicRoomState(snapshot);
    expect(publicState.deployment).toEqual(snapshot.deployment);
    expect(publicState).not.toHaveProperty("sessions");
    expect(publicState.settings).not.toHaveProperty("projectPath");
  });
});
