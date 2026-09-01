import { describe, expect, it } from "vitest";
import { parseAgentTurn } from "./conversation.js";

describe("turn interpretation evidence", () => {
  it("keeps a yielded declared state separate from the state consumed by orchestration", () => {
    const parsed = parseAgentTurn("codex-sol", 'CONVERSATION_STATE: OPEN\nTURN_DISPOSITION: {"action":"yield","reason":"already_covered"}');
    expect(parsed.conversationState).toBeUndefined();
    expect(parsed.visibleMessages).toEqual([]);
    expect(parsed.diagnostics).toMatchObject({
      parserRevision: 1, dispositionStatus: "valid", dispositionAction: "yield", yieldReason: "already_covered",
      suppressionReason: "structured-yield", declaredConversationState: "open", effectiveConversationState: null,
      burstAccounting: "not-evaluated", parsedBurstCount: null, eligibleBurstCount: null, retainedBurstCount: null,
    });
  });

  it.each([
    ['TURN_DISPOSITION: {broken}', "malformed", "malformed-disposition"],
    ['NO_RESPONSE_NEEDED', "missing", "legacy-no-response"],
  ])("records suppression without inventing zero source bursts: %s", (text, status, reason) => {
    expect(parseAgentTurn("codex-sol", text).diagnostics).toMatchObject({ dispositionStatus: status, suppressionReason: reason, parsedBurstCount: null });
  });

  it("accounts for parser filtering and limit truncation without copying text into diagnostics", () => {
    const parsed = parseAgentTurn("codex-sol", '[SOL] Plan mode is active.\n\n[SOL] First 😀.\n<<<NEXT>>>\n😀\n<<<NEXT>>>\nSecond.\n<<<NEXT>>>\nThird.\nTURN_DISPOSITION: {"action":"speak"}\nCONVERSATION_STATE: OPEN', undefined, 2);
    expect(parsed.visibleMessages).toEqual(["First .", "Second."]);
    expect(parsed.diagnostics).toMatchObject({
      dispositionStatus: "valid", dispositionAction: "speak", declaredConversationState: "open", effectiveConversationState: "open",
      requestedVisibleMessageLimit: 2, effectiveVisibleMessageLimit: 2, limitSource: "caller-limit",
      parsedBurstCount: 4, removedBurstCount: 1, eligibleBurstCount: 3, retainedBurstCount: 2, truncatedBurstCount: 1,
      removals: { protocolDirectives: 2, workflowPrefaceParagraphs: 1, unsupportedEmojiGraphemes: 2, unsupportedEmojiCharacters: 4, emptyBursts: 1 },
    });
    expect(parsed.diagnostics.removals.speakerLabelCharacters).toBeGreaterThan(0);
    expect(JSON.stringify(parsed.diagnostics)).not.toMatch(/First|Second|Plan mode/);
  });

  it.each([0, 1, 2.9, 8, NaN, Infinity, -1])("reports the actual slice limit for %s", (limit) => {
    const parsed = parseAgentTurn("codex-sol", "First\n<<<NEXT>>>\nSecond\n<<<NEXT>>>\nThird", undefined, limit);
    expect(parsed.diagnostics.effectiveVisibleMessageLimit).toBe(parsed.visibleMessages.length);
    expect(parsed.diagnostics.retainedBurstCount! + parsed.diagnostics.truncatedBurstCount!).toBe(3);
  });
});
