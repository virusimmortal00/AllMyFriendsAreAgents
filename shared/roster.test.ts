import { describe, expect, it } from "vitest";
import { AGENT_IDS, AGENT_PROFILES } from "./participants.js";
import { defaultRoomAgentRoster, enabledRoomAgentIds, normalizeRoomAgentRoster, participantConfigurationFingerprint, participantConfigurationFingerprintMatches, resolveRoomAgentTarget, resolveRoomAgentTargetPrefix, roomAgentModelReference, roomAgentTurnEpoch, roomAgentTurnEpochIsCurrent, validateRosterEntries } from "./roster.js";

describe("room roster contract", () => {
  it("migrates missing command permissions to allow-all and rejects malformed updates", () => {
    const legacy = normalizeRoomAgentRoster({ schemaVersion: 3, revision: 2, entries: [{ agentId: "codex-sol", conversationalName: "Codex", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true }] });
    expect(legacy.entries[0]?.commandPermissions).toEqual({ allowAll: true, allowed: ["task", "pov", "poll", "help"] });
    expect(validateRosterEntries([{ ...legacy.entries[0]!, commandPermissions: { allowAll: false, allowed: ["unknown" as never] } }])).toBeUndefined();
  });
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

  it("resolves exact roster mentions and fails closed on ID/name ambiguity", () => {
    const roster = normalizeRoomAgentRoster({
      schemaVersion: 3,
      revision: 1,
      entries: [
        { agentId: "codex-sol", conversationalName: "claude-sonnet", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true },
        { agentId: "claude-sonnet", conversationalName: "Claude", providerId: "anthropic", modelId: "claude-sonnet-5", enabled: true },
      ],
    });
    expect(resolveRoomAgentTarget(roster, "@Claude")).toEqual({ kind: "resolved", agentId: "claude-sonnet" });
    expect(resolveRoomAgentTarget(roster, "claude-sonnet")).toEqual({ kind: "ambiguous" });
    expect(resolveRoomAgentTarget(roster, "@Missing")).toEqual({ kind: "unknown" });
    const multiword = normalizeRoomAgentRoster({ schemaVersion: 3, revision: 1, entries: [{ agentId: "codex-sol", conversationalName: "Meta Muse", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true }] });
    expect(resolveRoomAgentTargetPrefix(multiword, "@Meta Muse compare this")).toEqual({ kind: "resolved", agentId: "codex-sol", rest: "compare this" });
  });

  it("accepts OpenRouter alias model identifiers without allowing alias provider identifiers", () => {
    const entry = { agentId: "agent-55555555-5555-4555-8555-555555555555", conversationalName: "Router", providerId: "openrouter", modelId: "~openai/gpt-latest", enabled: true };
    expect(validateRosterEntries([entry])).toEqual([expect.objectContaining(entry)]);
    expect(validateRosterEntries([{ ...entry, providerId: "~openrouter" }])).toBeUndefined();
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

  it("refreshes registered participant profiles when a roster name or model changes", () => {
    const agentId = "agent-33333333-3333-4333-8333-333333333333";
    normalizeRoomAgentRoster({ schemaVersion: 3, revision: 1, entries: [{ agentId, conversationalName: "Before", providerId: "openai", modelId: "before", enabled: true }] });
    normalizeRoomAgentRoster({ schemaVersion: 3, revision: 2, entries: [{ agentId, conversationalName: "After", providerId: "anthropic", modelId: "after", enabled: true }] });
    expect(AGENT_PROFILES[agentId]).toMatchObject({ conversationalName: "After", modelId: "after", modelLabel: "anthropic/after" });
  });

  it("recognizes fingerprints from the previous OpenCode reference format only when the selection matches", () => {
    const entry = { agentId: "agent-44444444-4444-4444-8444-444444444444", conversationalName: "Alpha", providerId: "openai", modelId: "gpt-5.6", variant: "high", enabled: true };
    expect(participantConfigurationFingerprintMatches(JSON.stringify({ harness: "opencode", providerId: "openai", modelId: "gpt-5.6", variant: "high" }), entry)).toBe(true);
    expect(participantConfigurationFingerprintMatches(JSON.stringify({ harness: "codex", providerId: "openai", modelId: "gpt-5.6", variant: "high" }), entry)).toBe(false);
    expect(participantConfigurationFingerprintMatches(participantConfigurationFingerprint(entry), entry)).toBe(true);
  });

  it("migrates legacy reasoning effort to the one OpenCode variant selection", () => {
    const entry = { agentId: "agent-66666666-6666-4666-8666-666666666666", conversationalName: "Reasoner", providerId: "openai", modelId: "gpt-5.6", reasoningEffort: "high", enabled: true };
    expect(validateRosterEntries([entry])).toEqual([expect.objectContaining({ variant: "high" })]);
    expect(validateRosterEntries([entry])?.[0]).not.toHaveProperty("reasoningEffort");
    expect(roomAgentModelReference(entry)).toEqual({ providerId: "openai", modelId: "gpt-5.6", variant: "high" });
    expect(participantConfigurationFingerprintMatches(JSON.stringify({ providerId: "openai", modelId: "gpt-5.6", reasoningEffort: "high" }), entry)).toBe(true);
  });

  it("rejects new conflicting variants and fails persisted conflicts closed", () => {
    const entry = { agentId: "agent-66666666-6666-4666-8666-666666666667", conversationalName: "Conflict", providerId: "openai", modelId: "gpt-5.6", variant: "high", reasoningEffort: "low", enabled: true };
    expect(validateRosterEntries([entry])).toBeUndefined();
    expect(normalizeRoomAgentRoster({ schemaVersion: 3, revision: 2, entries: [entry] }).entries[0]).toMatchObject({
      variant: "high",
      selectionConfirmationRequired: true,
      sessionInvalidationReason: expect.stringContaining("Conflicting legacy variant"),
    });
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
