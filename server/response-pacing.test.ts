import { describe, expect, it } from "vitest";
import { messagesSinceAgentSpoke, pacingStartTime, responseDelayMs } from "./response-pacing.js";
import type { RoomMessage } from "./types.js";

function message(id: string, speaker: RoomMessage["speaker"], text: string, timestamp = "2026-08-19T12:00:00.000Z"): RoomMessage {
  return { id, speaker, text, timestamp, kind: "chat" };
}

describe("agent response pacing", () => {
  it("bases reading time only on messages since that agent last spoke", () => {
    const messages = [
      message("old", "you", "This older message should not count."),
      message("codex", "codex", "I replied."),
      message("new-human", "you", "A short follow up"),
      message("new-agent", "claude", "And another thought"),
    ];

    expect(messagesSinceAgentSpoke(messages, "codex").map(({ id }) => id)).toEqual(["new-human", "new-agent"]);
  });

  it("delivers short exchanges faster than long ones", () => {
    const shortDelay = responseDelayMs([message("short", "you", "Lunch?")], "codex", "Sure!", 0);
    const longDelay = responseDelayMs(
      [message("long", "you", "Could you read this longer message and think through the different possibilities with me before answering?")],
      "codex",
      "I think the first option is strongest because it keeps the room simple while still leaving enough flexibility for everyone involved.",
      0,
    );

    expect(shortDelay).toBeGreaterThanOrEqual(800);
    expect(shortDelay).toBeLessThan(longDelay);
    expect(longDelay).toBeLessThanOrEqual(12_000);
  });

  it("subtracts time already spent waiting and generating", () => {
    const messages = [message("human", "you", "What do you think?")];
    expect(responseDelayMs(messages, "claude", "Sounds good to me.", 20_000)).toBe(0);
  });

  it("starts perceived timing from the latest unread room message", () => {
    const messages = [message("human", "you", "Hello", "2026-08-19T12:00:03.000Z")];
    expect(pacingStartTime(messages, "codex", Date.parse("2026-08-19T12:00:05.000Z")))
      .toBe(Date.parse("2026-08-19T12:00:03.000Z"));
  });
});
