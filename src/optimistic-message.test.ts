import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import type { RoomState } from "./types";
import { appendOptimisticHumanMessage, discardOptimisticMessage } from "./optimistic-message";

const room: RoomState = {
  messages: [],
  settings: {
    roomName: "The Agent Room",
    topic: "Open conversation",
    conversationEnergy: "balanced",
    participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
  },
  status: "idle",
};
const human = { id: "alice-id", name: "Alice", style: DEFAULT_PARTICIPANT_STYLES.you };

describe("optimistic human messages", () => {
  it("adds the submitted message immediately with the current human style", () => {
    const next = appendOptimisticHumanMessage(room, human, "pending-message", "Hello room", "2026-08-19T12:00:00.000Z");

    expect(next.messages).toEqual([expect.objectContaining({
      id: "pending-message",
      speaker: "you",
      humanId: "alice-id",
      speakerName: "Alice",
      text: "Hello room",
      style: DEFAULT_PARTICIPANT_STYLES.you,
    })]);
    expect(room.messages).toEqual([]);
  });

  it("removes only the pending message when submission fails", () => {
    const pending = appendOptimisticHumanMessage(room, human, "pending-message", "Hello room", "2026-08-19T12:00:00.000Z");
    const withAnotherMessage = {
      ...pending,
      messages: [...pending.messages, { id: "agent", speaker: "codex-sol" as const, text: "Hi", timestamp: "2026-08-19T12:00:01.000Z" }],
    };

    expect(discardOptimisticMessage(withAnotherMessage, "pending-message").messages.map(({ id }) => id)).toEqual(["agent"]);
  });
});
