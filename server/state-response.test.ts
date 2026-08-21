import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import type { RoomState } from "./types.js";
import { roomStateWithAvailability } from "./state-response.js";

describe("room state responses", () => {
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
        "codex-luna": true,
        "codex-terra": true,
        "codex-sol": true,
        "claude-sonnet": true,
        "cursor-grok": true,
        "cursor-gemini": true,
        "cursor-composer": true,
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
});
