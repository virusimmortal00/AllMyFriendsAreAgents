import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeConversationCanary,
  mergeScalarCanaryManifests,
  parseScalarCanaryManifest,
  privateRatingTemplate,
} from "./conversation-routing-live-analysis.js";
import { parsePrivateConversationRatings } from "./conversation-routing-live-annotations.js";

const sha = "a".repeat(64);
const judge = (scenarioId: string, runId: string, naturalness: number, cost: number) => ({
  schemaVersion: 1,
  scenarioId,
  runId,
  judgeModel: "google/pinned-judge",
  status: "rated",
  directMisses: 0,
  responsiveness: naturalness,
  naturalness,
  distinctValue: naturalness,
  unnecessaryReplies: 0,
  duplicateReplies: 0,
  handoffCorrect: null,
  closureCorrect: true,
  judgeUsage: { inputTokens: 40, outputTokens: 20, reportedCostUsd: cost },
});
const trigger = (variant: "jev-on" | "jev-off", changes: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  scenarioId: "direct-2-low-enforce",
  variant,
  runId: variant === "jev-on" ? "run-on" : "run-off",
  preflightMode: "enforce",
  requiredAddressAgents: ["codex-sol"],
  routing: [{ agentId: "codex-sol", outcome: "invoke", reason: "required_plain_address" }],
  classifier:
    variant === "jev-on"
      ? {
          outcome: "completed",
          reason: null,
          durationMs: 400,
          reportedInputTokens: 10,
          reportedOutputTokens: 0,
          reportedCostUsd: 0.001,
        }
      : {
          outcome: "skipped",
          reason: "room-disabled",
          durationMs: 0,
          reportedInputTokens: null,
          reportedOutputTokens: null,
          reportedCostUsd: null,
        },
  queueDelayMs: 100,
  firstVisibleMs: variant === "jev-on" ? 2_000 : 3_000,
  terminalReason: "no-explicit-unresolved-state",
  attemptedTurns: 1,
  respondedTurns: 1,
  yieldedTurns: 0,
  confirmedDeliveredBursts: 1,
  generationStarts: 1,
  generationCompletions: 1,
  generationFailures: 0,
  openCodeUsageProvenance: "step-fields-v1",
  openCodeObservedInputTokens: 100,
  openCodeObservedOutputTokens: 50,
  openCodeObservedReasoningTokens: 5,
  openCodeObservedCacheReadTokens: 20,
  openCodeObservedCacheWriteTokens: 0,
  openCodeObservedTotalTokens: 175,
  openCodeTotalCoverage: "reported",
  openCodeEstimatedCostUsd: variant === "jev-on" ? 0.02 : 0.03,
  openCodeUsageCoverage: "reported",
  ...changes,
});
const manifest = (changes: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "conversation-routing-live-canary",
  sourceCommit: "b".repeat(40),
  sourceDirty: false,
  sourceSha256: sha,
  scenarioCatalogSha256: sha,
  openCodeVersion: "1.18.25",
  actorModel: "openrouter/example/actor-model",
  judgeModel: "openrouter/google/pinned-judge",
  concurrency: 1,
  maxCases: 12,
  maxGenerationsPerCase: 8,
  scenarioTimeoutMs: 120_000,
  totalTimeoutMs: 2_400_000,
  cases: (["jev-on", "jev-off"] as const).map((variant) => ({
    schemaVersion: 1,
    scenarioId: "direct-2-low-enforce",
    variant,
    agentCount: 2,
    energy: "low",
    preflightMode: "enforce",
    triggers: [trigger(variant)],
    judge: [
      judge("direct-2-low-enforce", variant === "jev-on" ? "run-on" : "run-off", variant === "jev-on" ? 4 : 2, 0.002),
    ],
    privateReviewRetained: true,
  })),
  ...changes,
});

