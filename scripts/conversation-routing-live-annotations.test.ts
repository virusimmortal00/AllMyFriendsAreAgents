import { describe, expect, it } from "vitest";
import {
  type ObservedConversationRun,
  parsePrivateConversationRatings,
  summarizeConversationRatings,
} from "./conversation-routing-live-annotations.js";

const baseline = {
  scenarioId: "direct-address",
  runId: "baseline-1",
  privateNote: "Private reviewer text, possibly including a URL or model output, must disappear.",
  directReply: { status: "rated", expectedTargets: 2, missedTargets: 1, humanCorrection: true },
  naturalness: { status: "rated", score: 2 },
  distinctValue: { status: "rated", assessedReplies: 2, valuableReplies: 1 },
  replyWaste: { status: "rated", assessedReplies: 2, unnecessaryReplies: 1, duplicateReplies: 1 },
  handoff: { status: "not_applicable" },
  closure: { status: "rated", correct: false },
};
const candidate = {
  scenarioId: "direct-address",
  runId: "candidate-1",
  directReply: { status: "rated", expectedTargets: 2, missedTargets: 0, humanCorrection: false },
  naturalness: { status: "rated", score: 4 },
  distinctValue: { status: "rated", assessedReplies: 2, valuableReplies: 2 },
  replyWaste: { status: "rated", assessedReplies: 2, unnecessaryReplies: 0, duplicateReplies: 0 },
  handoff: { status: "not_applicable" },
  closure: { status: "rated", correct: true },
};
const observed: ObservedConversationRun[] = [
  {
    scenarioId: "direct-address",
    runId: "baseline-1",
    reportedCostUsd: 0.02,
    usageCoverage: "reported",
    firstVisibleMs: 6_000,
  },
  {
    scenarioId: "direct-address",
    runId: "candidate-1",
    reportedCostUsd: 0.01,
    usageCoverage: "reported",
    firstVisibleMs: 4_000,
  },
];
const pair = [{ scenarioId: "direct-address", baselineRunId: "baseline-1", candidateRunId: "candidate-1" }];

