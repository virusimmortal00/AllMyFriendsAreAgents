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
      sessions: {},
      settings: {
        topic: "Open conversation",
        writableAgent: "nobody",
        reviewMode: "read-only",
        maxRounds: 3,
        projectPath: "/tmp/project",
        participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
      },
      status: "idle",
    });

    const response = roomStateWithAvailability(snapshot, async () => {
      await availability;
      return { codex: true, claude: true };
    });
    messageText = "after";
    releaseAvailability();

    expect((await response).messages[0].text).toBe("after");
  });
});
