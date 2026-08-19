import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { transcriptFor } from "./transcript.js";
import type { RoomMessage, RoomState } from "./types.js";

function state(messages: RoomMessage[]): RoomState {
  return {
    messages,
    sessions: {},
    settings: {
      topic: "Open conversation",
      writableAgent: "nobody",
      reviewMode: "read-only",
      maxRounds: 3,
      projectPath: "/tmp",
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    status: "idle",
  };
}

describe("agent transcript context", () => {
  it("groups consecutive chunks from one logical burst", () => {
    const messages: RoomMessage[] = [
      { id: "1", speaker: "codex", text: "yeah, a little", timestamp: "2026-08-19T12:00:00Z", burstId: "burst", sequence: 0 },
      { id: "2", speaker: "codex", text: "mostly because of the sidebar", timestamp: "2026-08-19T12:00:01Z", burstId: "burst", sequence: 1 },
      { id: "3", speaker: "codex", text: "I'd simplify that first", timestamp: "2026-08-19T12:00:02Z", burstId: "burst", sequence: 2 },
    ];

    const transcript = transcriptFor(state(messages));
    expect(transcript.match(/\[CODEX\]/g)).toHaveLength(1);
    expect(transcript).toContain("yeah, a little\nmostly because of the sidebar\nI'd simplify that first");
  });

  it("uses a character budget instead of dropping everything before the last 24 messages", () => {
    const messages = Array.from({ length: 30 }, (_, index): RoomMessage => ({
      id: String(index), speaker: "you", text: `message ${index}`, timestamp: "2026-08-19T12:00:00Z",
    }));

    const transcript = transcriptFor(state(messages), 4_000);
    expect(transcript).toContain("message 0");
    expect(transcript).toContain("message 29");
    expect(transcript.length).toBeLessThanOrEqual(4_000);
  });
});
