import { describe, expect, it } from "vitest";
import {
  activateEmergencyStop,
  allowedLifecycleTransitions,
  applyImprovementChange,
  BOUNDED_FIRST_SLICE_EXCLUSIONS,
  createImprovement,
  evaluateActionPolicy,
  type DomainActor,
  type Improvement,
  type ImprovementChange,
  type ImprovementRisk,
} from "./improvement-domain.js";

const NOW = "2026-08-21T12:00:00.000Z";
const author: DomainActor = { id: "author", role: "AUTHOR", human: true };
const reviewer1: DomainActor = { id: "reviewer-1", role: "REVIEWER", human: true };
const reviewer2: DomainActor = { id: "reviewer-2", role: "REVIEWER", human: true };
const operator: DomainActor = { id: "operator", role: "OPERATOR", human: true };

function change(current: Improvement, value: ImprovementChange, actor: DomainActor): Improvement {
  const result = applyImprovementChange(current, current.revision, value, actor, NOW);
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error(result.kind);
  return result.improvement;
}

function actionable(risk: ImprovementRisk, independentReviewers: number, authority = true): Improvement {
  let value = createImprovement({ id: `imp-${risk}`, risk, author, now: NOW });
  value = change(value, { kind: "TRANSITION", to: "PROPOSED" }, author);
  value = change(value, { kind: "TRANSITION", to: "IN_REVIEW" }, reviewer1);
  const reviewers = [author, reviewer1, reviewer2].slice(0, independentReviewers + 1);
  for (const reviewer of reviewers) {
    const reviewActor = reviewer === author ? { ...author, role: "REVIEWER" as const } : reviewer;
    value = change(value, { kind: "RECORD_TECHNICAL_REVIEW", decision: "APPROVE" }, reviewActor);
  }
  value = change(value, { kind: "TRANSITION", to: "APPROVED" }, reviewer1);
  if (authority) {
    value = change(value, { kind: "SET_ACTION_AUTHORITY", status: "GRANTED", allowedActions: ["RUN_TESTS"] }, operator);
  }
  return value;
}

describe("improvement revision and history", () => {
  it("has a stable ID, monotonic revision, timestamps, actor attribution, and append-only evidence", () => {
    const initial = createImprovement({ id: "imp-1", risk: "LOW", author, claims: [{ id: "c1", statement: "Faster" }], now: NOW });
    const withEvidence = change(initial, { kind: "ADD_EVIDENCE", evidence: { id: "e1", uri: "test://one", description: "baseline" } }, reviewer1);
    const withMoreEvidence = change(withEvidence, { kind: "ADD_EVIDENCE", evidence: { id: "e2", uri: "test://two", description: "result" } }, reviewer2);

    expect(withMoreEvidence.id).toBe(initial.id);
    expect([initial.revision, withEvidence.revision, withMoreEvidence.revision]).toEqual([1, 2, 3]);
    expect(withMoreEvidence.evidence.map((item) => item.id)).toEqual(["e1", "e2"]);
    expect(withMoreEvidence.evidence.map((item) => item.addedBy)).toEqual(["reviewer-1", "reviewer-2"]);
    expect(withMoreEvidence.attribution.map((entry) => entry.actorId)).toEqual(["author", "reviewer-1", "reviewer-2"]);
    expect(initial.evidence).toEqual([]);
    expect(withMoreEvidence.createdAt).toBe(NOW);
    expect(withMoreEvidence.updatedAt).toBe(NOW);
  });

  it("returns a distinct conflict for a stale expected revision", () => {
    const value = createImprovement({ id: "imp-1", risk: "LOW", author, now: NOW });
    expect(applyImprovementChange(value, 0, { kind: "SET_RISK", risk: "GUARDED" }, author, NOW)).toEqual({
      kind: "conflict",
      expectedRevision: 0,
      actualRevision: 1,
    });
  });
});

