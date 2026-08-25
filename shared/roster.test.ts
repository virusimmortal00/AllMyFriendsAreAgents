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
      expect.objectContaining({ agentId: "claude-opus", enabled: false, providerId: "anthropic", modelId: "claude-opus-5" }),
      expect.objectContaining({ agentId: "cursor-gemini", enabled: true, providerId: "cursor", modelId: "gemini-3.1-pro" }),
    ]);
    expect(validateRosterEntries([{ agentId: "codex-sol", enabled: true }, { agentId: "codex-sol", enabled: false }])).toBeUndefined();
    expect(validateRosterEntries([{ agentId: "custom-shell", enabled: true, command: "sh" }])).toBeUndefined();
  });

  it("accepts multiple stable OpenCode model instances and rejects duplicate conversational names", () => {
    const entries = [
      { agentId: "agent-11111111-1111-4111-8111-111111111111", conversationalName: "Alpha", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, supportsProjectWrites: true, configurationRevision: 1 },
      { agentId: "agent-22222222-2222-4222-8222-222222222222", conversationalName: "Beta", providerId: "openai", modelId: "gpt-5.6-terra", enabled: true, supportsProjectWrites: true, configurationRevision: 1 },
    ] as const;
    expect(validateRosterEntries(entries)).toHaveLength(2);
    expect(validateRosterEntries([{ ...entries[0] }, { ...entries[1], conversationalName: " alpha " }])).toBeUndefined();
  });

  it("preserves legacy participant identity while migrating execution to an unavailable OpenCode selection", () => {
    const roster = normalizeRoomAgentRoster({
      revision: 7,
      entries: [{
        agentId: "codex-sol",
        conversationalName: "Sol",
        harness: "codex",
        modelId: "gpt-5.6-sol",
        enabled: true,
        supportsProjectWrites: true,
        configurationRevision: 3,
      }],
    });

    expect(roster).toEqual({
      schemaVersion: 3,
      revision: 7,
      entries: [expect.objectContaining({
        agentId: "codex-sol",
        conversationalName: "Sol",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        configurationRevision: 3,
        sessionInvalidationReason: expect.stringContaining("OpenCode provider/model"),
        selectionConfirmationRequired: true,
      })],
    });
    expect(roster.entries[0]).not.toHaveProperty("harness");
  });

  it("does not reapply legacy invalidation after an administrator confirms a schema-v3 selection", () => {
    const roster = normalizeRoomAgentRoster({
      schemaVersion: 3,
      revision: 8,
      entries: [{ agentId: "codex-sol", conversationalName: "Sol", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true, supportsProjectWrites: true, configurationRevision: 3 }],
    });
    expect(roster.entries[0]).not.toHaveProperty("sessionInvalidationReason");
  });

  it("fails legacy or malformed projections back to the safe default", () => {
    expect(normalizeRoomAgentRoster({ revision: 4, entries: [{ agentId: "unknown", enabled: true }] })).toEqual(defaultRoomAgentRoster());
    expect(normalizeRoomAgentRoster({ revision: 4, entries: [] })).toEqual({ schemaVersion: 3, revision: 4, entries: [] });
  });

  it("never revives an old turn after disable and re-enable", () => {
    const epoch = roomAgentTurnEpoch({ revision: 2, entries: [{ agentId: "codex-sol", enabled: true }] }, "codex-sol");
    expect(epoch).toBeDefined();
    expect(roomAgentTurnEpochIsCurrent({ revision: 3, entries: [{ agentId: "codex-sol", enabled: false }] }, epoch!)).toBe(false);
    expect(roomAgentTurnEpochIsCurrent({ revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, epoch!)).toBe(false);
  });
});
