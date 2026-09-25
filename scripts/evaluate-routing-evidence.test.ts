import { describe, expect, it } from "vitest";
import {
  evaluateFixtureRouting,
  parseObservedRoutingEvidence,
  summarizeObservedRouting,
} from "./evaluate-routing-evidence.js";

describe("bounded routing evidence", () => {
  it("keeps the fictional direct-address fixture corpus free of target misses and false requirements", () => {
    expect(evaluateFixtureRouting()).toMatchObject({
      baseline: { missedAddressSignals: 15, falseAddressSignals: 9 },
      candidate: { missedAddressSignals: 0, falseAddressSignals: 0 },
    });
  });

  it("counts only observed attempts and explicitly annotated quality", () => {
    const rows = parseObservedRoutingEvidence({
      schemaVersion: 1,
      triggers: [
        {
          expectedDirectAgents: ["agent-sol"],
          requiredAddressAgents: [],
          attemptedTurns: 2,
          yieldedTurns: 1,
          respondingTurns: 1,
          missedDirectReplies: 1,
          humanCorrection: true,
          duplicateReplies: 1,
          inputTokens: 40,
          outputTokens: 12,
          costUsd: 0.003,
          firstVisibleMs: 900,
        },
        { requiredAddressAgents: ["agent-grok"], attemptedTurns: 1, yieldedTurns: 1, respondingTurns: 0 },
      ],
    });
    expect(summarizeObservedRouting(rows)).toMatchObject({
      triggers: 2,
      annotatedDirectAddressTriggers: 1,
      expectedDirectTargets: 1,
      missedRequiredSelections: 1,
      missedDirectReplies: { observedTriggers: 1, total: 1 },
      falseMandatoryTargets: 0,
      attemptedTurns: 3,
      yieldedTurns: 2,
      respondingTurns: 1,
      duplicateReplies: { observedTriggers: 1, total: 1 },
      distinctAmbientContributions: null,
      unnecessaryReplies: null,
      humanCorrections: { observedTriggers: 1, total: 1 },
      providerCostUsd: { observedTriggers: 1, total: 0.003 },
      firstVisibleMs: { observedTriggers: 1, average: 900 },
    });
  });

  it("rejects transcript content, unbounded arrays, invalid counts, and duplicate identities", () => {
    const row = { requiredAddressAgents: [], attemptedTurns: 1, yieldedTurns: 0, respondingTurns: 1 };
    expect(() =>
      parseObservedRoutingEvidence({ schemaVersion: 1, triggers: [{ ...row, text: "private text" }] }),
    ).toThrow();
    expect(() =>
      parseObservedRoutingEvidence({ schemaVersion: 1, triggers: Array.from({ length: 501 }, () => row) }),
    ).toThrow();
    expect(() => parseObservedRoutingEvidence({ schemaVersion: 1, triggers: [{ ...row, yieldedTurns: 1 }] })).toThrow();
    expect(() =>
      parseObservedRoutingEvidence({ schemaVersion: 1, triggers: [{ ...row, duplicateReplies: 2 }] }),
    ).toThrow();
    expect(() => parseObservedRoutingEvidence({ schemaVersion: 1, triggers: [{ ...row, costUsd: 1_001 }] })).toThrow();
    expect(() =>
      parseObservedRoutingEvidence({ schemaVersion: 1, triggers: [{ ...row, missedDirectReplies: 1 }] }),
    ).toThrow();
    expect(() =>
      parseObservedRoutingEvidence({
        schemaVersion: 1,
        triggers: [{ ...row, requiredAddressAgents: ["agent-sol", "agent-sol"] }],
      }),
    ).toThrow();
  });
});