describe("provider-free conversation canary analysis", () => {
  it("pairs Jev variants and keeps judge-only and human-rated naturalness separate", () => {
    const scalar = parseScalarCanaryManifest(manifest());
    const ratings = parsePrivateConversationRatings({
      schemaVersion: 1,
      ratings: [
        {
          scenarioId: "direct-2-low-enforce",
          runId: "run-on",
          privateNote: "Private reply text must disappear",
          naturalness: { status: "rated", score: 5 },
          directReply: { status: "rated", expectedTargets: 1, missedTargets: 0, humanCorrection: false },
        },
        {
          scenarioId: "direct-2-low-enforce",
          runId: "run-off",
          naturalness: { status: "rated", score: 2 },
          directReply: { status: "rated", expectedTargets: 1, missedTargets: 1, humanCorrection: true },
        },
      ],
    });
    const report = analyzeConversationCanary(scalar, ratings, { seed: "pilot-1", maxSpotChecks: 2 });
    expect(report.matchedPairs).toBe(1);
    expect(report.judgeOnly.pairedNaturalness).toEqual({ pairedRuns: 1, candidateMinusBaselineMean: 2 });
    expect(report.judgeOnly.naturalnessAndMixedCost).toEqual({
      pairedRuns: 1,
      naturalness: { pairedRuns: 1, candidateMinusBaselineMean: 2 },
      actorEstimatedPlusJevReportedCostUsd: { pairedRuns: 1, candidateMinusBaselineMean: expect.closeTo(-0.009, 6) },
    });
    expect(report.judgeOnly.naturalnessAndObservedTokens).toEqual({
      pairedRuns: 1,
      naturalness: { pairedRuns: 1, candidateMinusBaselineMean: 2 },
      openCodeObservedTotalPlusJevPromptCompletionTokens: { pairedRuns: 1, candidateMinusBaselineMean: 10 },
    });
    expect(report.humanRated?.paired.naturalness).toEqual({ pairedRuns: 1, candidateMinusBaselineMean: 3 });
    expect(report.humanRated?.naturalnessAndMixedCost).toEqual({
      pairedRuns: 1,
      naturalness: { pairedRuns: 1, candidateMinusBaselineMean: 3 },
      actorEstimatedPlusJevReportedCostUsd: { pairedRuns: 1, candidateMinusBaselineMean: expect.closeTo(-0.009, 6) },
    });
    expect(report.humanRated?.naturalnessAndObservedTokens).toEqual({
      pairedRuns: 1,
      naturalness: { pairedRuns: 1, candidateMinusBaselineMean: 3 },
      openCodeObservedTotalPlusJevPromptCompletionTokens: { pairedRuns: 1, candidateMinusBaselineMean: 10 },
    });
    expect(report.humanRated?.directReply).toEqual({ expectedTargets: 2, missedTargets: 1, humanCorrections: 1 });
    expect(report.humanReviewCoverage).toMatchObject({ submittedRuns: 2, unsubmittedRuns: 0 });
    expect(report.pairedActorAndJev.actorEstimatedPlusJevReportedCostUsd.pairedRuns).toBe(1);
    expect(report.pairedActorAndJev.actorEstimatedPlusJevReportedCostUsd.candidateMinusBaselineMean).toBeCloseTo(
      -0.009,
    );
    expect(report.pairedActorAndJev.openCodeObservedTotalPlusJevPromptCompletionTokens).toEqual({
      pairedRuns: 1,
      candidateMinusBaselineMean: 10,
    });
    expect(report.variants["jev-on"]?.jevReportedCostUsd).toEqual({ reportedRuns: 1, missingRuns: 0, total: 0.001 });
    expect(report.variants["jev-on"]?.openCodeObservedTotalPlusJevPromptCompletionTokens).toEqual({
      reportedRuns: 1,
      missingRuns: 0,
      total: 185,
    });
    expect(report.variants["jev-on"]?.judgeReportedCostUsd).toEqual({ reportedRuns: 1, missingRuns: 0, total: 0.002 });
    expect(report.spotChecks).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain("Private reply text");
    expect(JSON.stringify(report)).not.toContain('"prompt":');
  });

  it("preserves missing denominators and never treats partial actor/Jev usage as zero", () => {
    const fixture = manifest();
    const cases = fixture.cases.map((row) =>
      row.variant === "jev-on"
        ? {
            ...row,
            triggers: [
              trigger("jev-on", {
                openCodeUsageCoverage: "partial",
                openCodeEstimatedCostUsd: null,
                classifier: {
                  outcome: "completed",
                  reason: null,
                  durationMs: 400,
                  reportedInputTokens: 10,
                  reportedOutputTokens: 0,
                  reportedCostUsd: null,
                },
              }),
            ],
            judge: [],
          }
        : row,
    );
    const report = analyzeConversationCanary(parseScalarCanaryManifest({ ...fixture, cases }));
    expect(report.variants["jev-on"]?.actorEstimatedPlusJevReportedCostUsd).toEqual({
      reportedRuns: 0,
      missingRuns: 1,
      total: null,
    });
    expect(report.judgeOnly).toMatchObject({ judgedRuns: 1, missingRuns: 1 });
    expect(report.humanRated).toBeNull();
    expect(report.humanReviewCoverage).toMatchObject({
      submittedRuns: 0,
      unsubmittedRuns: 2,
      metrics: { naturalness: { ratedRuns: 0, missingRuns: 2 } },
    });
    expect(report.pairedActorAndJev.actorEstimatedPlusJevReportedCostUsd).toEqual({
      pairedRuns: 0,
      candidateMinusBaselineMean: null,
    });
    expect(report.pairedActorAndJev.openCodeObservedTotalPlusJevPromptCompletionTokens).toEqual({
      pairedRuns: 1,
      candidateMinusBaselineMean: 10,
    });
    expect(report.judgeOnly.naturalnessAndMixedCost.pairedRuns).toBe(0);
  });

  it("creates an unrated private template and rejects raw content in a scalar manifest", () => {
    const scalar = parseScalarCanaryManifest(manifest());
    expect(privateRatingTemplate(scalar)).toEqual({
      schemaVersion: 1,
      ratings: [
        { scenarioId: "direct-2-low-enforce", runId: "run-on" },
        { scenarioId: "direct-2-low-enforce", runId: "run-off" },
      ],
    });
    expect(() => parseScalarCanaryManifest({ ...manifest(), prompt: "private" })).toThrow();
    const bad = manifest();
    expect(() =>
      parseScalarCanaryManifest({
        ...bad,
        cases: [{ ...bad.cases[0], judge: [{ ...bad.cases[0]!.judge[0], rawOutput: "private" }] }],
      }),
    ).toThrow();
    expect(() =>
      parseScalarCanaryManifest({
        ...bad,
        cases: [{ ...bad.cases[0], triggers: [{ ...bad.cases[0]!.triggers[0], text: "private" }] }],
      }),
    ).toThrow();
    expect(() =>
      parseScalarCanaryManifest({
        ...bad,
        cases: [
          { ...bad.cases[0], triggers: [trigger("jev-on", { openCodeUsageProvenance: "claimed-provider-billing" })] },
        ],
      }),
    ).toThrow();
  });

  it("rejects mislabeled Jev evidence, duplicate judge rows, and ratings outside the manifest", () => {
    const fixture = manifest();
    const on = fixture.cases[0]!;
    const off = fixture.cases[1]!;
    expect(() =>
      parseScalarCanaryManifest({
        ...fixture,
        cases: [{ ...on, triggers: [trigger("jev-on", { classifier: trigger("jev-off").classifier })] }, off],
      }),
    ).toThrow();
    expect(() =>
      parseScalarCanaryManifest({
        ...fixture,
        cases: [on, { ...off, triggers: [trigger("jev-off", { classifier: trigger("jev-on").classifier })] }],
      }),
    ).toThrow();
    expect(() =>
      parseScalarCanaryManifest({ ...fixture, cases: [{ ...on, judge: [on.judge[0], on.judge[0]] }, off] }),
    ).toThrow();
    const unrelated = parsePrivateConversationRatings({
      schemaVersion: 1,
      ratings: [{ scenarioId: "unknown-scenario", runId: "unknown-run", naturalness: { status: "rated", score: 5 } }],
    });
    expect(() => analyzeConversationCanary(parseScalarCanaryManifest(fixture), unrelated)).toThrow();
  });

  it("counts unrated runs as missing for each human metric", () => {
    const ratings = parsePrivateConversationRatings({
      schemaVersion: 1,
      ratings: [{ scenarioId: "direct-2-low-enforce", runId: "run-on", naturalness: { status: "not_assessable" } }],
    });
    const report = analyzeConversationCanary(parseScalarCanaryManifest(manifest()), ratings);
    expect(report.humanReviewCoverage).toMatchObject({
      submittedRuns: 1,
      unsubmittedRuns: 1,
      metrics: {
        naturalness: { ratedRuns: 0, notAssessableRuns: 1, missingRuns: 1 },
        directReply: { ratedRuns: 0, notAssessableRuns: 0, missingRuns: 2 },
      },
    });
  });

  it("merges separate compatible final manifests and rejects incompatible or duplicate cases", () => {
    const fixture = manifest();
    const on = parseScalarCanaryManifest({
      ...fixture,
      cases: [fixture.cases[0]],
      scenarioCatalogSha256: "c".repeat(64),
    });
    const off = parseScalarCanaryManifest({
      ...fixture,
      cases: [fixture.cases[1]],
      scenarioCatalogSha256: "d".repeat(64),
    });
    const combined = mergeScalarCanaryManifests([on, off]);
    expect(combined.scenarioCatalogSha256s).toEqual(["c".repeat(64), "d".repeat(64)]);
    expect(analyzeConversationCanary(combined).matchedPairs).toBe(1);
    expect(() => mergeScalarCanaryManifests([on, on])).toThrow();
    expect(() => mergeScalarCanaryManifests([on, { ...off, sourceSha256: "e".repeat(64) }])).toThrow();
    expect(() => mergeScalarCanaryManifests([on, { ...off, actorModel: "openrouter/other/model" }])).toThrow();
    expect(() => mergeScalarCanaryManifests([on, { ...off, judgeModel: "openrouter/other/judge" }])).toThrow();
    expect(() =>
      mergeScalarCanaryManifests([
        { ...on, judgeModel: null, cases: [{ ...on.cases[0]!, judge: [] }] },
        off,
        { ...off, cases: [], judgeModel: "openrouter/other/judge" },
      ]),
    ).toThrow();
    expect(() => mergeScalarCanaryManifests([on, { ...off, openCodeVersion: "1.18.26" }])).toThrow();
    expect(() =>
      mergeScalarCanaryManifests([on, { ...off, cases: [{ ...off.cases[0]!, energy: "party" }] }]),
    ).toThrow();
  });

  it("keeps older normalized amounts diagnostic but excludes them from cost and token comparisons", () => {
    const fixture = manifest();
    const cases = fixture.cases.map((row) => {
      const oldTrigger: Record<string, unknown> = { ...row.triggers[0] };
      for (const field of [
        "openCodeUsageProvenance",
        "openCodeObservedInputTokens",
        "openCodeObservedOutputTokens",
        "openCodeObservedReasoningTokens",
        "openCodeObservedCacheReadTokens",
        "openCodeObservedCacheWriteTokens",
        "openCodeObservedTotalTokens",
        "openCodeEstimatedCostUsd",
        "openCodeUsageCoverage",
        "openCodeTotalCoverage",
      ])
        delete oldTrigger[field];
      oldTrigger.reportedInputTokens = 100;
      oldTrigger.reportedOutputTokens = 50;
      oldTrigger.reportedTotalTokens = 175;
      oldTrigger.totalTokenCoverage = "reported";
      oldTrigger.reportedCostUsd = row.variant === "jev-on" ? 0.02 : 0.03;
      oldTrigger.usageCoverage = "reported";
      return { ...row, triggers: [oldTrigger] };
    });
    const report = analyzeConversationCanary(parseScalarCanaryManifest({ ...fixture, cases }));
    expect(report.pairedActorAndJev.actorEstimatedPlusJevReportedCostUsd.pairedRuns).toBe(0);
    expect(report.pairedActorAndJev.openCodeObservedTotalPlusJevPromptCompletionTokens).toEqual({
      pairedRuns: 0,
      candidateMinusBaselineMean: null,
    });
    expect(report.variants["jev-on"]?.legacyUnverifiedRuns).toBe(1);
    expect(report.variants["jev-on"]?.legacyDiagnosticActorCostUsd).toEqual({
      observedRuns: 1,
      missingRuns: 0,
      unverifiedTotal: 0.02,
    });
    expect(report.variants["jev-on"]?.jevReportedCostUsd.total).toBe(0.001);
    expect(report.variants["jev-on"]?.judgeReportedCostUsd.total).toBe(0.002);
    expect(report.variants["jev-on"]?.openCodeObservedUncachedInputTokens.total).toBeNull();
    expect(report.variants["jev-on"]?.openCodeObservedTotalTokens).toEqual({
      reportedRuns: 0,
      missingRuns: 1,
      total: null,
    });
  });

  it("accepts repeated --manifest paths through the provider-free CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "conversation-canary-analysis-"));
    try {
      const fixture = manifest();
      const onPath = join(directory, "on.json");
      const offPath = join(directory, "off.json");
      writeFileSync(onPath, JSON.stringify({ ...fixture, cases: [fixture.cases[0]] }));
      writeFileSync(offPath, JSON.stringify({ ...fixture, cases: [fixture.cases[1]] }));
      const output = execFileSync(
        "pnpm",
        ["exec", "tsx", "scripts/conversation-routing-live-analysis.ts", "--manifest", onPath, "--manifest", offPath],
        { encoding: "utf8" },
      );
      const report = JSON.parse(output);
      expect(report.matchedPairs).toBe(1);
      expect(report.runs).toBe(2);
      expect(JSON.stringify(report)).not.toContain("fictional room question");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