describe("private conversation ratings", () => {
  it("projects only closed scalar judgments and drops private text", () => {
    const rows = parsePrivateConversationRatings({ schemaVersion: 1, ratings: [baseline, candidate] });
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("Private reviewer text");
    expect(Object.keys(rows[0]!)).not.toContain("privateNote");
    expect(rows[0]!.directReply).toEqual({
      status: "rated",
      expectedTargets: 2,
      missedTargets: 1,
      humanCorrection: true,
    });
  });

  it("keeps explicit assessability and missing denominators separate from favorable zeroes", () => {
    const rows = parsePrivateConversationRatings({
      schemaVersion: 1,
      ratings: [
        baseline,
        candidate,
        {
          scenarioId: "quiet-chat",
          runId: "quiet-1",
          naturalness: { status: "not_assessable" },
          distinctValue: { status: "not_applicable" },
        },
      ],
    });
    const report = summarizeConversationRatings(rows);
    expect(report.coverage.naturalness).toEqual({
      ratedRuns: 2,
      notApplicableRuns: 0,
      notAssessableRuns: 1,
      missingRuns: 0,
    });
    expect(report.coverage.replyWaste).toEqual({
      ratedRuns: 2,
      notApplicableRuns: 0,
      notAssessableRuns: 0,
      missingRuns: 1,
    });
    expect(report.coverage.handoff).toEqual({
      ratedRuns: 0,
      notApplicableRuns: 2,
      notAssessableRuns: 0,
      missingRuns: 1,
    });
    expect(report.directReply).toEqual({ expectedTargets: 4, missedTargets: 1, humanCorrections: 1 });
    expect(report.naturalness.meanScore).toBe(3);
    expect(report.distinctValue).toEqual({ assessedReplies: 4, valuableReplies: 3 });
    expect(report.replyWaste).toEqual({ assessedReplies: 4, unnecessaryReplies: 1, duplicateReplies: 1 });
    expect(report.paired.reportedCostUsd).toEqual({ pairedRuns: 0, candidateMinusBaselineMean: null });
    expect(JSON.stringify(report)).not.toContain("Private reviewer text");
  });

  it("compares matched runs only when human ratings and reported usage exist on both sides", () => {
    const rows = parsePrivateConversationRatings({ schemaVersion: 1, ratings: [baseline, candidate] });
    const report = summarizeConversationRatings(rows, observed, pair);
    expect(report.paired.naturalness).toEqual({ pairedRuns: 1, candidateMinusBaselineMean: 2 });
    expect(report.paired.reportedCostUsd.pairedRuns).toBe(1);
    expect(report.paired.reportedCostUsd.candidateMinusBaselineMean).toBeCloseTo(-0.01);
    expect(report.paired.firstVisibleMs).toEqual({ pairedRuns: 1, candidateMinusBaselineMean: -2_000 });
    expect(report.paired.naturalnessAndReportedCostPairs).toBe(1);

    const partial = [{ ...observed[0]!, usageCoverage: "partial" as const }, observed[1]!];
    expect(summarizeConversationRatings(rows, partial, pair).paired.reportedCostUsd).toEqual({
      pairedRuns: 0,
      candidateMinusBaselineMean: null,
    });
    const unassessable = parsePrivateConversationRatings({
      schemaVersion: 1,
      ratings: [baseline, { ...candidate, naturalness: { status: "not_assessable" } }],
    });
    expect(summarizeConversationRatings(unassessable, observed, pair).paired.naturalness).toEqual({
      pairedRuns: 0,
      candidateMinusBaselineMean: null,
    });
    expect(summarizeConversationRatings(unassessable, observed, pair).paired.reportedCostUsd.pairedRuns).toBe(1);
  });

  it("rejects raw content fields, duplicate identities, invalid counts, and unsupported metric values", () => {
    const envelope = (row: unknown) => ({ schemaVersion: 1, ratings: [row] });
    for (const key of ["prompt", "output", "url", "credential", "transcript"]) {
      expect(() => parsePrivateConversationRatings(envelope({ ...baseline, [key]: "private" }))).toThrow();
    }
    expect(() => parsePrivateConversationRatings({ schemaVersion: 1, ratings: [baseline, baseline] })).toThrow();
    expect(() =>
      parsePrivateConversationRatings(
        envelope({
          ...baseline,
          directReply: { status: "rated", expectedTargets: 1, missedTargets: 2, humanCorrection: false },
        }),
      ),
    ).toThrow();
    expect(() =>
      parsePrivateConversationRatings(envelope({ ...baseline, naturalness: { status: "rated", score: 0 } })),
    ).toThrow();
    expect(() =>
      parsePrivateConversationRatings(envelope({ ...baseline, handoff: { status: "not_assessable", correct: true } })),
    ).toThrow();
    expect(() => parsePrivateConversationRatings(envelope({ ...baseline, privateNote: "x".repeat(1_001) }))).toThrow();
    expect(() =>
      parsePrivateConversationRatings({ schemaVersion: 1, ratings: Array.from({ length: 501 }, () => baseline) }),
    ).toThrow();
  });

  it("rejects malformed comparisons and never converts null usage to zero", () => {
    const rows = parsePrivateConversationRatings({ schemaVersion: 1, ratings: [baseline, candidate] });
    expect(() =>
      summarizeConversationRatings(
        rows,
        [{ ...observed[0]!, runId: null } as unknown as ObservedConversationRun],
        pair,
      ),
    ).toThrow();
    expect(() => summarizeConversationRatings(rows, [{ ...observed[0]!, reportedCostUsd: null }], pair)).toThrow();
    expect(() => summarizeConversationRatings(rows, observed, [pair[0]!, pair[0]!])).toThrow();
    const missing = [{ ...observed[0]!, reportedCostUsd: null, usageCoverage: "missing" as const }, observed[1]!];
    expect(summarizeConversationRatings(rows, missing, pair).paired.reportedCostUsd).toEqual({
      pairedRuns: 0,
      candidateMinusBaselineMean: null,
    });
  });
});