describe("lifecycle transitions", () => {
  it("documents the canonical transition graph", () => {
    expect(allowedLifecycleTransitions).toEqual({
      DRAFT: ["PROPOSED", "CANCELED"], PROPOSED: ["IN_REVIEW", "BLOCKED", "CANCELED"],
      IN_REVIEW: ["PROPOSED", "APPROVED", "BLOCKED", "CANCELED"], APPROVED: ["IN_PROGRESS", "IN_REVIEW", "CANCELED"],
      IN_PROGRESS: ["PAUSED", "BLOCKED", "IN_REVIEW", "COMPLETED", "CANCELED"], PAUSED: ["IN_PROGRESS", "BLOCKED", "CANCELED"],
      BLOCKED: ["PROPOSED", "IN_REVIEW", "IN_PROGRESS", "CANCELED"], CANCELED: [], COMPLETED: [],
    });
  });

  it("exercises review, pause, block, completion, and cancellation paths", () => {
    let value = actionable("LOW", 0);
    value = change(value, { kind: "TRANSITION", to: "IN_PROGRESS" }, operator);
    value = change(value, { kind: "TRANSITION", to: "PAUSED" }, operator);
    value = change(value, { kind: "TRANSITION", to: "BLOCKED" }, operator);
    value = change(value, { kind: "TRANSITION", to: "IN_PROGRESS" }, operator);
    value = change(value, { kind: "TRANSITION", to: "IN_REVIEW" }, reviewer1);
    expect(change(value, { kind: "TRANSITION", to: "CANCELED" }, author).state).toBe("CANCELED");

    let completion = actionable("LOW", 0);
    completion = change(completion, { kind: "TRANSITION", to: "IN_PROGRESS" }, operator);
    expect(change(completion, { kind: "TRANSITION", to: "COMPLETED" }, operator).state).toBe("COMPLETED");
  });

  it("rejects illegal and unauthorized transitions", () => {
    const value = createImprovement({ id: "imp-1", risk: "LOW", author, now: NOW });
    expect(applyImprovementChange(value, 1, { kind: "TRANSITION", to: "COMPLETED" }, operator, NOW)).toMatchObject({ kind: "rejected" });
    expect(applyImprovementChange(value, 1, { kind: "TRANSITION", to: "PROPOSED" }, reviewer1, NOW)).toMatchObject({ kind: "rejected" });
  });
});

describe("action policy", () => {
  const clearStop = { active: false, activatedBy: null, activatedAt: null, reason: null };
  const riskCases: readonly (readonly [ImprovementRisk, number])[] = [["LOW", 0], ["GUARDED", 1], ["RESTRICTED", 2]];

  it.each(riskCases)(
    "authorizes %s only with its independent-review threshold and current authority",
    (risk, reviewers) => {
      const value = actionable(risk, reviewers);
      expect(evaluateActionPolicy({ improvement: value, action: "RUN_TESTS", autonomous: true, emergencyStop: clearStop })).toMatchObject({
        authorized: true, consensusGate: true, authorityGate: true,
      });
      if (reviewers > 0) {
        let insufficient = actionable("LOW", 0);
        insufficient = change(insufficient, { kind: "SET_RISK", risk }, author);
        expect(evaluateActionPolicy({ improvement: insufficient, action: "RUN_TESTS", autonomous: true, emergencyStop: clearStop })).toMatchObject({
          authorized: false, consensusGate: false,
        });
      }
    },
  );

  it("keeps technical consensus and action authority as separate mandatory gates", () => {
    const consensusOnly = actionable("LOW", 0, false);
    expect(evaluateActionPolicy({ improvement: consensusOnly, action: "RUN_TESTS", autonomous: true, emergencyStop: clearStop })).toMatchObject({
      authorized: false, consensusGate: true, authorityGate: false,
    });

    let authorityOnly = createImprovement({ id: "authority-only", risk: "LOW", author, now: NOW });
    authorityOnly = change(authorityOnly, { kind: "TRANSITION", to: "PROPOSED" }, author);
    authorityOnly = change(authorityOnly, { kind: "TRANSITION", to: "IN_REVIEW" }, reviewer1);
    authorityOnly = change(authorityOnly, { kind: "SET_ACTION_AUTHORITY", status: "GRANTED", allowedActions: ["RUN_TESTS"] }, operator);
    expect(evaluateActionPolicy({ improvement: authorityOnly, action: "RUN_TESTS", autonomous: true, emergencyStop: clearStop })).toMatchObject({
      authorized: false, consensusGate: false, authorityGate: true,
    });
  });

  it("explicitly excludes dangerous operations in the bounded first slice", () => {
    const value = actionable("LOW", 0);
    expect(BOUNDED_FIRST_SLICE_EXCLUSIONS).toEqual(["MERGE", "DEPLOY", "CHANGE_CREDENTIALS", "DESTRUCTIVE_OPERATION", "EDIT_LIVE_CHECKOUT"]);
    for (const action of BOUNDED_FIRST_SLICE_EXCLUSIONS) {
      expect(evaluateActionPolicy({ improvement: value, action, autonomous: true, emergencyStop: clearStop }).authorized).toBe(false);
    }
  });

  it("blocks new autonomous action when the emergency stop is active", () => {
    const value = actionable("LOW", 0);
    const stop = activateEmergencyStop(operator, "unsafe behavior", NOW);
    expect(evaluateActionPolicy({ improvement: value, action: "RUN_TESTS", autonomous: true, emergencyStop: stop })).toMatchObject({ authorized: false });
    expect(stop).toMatchObject({ active: true, activatedBy: "operator", reason: "unsafe behavior" });
  });
});
