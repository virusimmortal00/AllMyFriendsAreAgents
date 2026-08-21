import { describe, expect, it } from "vitest";
import {
  applyImprovementStatusTransition,
  emptyImprovementStatus,
  parseImprovementStatus,
  serializeImprovementStatus,
  validateImprovementStatus,
  type ImprovementStatusContract,
} from "./improvement-status.js";

const evidence = [{ id: "test-run", uri: "https://ci.example/runs/42" }] as const;

function fullyPopulated(): ImprovementStatusContract {
  return {
    schemaVersion: 1,
    implementation: {
      state: "IMPLEMENTED",
      codeLocation: {
        immutableRevision: "9d7a4c1",
        repository: "https://example.test/friends/agents.git",
        branch: "codex/status-contract",
        worktree: "/workspace/status-contract",
      },
    },
    deployment: { state: "DEPLOYED", generation: "prod-184", environment: "production" },
    developerTeamEvidence: { state: "AVAILABLE", evidence },
    independentAcceptance: {
      state: "ACCEPTED",
      assessedBy: "independent-reviewer",
      assessedAt: "2026-08-21T16:00:00.000Z",
      evidence: [{ id: "acceptance", uri: "https://reviews.example/acceptance/7" }],
    },
    upstreamPublication: {
      state: "PUBLISHED",
      revision: "refs/pull/17/head@9d7a4c1",
      location: "https://example.test/friends/agents/pull/17",
    },
    nextAction: { state: "ACTION_REQUIRED", action: "Monitor the production generation" },
  };
}

describe("versioned six-field improvement status contract", () => {
  it("represents valid partial records without borrowing another field's value", () => {
    const implemented = applyImprovementStatusTransition(emptyImprovementStatus(), {
      field: "implementation",
      value: {
        state: "IMPLEMENTED",
        codeLocation: {
          immutableRevision: "9d7a4c1",
          repository: "https://example.test/friends/agents.git",
          branch: null,
          worktree: "/workspace/status-contract",
        },
      },
    });
    const status: ImprovementStatusContract = {
      ...implemented,
      deployment: { state: "PENDING" },
      developerTeamEvidence: { state: "PENDING" },
      independentAcceptance: { state: "UNKNOWN" },
      upstreamPublication: { state: "NOT_APPLICABLE" },
      nextAction: { state: "PENDING" },
    };

    expect(validateImprovementStatus(status)).toBeNull();
    expect(status.implementation.state).toBe("IMPLEMENTED");
    expect(status.deployment).toEqual({ state: "PENDING" });
    expect(status.independentAcceptance).toEqual({ state: "UNKNOWN" });
    expect(status.upstreamPublication).toEqual({ state: "NOT_APPLICABLE" });
  });

  it("validates a record with all six fields populated independently", () => {
    expect(validateImprovementStatus(fullyPopulated())).toBeNull();
  });

  it("rejects conflated values instead of treating code, evidence, or publication as another field", () => {
    expect(() => applyImprovementStatusTransition(emptyImprovementStatus(), {
      field: "deployment",
      value: { state: "DEPLOYED", generation: "9d7a4c1", environment: "prod", immutableRevision: "9d7a4c1" },
    } as never)).toThrow(/Deployment must be unresolved or contain only generation and environment/);

    expect(() => applyImprovementStatusTransition(emptyImprovementStatus(), {
      field: "independentAcceptance",
      value: { state: "ACCEPTED", evidence },
    } as never)).toThrow(/explicit assessment/);

    expect(() => applyImprovementStatusTransition(emptyImprovementStatus(), {
      field: "upstreamPublication",
      value: { state: "PUBLISHED", revision: "local-only", location: "", codeLocation: "/workspace" },
    } as never)).toThrow(/Publication must be unresolved or contain only upstream revision and location/);
  });

  it("round-trips the complete contract without changing any field", () => {
    const status = fullyPopulated();
    expect(parseImprovementStatus(serializeImprovementStatus(status))).toEqual(status);
  });
});
