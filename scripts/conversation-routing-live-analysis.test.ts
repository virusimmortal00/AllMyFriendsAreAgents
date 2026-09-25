import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeConversationCanary,
  analyzeQualityStudy,
  mergeScalarCanaryManifests,
  parseScalarCanaryManifest,
  privateRatingTemplate,
} from "./conversation-routing-live-analysis.js";
import {
  parsePrivateConversationRatings,
  parsePrivateQualityRatings,
} from "./conversation-routing-live-annotations.js";

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

const qualityOutcome = (axis: string, scenarioId: string, runId: string, score: number | null = 4) => ({
  axis,
  status: "completed",
  result: {
    schemaVersion: 2,
    rubricVersion: "room-quality-v2",
    scenarioId,
    runId,
    judgeModel: "google/pinned-judge",
    resolvedJudgeModel: "google/pinned-judge",
    axis,
    status: score === null ? "not_assessable" : "rated",
    score,
    reasonCode: score === null ? "insufficient_context" : "observable_exchange",
    details:
      axis === "social_cadence"
        ? { cueFit: score === null ? null : "attuned", textTurnRhythm: score === null ? null : "smooth" }
        : axis === "length_fit"
          ? { direction: score === null ? null : "appropriate" }
          : axis === "address_radius"
            ? { observedAudience: score === null ? null : "user", audienceFit: score === null ? null : "aligned" }
            : { valueMode: score === null ? null : "knowledge" },
    judgeUsage: { inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.001 },
  },
});
const axes = ["social_cadence", "length_fit", "address_radius", "contribution_value"];
function studyFixture() {
  const base = manifest();
  const cases = base.cases.map((row, index) => {
    const arm = index === 0 ? "a" : "b";
    const scenarioId = `study-example-${arm}`;
    const runId = `run-${arm}`;
    const secondId = `${scenarioId}-two`;
    const secondRun = `${runId}-two`;
    const variant = index === 0 ? "jev-on" : "jev-off";
    const one = {
      ...trigger(variant, {
        scenarioId,
        runId,
        classifier: { ...trigger(variant).classifier, resolvedModelId: index === 0 ? "openrouter/example/jev" : null },
      }),
    };
    const two = {
      ...trigger(variant, {
        scenarioId: secondId,
        runId: secondRun,
        classifier: { ...trigger(variant).classifier, resolvedModelId: index === 0 ? "openrouter/example/jev" : null },
      }),
    };
    return {
      ...row,
      scenarioId,
      triggers: [one, two],
      judge: [],
      qualityJudge: [
        {
          scenarioId,
          runId,
          outcomes: axes.map((axis) => qualityOutcome(axis, scenarioId, runId, index === 0 ? 4 : 2)),
        },
        {
          scenarioId: secondId,
          runId: secondRun,
          outcomes: axes.map((axis) => qualityOutcome(axis, secondId, secondRun, 3)),
        },
      ],
      study: {
        schemaVersion: 1,
        planId: "study1",
        planSha256: sha,
        blockId: "block1",
        replicateId: "rep1",
        pairId: "pair1",
        caseId: `case-${arm}`,
        arm,
        factor: "jev",
        order: "ab",
        arcProfileId: "agent-exchange-v1",
        jevProfileId: index === 0 ? "current-v1" : "off-v1",
        gateProfileId: "current-v1",
        agentPromptProfileId: "current-v1",
        agentPromptProfileDigest: sha,
        jevProfileDigest: index === 0 ? "a".repeat(64) : "b".repeat(64),
        gateProfileDigest: sha,
        rosterOrder: ["codex-sol", "codex-luna"],
      },
    };
  });
  return {
    ...base,
    judgeRubric: "v2",
    maximumScheduledJudgeCalls: 8,
    planningAllowanceMs: 1000,
    studyPlan: { schemaVersion: 1, planId: "study1", planSha256: sha, orderSeed: 42, jevModel: "example/jev" },
    cases,
  };
}

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

