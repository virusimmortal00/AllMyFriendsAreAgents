import { describe, expect, it } from "vitest";
import { parseProtectedReturn, protectedReturnCursor } from "./protected-return.js";
import type { RoomState } from "./types.js";
describe("protected return contract", () => {
  it("validates relevance and bounded visible output, permitting an explicit no-update", () => {
    expect(parseProtectedReturn('{"relevance":"superseded","text":null}', "cursor")).toEqual({ relevance: "superseded", text: null, cursor: "cursor" });
    expect(parseProtectedReturn('```json\n{"relevance":"qualified","text":"Partial finding"}\n```', "cursor").text).toBe("Partial finding");
    for (const value of ['plain prose', '{"relevance":"unknown","text":"text"}', '{"relevance":"relevant","text":"","extra":true}', JSON.stringify({ relevance: "relevant", text: "a".repeat(4_001) })]) expect(() => parseProtectedReturn(value, "cursor")).toThrow();
  });
  it("detects topic, roster and public-message changes without using private human messages", () => {
    const room = { messages: [{ id: "public" }], settings: { topic: "one" }, roster: { revision: 1 } } as unknown as RoomState;
    const cursor = protectedReturnCursor(room);
    expect(protectedReturnCursor({ ...room, messages: [...room.messages, { id: "private", recipientHumanId: "other" } as never] })).toBe(cursor);
    expect(protectedReturnCursor({ ...room, settings: { ...room.settings, topic: "two" } })).not.toBe(cursor);
  });
});
