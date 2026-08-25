import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "./participants.js";
import { defaultRoomAgentRoster, enabledRoomAgentIds, normalizeRoomAgentRoster, roomAgentTurnEpoch, roomAgentTurnEpochIsCurrent, validateRosterEntries } from "./roster.js";

describe("room roster contract", () => {
  it("defaults to the public roster without Gemini Pro", () => {
    const roster = defaultRoomAgentRoster();
    expect(roster.revision).toBe(1);
    expect(enabledRoomAgentIds(roster)).toEqual(AGENT_IDS);
    expect(enabledRoomAgentIds(roster)).not.toContain("cursor-gemini");
  });

  it("accepts ordered catalog entries and rejects executable or duplicate substitutions", () => {
    expect(validateRosterEntries([
      { agentId: "claude-opus", enabled: false },
      { agentId: "cursor-gemini", enabled: true },
    ])).toEqual([
      { agentId: "claude-opus", enabled: false },
      { agentId: "cursor-gemini", enabled: true },
    ]);
    expect(validateRosterEntries([{ agentId: "codex-sol", enabled: true }, { agentId: "codex-sol", enabled: false }])).toBeUndefined();
    expect(validateRosterEntries([{ agentId: "custom-shell", enabled: true, command: "sh" }])).toBeUndefined();
  });

  it("fails legacy or malformed projections back to the safe default", () => {
    expect(normalizeRoomAgentRoster({ revision: 4, entries: [{ agentId: "unknown", enabled: true }] })).toEqual(defaultRoomAgentRoster());
    expect(normalizeRoomAgentRoster({ revision: 4, entries: [] })).toEqual({ revision: 4, entries: [] });
  });

  it("never revives an old turn after disable and re-enable", () => {
    const epoch = roomAgentTurnEpoch({ revision: 2, entries: [{ agentId: "codex-sol", enabled: true }] }, "codex-sol");
    expect(epoch).toBeDefined();
    expect(roomAgentTurnEpochIsCurrent({ revision: 3, entries: [{ agentId: "codex-sol", enabled: false }] }, epoch!)).toBe(false);
    expect(roomAgentTurnEpochIsCurrent({ revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, epoch!)).toBe(false);
  });
});
