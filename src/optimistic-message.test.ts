import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import type { RoomState } from "./types";
import { appendOptimisticHumanMessage, discardOptimisticMessage } from "./optimistic-message";

const room: RoomState = {
  messages: [],
  sessions: {},
  settings: {
    topic: "Open conversation",
    writableAgent: "nobody",
    reviewMode: "read-only",
    conversationEnergy: "balanced",
    projectPath: "/tmp/project",
    participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
  },
  status: "idle",
};

describe("optimistic human messages", () => {
  it("adds the submitted message immediately with the current human style", () => {
    const next = appendOptimisticHumanMessage(room, "pending-message", "Hello room", "2026-08-19T12:00:00.000Z");

    expect(next.messages).toEqual([expect.objectContaining({
      id: "pending-message",
      speaker: "you",
      text: "Hello room",
      style: DEFAULT_PARTICIPANT_STYLES.you,
    })]);
    expect(room.messages).toEqual([]);
  });

  it("removes only the pending message when submission fails", () => {
    const pending = appendOptimisticHumanMessage(room, "pending-message", "Hello room", "2026-08-19T12:00:00.000Z");
    const withAnotherMessage = {
      ...pending,
      messages: [...pending.messages, { id: "agent", speaker: "codex-sol" as const, text: "Hi", timestamp: "2026-08-19T12:00:01.000Z" }],
    };

    expect(discardOptimisticMessage(withAnotherMessage, "pending-message").messages.map(({ id }) => id)).toEqual(["agent"]);
  });
});
