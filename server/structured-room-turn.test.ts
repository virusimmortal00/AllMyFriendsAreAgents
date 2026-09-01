import { describe, expect, it } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import { AGENT_IDS } from "../shared/participants.js";
import { STRUCTURED_ROOM_TURN_JSON_SCHEMA, interpretStructuredRoomTurn, validateStructuredRoomTurn } from "./structured-room-turn.js";

describe("structured room turns", () => {
  it("interprets a speaking turn without parsing private text directives", () => {
    expect(interpretStructuredRoomTurn("codex-sol", {
      schemaVersion: 1,
      action: "speak",
      messages: ["[Sol] First answer.", "Claude, what do you think?"],
      conversationState: "open",
      style: { ...DEFAULT_PARTICIPANT_STYLES["codex-sol"], fontSize: 19 },
      investigationRequest: { objective: "Check identity mapping", trigger: "Two labels conflict", evidenceRefs: [{ kind: "project_artifact", ref: "server/types.ts" }] },
    }, DEFAULT_PARTICIPANT_STYLES["codex-sol"], 3, AGENT_IDS)).toMatchObject({
      visibleMessages: ["First answer.", "Claude, what do you think?"],
      mentionedAgents: ["claude-sonnet"],
      conversationState: "open",
      disposition: "speak",
      styleUpdate: { fontSize: 19 },
      investigationRequest: { objective: "Check identity mapping" },
    });
  });

  it("keeps a yield silent and preserves its typed reason", () => {
    expect(interpretStructuredRoomTurn("claude-sonnet", { schemaVersion: 1, action: "yield", reason: "already_covered" })).toMatchObject({
      visibleMessages: [], yieldReason: "already_covered",
    });
  });

  it("normalizes the provider-compatible flat envelope into the semantic union", () => {
    expect(validateStructuredRoomTurn({ schemaVersion: 1, action: "yield", reason: "already_covered", messages: [], conversationState: null })).toEqual({
      schemaVersion: 1, action: "yield", reason: "already_covered",
    });
    expect(validateStructuredRoomTurn({ schemaVersion: 1, action: "speak", reason: null, messages: ["Typed."], conversationState: "settled" })).toEqual({
      schemaVersion: 1, action: "speak", messages: ["Typed."], conversationState: "settled",
    });
    expect(() => validateStructuredRoomTurn({ schemaVersion: 1, action: "yield", reason: null, messages: [], conversationState: null })).toThrow(/invalid structured room turn/);
  });

  it("fails closed for unknown fields, invalid unions, and empty sanitized messages", () => {
    expect(() => validateStructuredRoomTurn({ schemaVersion: 1, action: "yield", reason: "already_covered", explanation: "private" })).toThrow(/invalid structured room turn/);
    expect(interpretStructuredRoomTurn("codex-sol", { schemaVersion: 1, action: "speak", messages: ["🤘"], conversationState: "settled" })).toMatchObject({
      visibleMessages: [], dispositionMalformed: true,
    });
    expect(interpretStructuredRoomTurn("codex-sol", { schemaVersion: 1, action: "speak", messages: [], conversationState: "settled" })).toMatchObject({
      visibleMessages: [], dispositionMalformed: true,
    });
  });

  it("publishes a closed provider-compatible object schema", () => {
    expect(STRUCTURED_ROOM_TURN_JSON_SCHEMA.type).toBe("object");
    expect(STRUCTURED_ROOM_TURN_JSON_SCHEMA).not.toHaveProperty("oneOf");
    expect(STRUCTURED_ROOM_TURN_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(STRUCTURED_ROOM_TURN_JSON_SCHEMA.required).toEqual(["schemaVersion", "action", "reason", "messages", "conversationState"]);
  });
});