describe("versioned quality study analysis", () => {
  it("preserves legacy studies and counts closed availability recovery only on completed cases", () => {
    const legacy = analyzeQualityStudy(parseScalarCanaryManifest(studyFixture()));
    expect(legacy.availability.overall).toMatchObject({
      completedCases: 2,
      checksRecorded: 0,
      legacyMissingChecks: 2,
      refreshAttempted: 0,
    });
    const fixture = studyFixture();
    Object.assign(fixture.cases[0]!, {
      availabilityCheck: {
        initialDiscoveryStatus: "error",
        initialUnavailableReasons: ["runtime_unavailable"],
        refreshAttempted: true,
        finalDiscoveryStatus: "available",
        finalUnavailableReasons: [],
        recovered: true,
      },
    });
    Object.assign(fixture.cases[1]!, {
      availabilityCheck: {
        initialDiscoveryStatus: "available",
        initialUnavailableReasons: [],
        refreshAttempted: false,
        finalDiscoveryStatus: "available",
        finalUnavailableReasons: [],
        recovered: false,
      },
    });
    const report = analyzeQualityStudy(parseScalarCanaryManifest(fixture));
    expect(report.availability.overall).toMatchObject({
      completedCases: 2,
      checksRecorded: 2,
      legacyMissingChecks: 0,
      initiallyUnavailable: 1,
      refreshAttempted: 1,
      recovered: 1,
      finallyUnavailable: 0,
      initialDiscoveryStatuses: { error: 1, available: 1 },
    });
    expect(report.availability.byFactorAndArm["jev:a"]).toMatchObject({ recovered: 1, checksRecorded: 1 });
    expect(report.availability.byFactorAndArm["jev:b"]).toMatchObject({ recovered: 0, checksRecorded: 1 });
  });

  it("rejects malformed or contradictory case-level availability evidence", () => {
    const fixture = studyFixture();
    const valid = {
      initialDiscoveryStatus: "error",
      initialUnavailableReasons: ["runtime_unavailable"],
      refreshAttempted: true,
      finalDiscoveryStatus: "available",
      finalUnavailableReasons: [],
      recovered: true,
    };
    Object.assign(fixture.cases[0]!, { availabilityCheck: valid });
    expect(parseScalarCanaryManifest(fixture).cases[0]!.availabilityCheck).toMatchObject(valid);
    for (const invalid of [
      { ...valid, initialDiscoveryStatus: "mystery" },
      { ...valid, finalDiscoveryStatus: "mystery" },
      { ...valid, finalDiscoveryStatus: "error", recovered: false },
      { ...valid, initialUnavailableReasons: ["runtime_unavailable", "runtime_unavailable"] },
      { ...valid, finalUnavailableReasons: ["variant_removed", "model_removed"] },
      { ...valid, finalUnavailableReasons: ["model_removed"], recovered: false },
      { ...valid, initialUnavailableReasons: ["provider_removed"] },
      { ...valid, finalUnavailableReasons: ["secret-text"] },
      { ...valid, recovered: false },
      { ...valid, refreshAttempted: false },
      { ...valid, refreshAttempted: false, recovered: false },
      { ...valid, rawDiagnostic: "never accepted" },
    ]) {
      Object.assign(fixture.cases[0]!, { availabilityCheck: invalid });
      expect(() => parseScalarCanaryManifest(fixture)).toThrow();
    }
  });
  it("weights correlated trigger turns once per room pair and keeps missing human coverage", () => {
    const fixture = studyFixture();
    const report = analyzeQualityStudy(parseScalarCanaryManifest(fixture));
    const contrast = report.blockLevelV1.byFactor.jev!.contrasts[0]!;
    expect(contrast.paired.axes.social_cadence!.judgeArmBMinusA).toMatchObject({
      candidateBlocks: 1,
      pairedBlocks: 1,
      mean: -1,
      median: -1,
    });
    expect(contrast.paired.axes.social_cadence!.humanArmBMinusA).toMatchObject({
      candidateBlocks: 1,
      pairedBlocks: 0,
      missingBlocks: 1,
    });
    expect(report.blockLevelV1.byStratum).toHaveLength(1);
  });

  it("gives a one-trigger room pair the same weight as a two-trigger room pair", () => {
    const fixture = studyFixture();
    const second = structuredClone(fixture.cases);
    for (const row of second) {
      row.study.pairId = "pair2";
      row.study.blockId = "block2";
      row.study.caseId = `second-${row.study.caseId}`;
      row.scenarioId = `second-${row.scenarioId}`;
      row.triggers = row.triggers.slice(0, 1);
      row.qualityJudge = row.qualityJudge.slice(0, 1);
      const turn = row.triggers[0]!;
      turn.scenarioId = `second-${turn.scenarioId}`;
      turn.runId = `second-${turn.runId}`;
      const judgment = row.qualityJudge[0]!;
      judgment.scenarioId = turn.scenarioId;
      judgment.runId = turn.runId;
      for (const outcome of judgment.outcomes) {
        outcome.result.scenarioId = turn.scenarioId;
        outcome.result.runId = turn.runId;
        outcome.result.score = row.study.arm === "a" ? 1 : 5;
      }
    }
    const report = analyzeQualityStudy(parseScalarCanaryManifest({ ...fixture, cases: [...fixture.cases, ...second] }));
    expect(report.byFactor.jev!.paired.axes.social_cadence!.judgeArmBMinusA).toMatchObject({
      pairedRuns: 3,
      candidateMinusBaselineMean: 2 / 3,
    });
    expect(report.blockLevelV1.byFactor.jev!.contrasts[0]!.paired.axes.social_cadence!.judgeArmBMinusA).toMatchObject({
      pairedBlocks: 2,
      mean: 1.5,
      median: 1.5,
      minimum: -1,
      maximum: 4,
    });
  });

  it("counts required unanswered prompts separately from optional quiet prompts", () => {
    const fixture = studyFixture();
    const a = fixture.cases[0]!.triggers[0]!;
    const b = fixture.cases[1]!.triggers[0]!;
    a.confirmedDeliveredBursts = 0;
    b.requiredAddressAgents = [];
    b.confirmedDeliveredBursts = 0;
    fixture.cases[0]!.qualityJudge.shift();
    fixture.cases[1]!.qualityJudge.shift();
    const report = analyzeQualityStudy(parseScalarCanaryManifest(fixture));
    const objective = report.blockLevelV1.byFactor.jev!.contrasts[0]!.paired.objectiveArmBMinusA;
    expect(objective.requiredPromptsWithoutVisibleReply).toMatchObject({ pairedBlocks: 1, mean: -1 });
    expect(objective.optionalPromptsWithoutVisibleReply).toMatchObject({ pairedBlocks: 1, mean: 1 });
  });

  it("requires all final batches, disjoint pair IDs, and matching source and profile digests", () => {
    const fixture = studyFixture();
    const second = structuredClone(fixture.cases);
    for (const row of second) {
      row.scenarioId = `second-${row.scenarioId}`;
      row.study.pairId = "pair2";
      row.study.blockId = "block2";
      row.study.caseId = `second-${row.study.caseId}`;
      for (const turn of row.triggers) {
        turn.scenarioId = `second-${turn.scenarioId}`;
        turn.runId = `second-${turn.runId}`;
      }
      for (const judgment of row.qualityJudge) {
        judgment.scenarioId = `second-${judgment.scenarioId}`;
        judgment.runId = `second-${judgment.runId}`;
        for (const outcome of judgment.outcomes) {
          outcome.result.scenarioId = judgment.scenarioId;
          outcome.result.runId = judgment.runId;
        }
      }
    }
    const batch = (cases: typeof fixture.cases, batchIndex: number, pairId: string) =>
      parseScalarCanaryManifest({
        ...fixture,
        cases,
        studyBatch: {
          schemaVersion: 1,
          planCaseCount: 4,
          planPairCount: 2,
          batchIndex,
          batchCount: 2,
          pairsPerBatch: 1,
          pairCount: 1,
          pairIds: [pairId],
        },
      });
    const first = batch(fixture.cases, 0, "pair1");
    const next = batch(second, 1, "pair2");
    expect(() => analyzeQualityStudy(first)).toThrow(/complete set/);
    expect(analyzeQualityStudy(mergeScalarCanaryManifests([first, next])).denominators).toMatchObject({
      cases: 4,
      matchedCasePairs: 2,
    });
    expect(() => mergeScalarCanaryManifests([first])).toThrow();
    expect(() => mergeScalarCanaryManifests([first, first])).toThrow();
    expect(() => mergeScalarCanaryManifests([first, { ...next, sourceSha256: "b".repeat(64) }])).toThrow();
    const changed = structuredClone(next);
    changed.cases[0]!.study!.jevProfileDigest = "c".repeat(64);
    expect(() => mergeScalarCanaryManifests([first, changed])).toThrow();
    const directory = mkdtempSync(join(tmpdir(), "conversation-study-batches-"));
    try {
      const files = [join(directory, "batch-0.json"), join(directory, "batch-1.json")];
      for (const [index, cases] of [fixture.cases, second].entries()) {
        writeFileSync(
          files[index]!,
          JSON.stringify({
            ...fixture,
            cases,
            studyBatch: {
              schemaVersion: 1,
              planCaseCount: 4,
              planPairCount: 2,
              batchIndex: index,
              batchCount: 2,
              pairsPerBatch: 1,
              pairCount: 1,
              pairIds: [index ? "pair2" : "pair1"],
            },
          }),
        );
      }
      const output = execFileSync(
        "pnpm",
        [
          "exec",
          "tsx",
          "scripts/conversation-routing-live-analysis.ts",
          "--manifest",
          files[0]!,
          "--manifest",
          files[1]!,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output).denominators.cases).toBe(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("keeps four independent axis denominators and pairs only matching trigger ordinals", () => {
    const parsed = parseScalarCanaryManifest(studyFixture());
    const human = parsePrivateQualityRatings({
      schemaVersion: 2,
      ratings: [
        {
          scenarioId: "study-example-a",
          runId: "run-a",
          axes: { social_cadence: { status: "rated", score: 5 }, length_fit: { status: "not_assessable" } },
        },
        { scenarioId: "study-example-b", runId: "run-b", axes: { social_cadence: { status: "rated", score: 2 } } },
      ],
    });
    const report = analyzeQualityStudy(parsed, human, { seed: "fixed", maxSpotChecks: 3 });
    expect(report.denominators).toMatchObject({
      cases: 2,
      blocks: 1,
      triggers: 4,
      matchedCasePairs: 1,
      matchedTriggerPairs: 2,
    });
    expect(report.axes.social_cadence).toMatchObject({
      judge: { rated: 4, missing: 0, failed: 0 },
      human: { rated: 2, missing: 2 },
      agreement: { jointlyRated: 2, scoreExact: 1, scoreWithinOne: 2 },
    });
    expect(report.byFactor.jev!.paired.axes.social_cadence).toMatchObject({
      judgeArmBMinusA: { pairedRuns: 2, candidateMinusBaselineMean: -1 },
      humanArmBMinusA: { pairedRuns: 1, candidateMinusBaselineMean: -3 },
    });
    expect(report.resources.judgeReportedCostUsd).toMatchObject({ reportedRuns: 4, total: 0.016 });
    expect(report.spotChecks).toHaveLength(3);
    expect(privateRatingTemplate(parsed)).toMatchObject({ schemaVersion: 2 });
    expect(privateRatingTemplate(parsed).ratings).toHaveLength(4);
    expect(JSON.stringify(report)).not.toContain('"prompt":');
  });

  it("excludes mismatched factor profiles and resolved judge model drift", () => {
    const fixture = studyFixture();
    const broken = structuredClone(fixture);
    broken.cases[1]!.study.agentPromptProfileId = "social-v1";
    expect(analyzeQualityStudy(parseScalarCanaryManifest(broken)).denominators.matchedCasePairs).toBe(0);
    const drift = structuredClone(fixture);
    drift.cases[1]!.qualityJudge[0]!.outcomes[0]!.result.resolvedJudgeModel = "google/other-model";
    const report = analyzeQualityStudy(parseScalarCanaryManifest(drift));
    expect(report.byFactor.jev!.paired.axes.social_cadence!.judgeArmBMinusA.pairedRuns).toBe(1);
    expect(report.byFactor.jev!.paired.axes.social_cadence!.resolvedJudgeModelMismatchPairs).toBe(1);
    expect(report.blockLevelV1.byFactor.jev!.contrasts[0]!.paired.axes.social_cadence!.judgeArmBMinusA).toMatchObject({
      candidateBlocks: 1,
      pairedBlocks: 0,
      missingBlocks: 1,
    });
  });

  it("accepts a full uint32 study seed and rejects a changed prompt digest", () => {
    const fixture = studyFixture();
    fixture.studyPlan.orderSeed = 0xffffffff;
    expect(parseScalarCanaryManifest(fixture).studyPlan?.orderSeed).toBe(0xffffffff);
    fixture.cases[1]!.study.agentPromptProfileDigest = "c".repeat(64);
    expect(analyzeQualityStudy(parseScalarCanaryManifest(fixture)).denominators.matchedCasePairs).toBe(0);
  });

  it("merges separate study arms and preserves failed, missing, and unassessable axis coverage", () => {
    const fixture = studyFixture();
    fixture.cases[0]!.qualityJudge[0]!.outcomes[1] = {
      axis: "length_fit",
      status: "failed",
      category: "timeout",
    } as never;
    fixture.cases[1]!.qualityJudge = fixture.cases[1]!.qualityJudge.slice(0, 1);
    fixture.cases[1]!.qualityJudge[0]!.outcomes[2] = qualityOutcome("address_radius", "study-example-b", "run-b", null);
    const split = fixture.cases.map((row) => parseScalarCanaryManifest({ ...fixture, cases: [row] }));
    const report = analyzeQualityStudy(mergeScalarCanaryManifests(split));
    expect(report.denominators.matchedCasePairs).toBe(1);
    expect(report.axes.length_fit!.judge).toMatchObject({ failed: 1, missing: 1, rated: 2 });
    expect(report.axes.address_radius!.judge).toMatchObject({ notAssessable: 1, missing: 1, rated: 2 });
    expect(report.resources.judgeReportedCostUsd.missingRuns).toBe(2);
    expect(report.resources.judgeReportedAxisCostUsd).toMatchObject({
      totalAxes: 16,
      reportedAxes: 11,
      knownNoCallAxes: 0,
      unresolvedCostAxes: 5,
    });
    expect(report.resources.judgeReportedAxisCostUsd.reportedTotalUsd).toBeCloseTo(0.011);
  });

  it("keeps failed study Jev consultation as coverage but excludes its paired effect", () => {
    const fixture = studyFixture();
    fixture.cases[0]!.triggers[0]!.classifier = {
      outcome: "failed",
      reason: "timeout",
      durationMs: 100,
      reportedInputTokens: null,
      reportedOutputTokens: null,
      reportedCostUsd: null,
      resolvedModelId: null,
    } as never;
    const report = analyzeQualityStudy(parseScalarCanaryManifest(fixture));
    expect(report.denominators).toMatchObject({
      jevFailedTriggers: 1,
      excludedTriggerPairsJevIncomplete: 1,
      matchedTriggerPairs: 1,
    });
    expect(report.axes.social_cadence!.judge.rated).toBe(4);
    fixture.cases[0]!.triggers[0]!.classifier = {
      outcome: "not-consulted",
      reason: null,
      durationMs: null,
      reportedInputTokens: null,
      reportedOutputTokens: null,
      reportedCostUsd: null,
      resolvedModelId: null,
    } as never;
    const absent = analyzeQualityStudy(parseScalarCanaryManifest(fixture));
    expect(absent.denominators).toMatchObject({ jevNotConsultedTriggers: 1, excludedTriggerPairsJevIncomplete: 1 });
  });

  it("separates opposite quality changes by factor and block without a pooled effect", () => {
    const fixture = studyFixture();
    const promptCases = structuredClone(fixture.cases);
    for (const row of promptCases) {
      const arm = row.study.arm;
      row.study.blockId = "block2";
      row.study.pairId = "pair2";
      row.study.caseId = `prompt-${arm}`;
      row.study.factor = "agent-prompt";
      row.study.jevProfileId = "current-v1";
      row.study.jevProfileDigest = "a".repeat(64);
      row.study.agentPromptProfileId = arm === "a" ? "current-v1" : "social-v1";
      row.study.agentPromptProfileDigest = arm === "a" ? sha : "c".repeat(64);
      row.variant = "jev-on";
      row.scenarioId = `prompt-${row.scenarioId}`;
      for (const turn of row.triggers) {
        turn.scenarioId = `prompt-${turn.scenarioId}`;
        turn.runId = `prompt-${turn.runId}`;
        turn.variant = "jev-on";
        turn.classifier = { ...trigger("jev-on").classifier, resolvedModelId: "openrouter/example/jev" } as never;
      }
      for (const judgment of row.qualityJudge) {
        judgment.scenarioId = `prompt-${judgment.scenarioId}`;
        judgment.runId = `prompt-${judgment.runId}`;
        for (const outcome of judgment.outcomes) {
          outcome.result.scenarioId = judgment.scenarioId;
          outcome.result.runId = judgment.runId;
          if (judgment.runId.endsWith("-two")) continue;
          outcome.result.score = arm === "a" ? 1 : 5;
        }
      }
    }
    const report = analyzeQualityStudy(
      parseScalarCanaryManifest({ ...fixture, cases: [...fixture.cases, ...promptCases] }),
    );
    expect(report.byFactor.jev!.paired.axes.social_cadence!.judgeArmBMinusA).toEqual({
      pairedRuns: 2,
      candidateMinusBaselineMean: -1,
    });
    expect(report.byFactor["agent-prompt"]!.paired.axes.social_cadence!.judgeArmBMinusA).toEqual({
      pairedRuns: 2,
      candidateMinusBaselineMean: 2,
    });
    expect(report.blocks).toMatchObject([
      { pairId: "pair1", paired: { triggerPairs: 2 } },
      { pairId: "pair2", paired: { triggerPairs: 2 } },
    ]);
    expect(Object.hasOwn(report.axes.social_cadence!, "pairedJudge")).toBe(false);
    expect(Object.hasOwn(report.resources, "pairedArmBMinusA")).toBe(false);
    expect(report.byFactor.jev!.paired.resourcesArmBMinusA.actorEstimatedCostUsd.pairedRuns).toBe(2);
  });

  it("accepts rated optional silence only for length fit with no delivered reply", () => {
    const fixture = studyFixture();
    const quiet = fixture.cases[0]!.triggers[0]!;
    quiet.requiredAddressAgents = [];
    quiet.confirmedDeliveredBursts = 0;
    quiet.respondedTurns = 0;
    quiet.yieldedTurns = 1;
    const judgments = fixture.cases[0]!.qualityJudge[0]!.outcomes;
    for (const index of [0, 2, 3]) judgments[index] = qualityOutcome(axes[index]!, "study-example-a", "run-a", null);
    const result = fixture.cases[0]!.qualityJudge[0]!.outcomes[1]!.result;
    result.reasonCode = "silence_fit";
    result.score = 5;
    result.details = { direction: "appropriate" };
    expect(parseScalarCanaryManifest(fixture).cases[0]!.qualityJudge[0]!.outcomes[1]!.status).toBe("completed");
    quiet.requiredAddressAgents = ["codex-sol"];
    expect(() => parseScalarCanaryManifest(fixture)).toThrow();
    quiet.requiredAddressAgents = [];
    quiet.confirmedDeliveredBursts = 1;
    expect(() => parseScalarCanaryManifest(fixture)).toThrow();
    quiet.confirmedDeliveredBursts = 0;
    result.details = { direction: "too_long" };
    expect(() => parseScalarCanaryManifest(fixture)).toThrow();
    result.details = { direction: "appropriate" };
    result.reasonCode = "observable_exchange";
    fixture.cases[0]!.qualityJudge[0]!.outcomes[0]!.result.reasonCode = "silence_fit";
    expect(() => parseScalarCanaryManifest(fixture)).toThrow();
  });

  it("counts deterministic no-call axes separately from missing reported judge cost", () => {
    const fixture = studyFixture();
    const quiet = fixture.cases[0]!.triggers[0]!;
    quiet.requiredAddressAgents = [];
    quiet.confirmedDeliveredBursts = 0;
    quiet.respondedTurns = 0;
    const outcomes = fixture.cases[0]!.qualityJudge[0]!.outcomes;
    for (const index of [0, 2, 3]) {
      outcomes[index] = qualityOutcome(axes[index]!, "study-example-a", "run-a", null);
      outcomes[index]!.result.reasonCode = "no_visible_reply";
      outcomes[index]!.result.judgeUsage = { inputTokens: null, outputTokens: null, reportedCostUsd: null } as never;
    }
    outcomes[1]!.result.reasonCode = "silence_fit";
    outcomes[1]!.result.details = { direction: "appropriate" };
    fixture.cases[1]!.qualityJudge[0]!.outcomes[0]!.result.judgeUsage.reportedCostUsd = null as never;
    const report = analyzeQualityStudy(parseScalarCanaryManifest(fixture));
    expect(report.resources.judgeReportedAxisCostUsd).toMatchObject({
      totalAxes: 16,
      reportedAxes: 12,
      knownNoCallAxes: 3,
      unresolvedCostAxes: 1,
    });
    expect(report.resources.judgeReportedAxisCostUsd.reportedTotalUsd).toBeCloseTo(0.012);
    expect(report.resources.judgeReportedCostUsd).toMatchObject({ reportedRuns: 2, missingRuns: 2 });
    outcomes[0]!.result.judgeUsage.reportedCostUsd = 0.001;
    expect(() => parseScalarCanaryManifest(fixture)).toThrow();
  });
});
