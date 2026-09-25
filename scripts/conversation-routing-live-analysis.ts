import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  type ConversationRating,
  type ObservedConversationRun,
  parsePrivateConversationRatings,
  summarizeConversationRatings,
} from "./conversation-routing-live-annotations.js";
import { type JudgeScalarResult, selectHumanSpotChecks } from "./conversation-routing-live-judge.js";

const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{1,150}$/i;
const MAX_FILE_BYTES = 512_000;
const MAX_CASES = 36;
const MAX_TRIGGERS = 72;
const HUMAN_METRICS = ["directReply", "naturalness", "distinctValue", "replyWaste", "handoff", "closure"] as const;

type Variant = "jev-on" | "jev-off";
type Energy = "low" | "balanced" | "lively" | "party";
type PreflightMode = "off" | "shadow" | "enforce";
interface ScalarTrigger {
  scenarioId: string;
  runId: string;
  variant: Variant;
  actor: {
    provenance: "step-fields-v1" | "legacy-unverified";
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalTokens: number | null;
    totalTokenCoverage: "reported" | "partial" | "missing";
    costUsd: number | null;
    coverage: "reported" | "partial" | "missing";
  };
  jev: {
    outcome: "completed" | "failed" | "skipped" | "not-consulted";
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  };
  firstVisibleMs: number | null;
  combined: {
    openCodeObservedTotalPlusJevPromptCompletionTokens: number | null;
    costUsd: number | null;
    coverage: "reported" | "partial" | "missing";
  };
}
export interface ScalarCanaryManifest {
  sourceCommit: string;
  sourceDirty: boolean;
  sourceSha256: string;
  scenarioCatalogSha256s: string[];
  openCodeVersion: string;
  actorModel: string;
  judgeModel: string | null;
  cases: Array<{
    scenarioId: string;
    variant: Variant;
    agentCount: number;
    energy: Energy;
    preflightMode: PreflightMode;
    triggers: ScalarTrigger[];
    judge: JudgeScalarResult[];
  }>;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scalar canary manifest.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error("Invalid scalar canary manifest.");
  return row;
}
function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function number(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
function integer(value: unknown, max: number): number | null {
  const parsed = number(value, max);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}
function nullableNumber(value: unknown, max: number): number | null {
  if (value === null) return null;
  const parsed = number(value, max);
  if (parsed === null) throw new Error("Invalid scalar canary manifest.");
  return parsed;
}
function nullableInteger(value: unknown, max: number): number | null {
  if (value === null) return null;
  const parsed = integer(value, max);
  if (parsed === null) throw new Error("Invalid scalar canary manifest.");
  return parsed;
}
function optionalInteger(value: unknown, max: number): number | null {
  return value === undefined ? null : nullableInteger(value, max);
}
function variant(value: unknown): value is Variant {
  return value === "jev-on" || value === "jev-off";
}
function score(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return integer(value, 5) !== null && Number(value) >= 1;
}

function parseJudge(value: unknown, scenarioId: string, runId: string, judgeModel: string): JudgeScalarResult {
  const row = object(value, [
    "schemaVersion",
    "scenarioId",
    "runId",
    "judgeModel",
    "status",
    "directMisses",
    "responsiveness",
    "naturalness",
    "distinctValue",
    "unnecessaryReplies",
    "duplicateReplies",
    "handoffCorrect",
    "closureCorrect",
    "judgeUsage",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.scenarioId !== scenarioId ||
    row.runId !== runId ||
    row.judgeModel !== judgeModel ||
    (row.status !== "rated" && row.status !== "not_assessable") ||
    integer(row.directMisses, 32) === null ||
    integer(row.unnecessaryReplies, 32) === null ||
    integer(row.duplicateReplies, 32) === null ||
    (row.responsiveness !== null && !score(row.responsiveness)) ||
    (row.naturalness !== null && !score(row.naturalness)) ||
    (row.distinctValue !== null && !score(row.distinctValue)) ||
    (row.handoffCorrect !== null && typeof row.handoffCorrect !== "boolean") ||
    (row.closureCorrect !== null && typeof row.closureCorrect !== "boolean") ||
    (row.status === "rated" &&
      (row.responsiveness === null || row.naturalness === null || row.distinctValue === null)) ||
    (row.status === "not_assessable" &&
      (row.responsiveness !== null || row.naturalness !== null || row.distinctValue !== null))
  )
    throw new Error("Invalid scalar canary manifest.");
  const usage = object(row.judgeUsage, ["inputTokens", "outputTokens", "reportedCostUsd"]);
  const judgeUsage = {
    inputTokens: nullableInteger(usage.inputTokens, 1_000_000),
    outputTokens: nullableInteger(usage.outputTokens, 1_000_000),
    reportedCostUsd: nullableNumber(usage.reportedCostUsd, 1_000),
  };
  return {
    schemaVersion: 1,
    scenarioId,
    runId,
    judgeModel,
    status: row.status,
    directMisses: row.directMisses as number,
    responsiveness: row.responsiveness as JudgeScalarResult["responsiveness"],
    naturalness: row.naturalness as JudgeScalarResult["naturalness"],
    distinctValue: row.distinctValue as JudgeScalarResult["distinctValue"],
    unnecessaryReplies: row.unnecessaryReplies as number,
    duplicateReplies: row.duplicateReplies as number,
    handoffCorrect: row.handoffCorrect as boolean | null,
    closureCorrect: row.closureCorrect as boolean | null,
    judgeUsage,
  };
}

/** Copy only bounded scalar fields. Unknown keys, including prompt/output text, fail closed. */
export function parseScalarCanaryManifest(input: unknown): ScalarCanaryManifest {
  const top = object(input, [
    "schemaVersion",
    "kind",
    "sourceCommit",
    "sourceDirty",
    "sourceSha256",
    "scenarioCatalogSha256",
    "openCodeVersion",
    "actorModel",
    "judgeModel",
    "concurrency",
    "maxCases",
    "maxGenerationsPerCase",
    "scenarioTimeoutMs",
    "totalTimeoutMs",
    "cases",
  ]);
  if (
    top.schemaVersion !== 1 ||
    top.kind !== "conversation-routing-live-canary" ||
    typeof top.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(top.sourceCommit) ||
    typeof top.sourceDirty !== "boolean" ||
    typeof top.sourceSha256 !== "string" ||
    !SHA.test(top.sourceSha256) ||
    typeof top.scenarioCatalogSha256 !== "string" ||
    !SHA.test(top.scenarioCatalogSha256) ||
    typeof top.openCodeVersion !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][a-zA-Z0-9.-]+)?$/.test(top.openCodeVersion) ||
    typeof top.actorModel !== "string" ||
    !MODEL.test(top.actorModel) ||
    (top.judgeModel !== null && (typeof top.judgeModel !== "string" || !MODEL.test(top.judgeModel))) ||
    top.concurrency !== 1 ||
    integer(top.maxCases, MAX_CASES) === null ||
    top.maxCases === 0 ||
    integer(top.maxGenerationsPerCase, 100) === null ||
    top.maxGenerationsPerCase === 0 ||
    integer(top.scenarioTimeoutMs, 3_600_000) === null ||
    top.scenarioTimeoutMs === 0 ||
    integer(top.totalTimeoutMs, 86_400_000) === null ||
    top.totalTimeoutMs === 0 ||
    !Array.isArray(top.cases) ||
    top.cases.length === 0 ||
    top.cases.length > (top.maxCases as number) ||
    top.cases.length > MAX_CASES
  )
    throw new Error("Invalid scalar canary manifest.");
  const cases = top.cases.map((entry: unknown) => {
    const row = object(entry, [
      "schemaVersion",
      "scenarioId",
      "variant",
      "agentCount",
      "energy",
      "preflightMode",
      "triggers",
      "judge",
      "privateReviewRetained",
    ]);
    if (
      row.schemaVersion !== 1 ||
      !id(row.scenarioId) ||
      !variant(row.variant) ||
      integer(row.agentCount, 4) === null ||
      row.agentCount === 0 ||
      !["low", "balanced", "lively", "party"].includes(String(row.energy)) ||
      !["off", "shadow", "enforce"].includes(String(row.preflightMode)) ||
      typeof row.privateReviewRetained !== "boolean" ||
      !Array.isArray(row.triggers) ||
      row.triggers.length === 0 ||
      row.triggers.length > 2 ||
      !Array.isArray(row.judge) ||
      row.judge.length > 2
    )
      throw new Error("Invalid scalar canary manifest.");
    const triggers = row.triggers.map((entry: unknown): ScalarTrigger => {
      const trigger = object(entry, [
        "schemaVersion",
        "scenarioId",
        "variant",
        "runId",
        "preflightMode",
        "requiredAddressAgents",
        "routing",
        "classifier",
        "queueDelayMs",
        "firstVisibleMs",
        "terminalReason",
        "attemptedTurns",
        "respondedTurns",
        "yieldedTurns",
        "confirmedDeliveredBursts",
        "generationStarts",
        "generationCompletions",
        "generationFailures",
        "reportedInputTokens",
        "reportedOutputTokens",
        "reportedReasoningTokens",
        "reportedCacheReadTokens",
        "reportedCacheWriteTokens",
        "reportedTotalTokens",
        "totalTokenCoverage",
        "reportedCostUsd",
        "usageCoverage",
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
      ]);
      const current = trigger.openCodeUsageProvenance === "step-fields-v1";
      if (
        trigger.schemaVersion !== 1 ||
        !id(trigger.scenarioId) ||
        trigger.variant !== row.variant ||
        trigger.preflightMode !== row.preflightMode ||
        !id(trigger.runId) ||
        (trigger.openCodeUsageProvenance !== undefined && !current) ||
        !["reported", "partial", "missing"].includes(
          String(current ? trigger.openCodeUsageCoverage : trigger.usageCoverage),
        ) ||
        !Array.isArray(trigger.requiredAddressAgents) ||
        trigger.requiredAddressAgents.some((agent) => !id(agent)) ||
        !Array.isArray(trigger.routing) ||
        trigger.routing.length > 32 ||
        !/^[a-z][a-z-]{1,79}$/.test(String(trigger.terminalReason))
      )
        throw new Error("Invalid scalar canary manifest.");
      for (const entry of trigger.routing) {
        const routed = object(entry, ["agentId", "outcome", "reason"]);
        if (
          !id(routed.agentId) ||
          !["invoke", "suppress", "unavailable"].includes(String(routed.outcome)) ||
          !/^[a-z][a-z_]{1,79}$/.test(String(routed.reason))
        )
          throw new Error("Invalid scalar canary manifest.");
      }
      const classifier = object(trigger.classifier, [
        "outcome",
        "reason",
        "durationMs",
        "reportedInputTokens",
        "reportedOutputTokens",
        "reportedCostUsd",
      ]);
      if (
        !["completed", "failed", "skipped", "not-consulted"].includes(String(classifier.outcome)) ||
        (classifier.reason !== null && !/^[a-z][a-z_-]{1,79}$/.test(String(classifier.reason)))
      )
        throw new Error("Invalid scalar canary manifest.");
      const actor = {
        provenance: current ? ("step-fields-v1" as const) : ("legacy-unverified" as const),
        inputTokens: current
          ? nullableInteger(trigger.openCodeObservedInputTokens, 1_000_000_000)
          : nullableInteger(trigger.reportedInputTokens, 1_000_000_000),
        outputTokens: current
          ? nullableInteger(trigger.openCodeObservedOutputTokens, 1_000_000_000)
          : nullableInteger(trigger.reportedOutputTokens, 1_000_000_000),
        reasoningTokens: current
          ? nullableInteger(trigger.openCodeObservedReasoningTokens, 1_000_000_000)
          : optionalInteger(trigger.reportedReasoningTokens, 1_000_000_000),
        cacheReadTokens: current
          ? nullableInteger(trigger.openCodeObservedCacheReadTokens, 1_000_000_000)
          : optionalInteger(trigger.reportedCacheReadTokens, 1_000_000_000),
        cacheWriteTokens: current
          ? nullableInteger(trigger.openCodeObservedCacheWriteTokens, 1_000_000_000)
          : optionalInteger(trigger.reportedCacheWriteTokens, 1_000_000_000),
        totalTokens: current
          ? nullableInteger(trigger.openCodeObservedTotalTokens, 1_000_000_000)
          : optionalInteger(trigger.reportedTotalTokens, 1_000_000_000),
        totalTokenCoverage:
          (current ? trigger.openCodeTotalCoverage : trigger.totalTokenCoverage) === undefined
            ? ("missing" as const)
            : ((current
                ? trigger.openCodeTotalCoverage
                : trigger.totalTokenCoverage) as ScalarTrigger["actor"]["totalTokenCoverage"]),
        costUsd: current
          ? nullableNumber(trigger.openCodeEstimatedCostUsd, 1_000)
          : nullableNumber(trigger.reportedCostUsd, 1_000),
        coverage: (current
          ? trigger.openCodeUsageCoverage
          : trigger.usageCoverage) as ScalarTrigger["actor"]["coverage"],
      };
      if (
        !["reported", "partial", "missing"].includes(actor.totalTokenCoverage) ||
        (actor.totalTokenCoverage === "reported" && actor.totalTokens === null) ||
        (actor.totalTokenCoverage !== "reported" && actor.totalTokens !== null)
      )
        throw new Error("Invalid scalar canary manifest.");
      const jev = {
        outcome: classifier.outcome as ScalarTrigger["jev"]["outcome"],
        inputTokens: nullableInteger(classifier.reportedInputTokens, 1_000_000),
        outputTokens: nullableInteger(classifier.reportedOutputTokens, 1_000_000),
        costUsd: nullableNumber(classifier.reportedCostUsd, 1_000),
      };
      if (
        (row.variant === "jev-on" && jev.outcome !== "completed") ||
        (row.variant === "jev-off" &&
          (jev.outcome === "completed" ||
            jev.inputTokens !== null ||
            jev.outputTokens !== null ||
            jev.costUsd !== null))
      )
        throw new Error("Invalid scalar canary manifest.");
      const noJev = row.variant === "jev-off";
      const jevComplete =
        noJev ||
        (jev.outcome === "completed" && jev.inputTokens !== null && jev.outputTokens !== null && jev.costUsd !== null);
      const complete =
        actor.provenance === "step-fields-v1" &&
        actor.coverage === "reported" &&
        actor.inputTokens !== null &&
        actor.outputTokens !== null &&
        actor.costUsd !== null &&
        jevComplete;
      const totalTokensComplete =
        actor.provenance === "step-fields-v1" &&
        actor.totalTokenCoverage === "reported" &&
        actor.totalTokens !== null &&
        (noJev || (jev.inputTokens !== null && jev.outputTokens !== null));
      const anyReported =
        actor.inputTokens !== null ||
        actor.outputTokens !== null ||
        actor.costUsd !== null ||
        jev.inputTokens !== null ||
        jev.outputTokens !== null ||
        jev.costUsd !== null;
      return {
        scenarioId: trigger.scenarioId,
        runId: trigger.runId,
        variant: row.variant as Variant,
        actor,
        jev,
        firstVisibleMs: nullableInteger(trigger.firstVisibleMs, 3_600_000),
        combined: {
          openCodeObservedTotalPlusJevPromptCompletionTokens: totalTokensComplete
            ? actor.totalTokens! + (noJev ? 0 : jev.inputTokens! + jev.outputTokens!)
            : null,
          costUsd: complete ? actor.costUsd! + (noJev ? 0 : jev.costUsd!) : null,
          coverage: complete ? "reported" : anyReported ? "partial" : "missing",
        },
      };
    });
    const judge = row.judge.map((entry: unknown) => {
      const value = entry as Record<string, unknown>;
      const runId = value?.runId;
      const scenarioId = value?.scenarioId;
      if (
        !id(scenarioId) ||
        !id(runId) ||
        !top.judgeModel ||
        !triggers.some((trigger) => trigger.scenarioId === scenarioId && trigger.runId === runId)
      )
        throw new Error("Invalid scalar canary manifest.");
      return parseJudge(entry, scenarioId, runId, (top.judgeModel as string).slice("openrouter/".length));
    });
    if (new Set(judge.map((entry) => `${entry.scenarioId}\u0000${entry.runId}`)).size !== judge.length)
      throw new Error("Invalid scalar canary manifest.");
    return {
      scenarioId: row.scenarioId as string,
      variant: row.variant as Variant,
      agentCount: row.agentCount as number,
      energy: row.energy as Energy,
      preflightMode: row.preflightMode as PreflightMode,
      triggers,
      judge,
    };
  });
  if (new Set(cases.map((row) => `${row.scenarioId}\u0000${row.variant}`)).size !== cases.length)
    throw new Error("Invalid scalar canary manifest.");
  const allRuns = cases.flatMap((row) => row.triggers);
  if (
    allRuns.length > MAX_TRIGGERS ||
    new Set(allRuns.map((row) => `${row.scenarioId}\u0000${row.runId}`)).size !== allRuns.length
  )
    throw new Error("Invalid scalar canary manifest.");
  return {
    sourceCommit: top.sourceCommit,
    sourceDirty: top.sourceDirty,
    sourceSha256: top.sourceSha256,
    scenarioCatalogSha256s: [top.scenarioCatalogSha256],
    openCodeVersion: top.openCodeVersion,
    actorModel: top.actorModel,
    judgeModel: top.judgeModel,
    cases,
  };
}

/** Merge independent completed canary invocations without equating different source builds. */
export function mergeScalarCanaryManifests(manifests: readonly ScalarCanaryManifest[]): ScalarCanaryManifest {
  if (!manifests.length || manifests.length > MAX_CASES) throw new Error("Invalid scalar canary manifest set.");
  const first = manifests[0]!;
  const cases = manifests.flatMap((manifest) => manifest.cases);
  const settings = new Map<string, string>();
  for (const row of cases) {
    const value = JSON.stringify([row.agentCount, row.energy, row.preflightMode]);
    const prior = settings.get(row.scenarioId);
    if (prior !== undefined && prior !== value) throw new Error("Incompatible scalar canary settings.");
    settings.set(row.scenarioId, value);
  }
  if (
    cases.length > MAX_CASES ||
    cases.flatMap((row) => row.triggers).length > MAX_TRIGGERS ||
    manifests.some(
      (manifest) =>
        manifest.sourceCommit !== first.sourceCommit ||
        manifest.sourceDirty !== first.sourceDirty ||
        manifest.sourceSha256 !== first.sourceSha256 ||
        manifest.openCodeVersion !== first.openCodeVersion ||
        manifest.actorModel !== first.actorModel,
    ) ||
    new Set(manifests.map((manifest) => manifest.judgeModel).filter((value) => value !== null)).size > 1 ||
    new Set(cases.map((row) => `${row.scenarioId}\u0000${row.variant}`)).size !== cases.length ||
    new Set(cases.flatMap((row) => row.triggers.map((trigger) => trigger.runId))).size !==
      cases.flatMap((row) => row.triggers).length
  )
    throw new Error("Incompatible or duplicate scalar canary manifests.");
  const judgeModel = manifests.find((manifest) => manifest.judgeModel !== null)?.judgeModel ?? null;
  return {
    ...first,
    scenarioCatalogSha256s: [...new Set(manifests.flatMap((manifest) => manifest.scenarioCatalogSha256s))].sort(),
    judgeModel,
    cases,
  };
}

function mean(values: readonly number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function delta(values: readonly number[]) {
  return { pairedRuns: values.length, candidateMinusBaselineMean: mean(values) };
}
function aggregate(values: readonly (number | null)[]) {
  const reported = values.filter((value): value is number => value !== null);
  return {
    reportedRuns: reported.length,
    missingRuns: values.length - reported.length,
    total: reported.length ? reported.reduce((sum, value) => sum + value, 0) : null,
  };
}
function diagnosticAggregate(values: readonly (number | null)[]) {
  const present = values.filter((value): value is number => value !== null);
  return {
    observedRuns: present.length,
    missingRuns: values.length - present.length,
    unverifiedTotal: present.length ? present.reduce((sum, value) => sum + value, 0) : null,
  };
}

/** Deterministic scalar analysis; model judgments and human annotations remain separate. */
export function analyzeConversationCanary(
  manifest: ScalarCanaryManifest,
  ratings: readonly ConversationRating[] = [],
  options: { seed?: string; maxSpotChecks?: number } = {},
) {
  const triggers = manifest.cases.flatMap((row) => row.triggers);
  const judgments = manifest.cases.flatMap((row) => row.judge);
  const runKeys = new Set(triggers.map((row) => `${row.scenarioId}\u0000${row.runId}`));
  if (ratings.some((row) => !runKeys.has(`${row.scenarioId}\u0000${row.runId}`)))
    throw new Error("Private rating does not match a completed canary run.");
  const byVariant = (variant: Variant) => triggers.filter((row) => row.variant === variant);
  const variants = Object.fromEntries(
    (["jev-on", "jev-off"] as const).map((variant) => {
      const rows = byVariant(variant);
      const judged = judgments.filter((judge) =>
        rows.some((row) => row.scenarioId === judge.scenarioId && row.runId === judge.runId),
      );
      const rated = judged.filter((judge) => judge.status === "rated");
      const verified = (row: ScalarTrigger) => row.actor.provenance === "step-fields-v1";
      const legacy = rows.filter((row) => !verified(row));
      return [
        variant,
        {
          runs: rows.length,
          legacyUnverifiedRuns: legacy.length,
          legacyDiagnosticActorCostUsd: diagnosticAggregate(legacy.map((row) => row.actor.costUsd)),
          jevCompleted: rows.filter((row) => row.jev.outcome === "completed").length,
          actorEstimatedCostUsd: aggregate(
            rows.map((row) => (verified(row) && row.actor.coverage === "reported" ? row.actor.costUsd : null)),
          ),
          openCodeObservedUncachedInputTokens: aggregate(
            rows.map((row) => (verified(row) && row.actor.coverage === "reported" ? row.actor.inputTokens : null)),
          ),
          openCodeObservedOutputTokens: aggregate(
            rows.map((row) => (verified(row) && row.actor.coverage === "reported" ? row.actor.outputTokens : null)),
          ),
          openCodeObservedReasoningTokens: aggregate(
            rows.map((row) => (verified(row) ? row.actor.reasoningTokens : null)),
          ),
          openCodeObservedCacheReadTokens: aggregate(
            rows.map((row) => (verified(row) ? row.actor.cacheReadTokens : null)),
          ),
          openCodeObservedCacheWriteTokens: aggregate(
            rows.map((row) => (verified(row) ? row.actor.cacheWriteTokens : null)),
          ),
          openCodeObservedTotalTokens: aggregate(rows.map((row) => (verified(row) ? row.actor.totalTokens : null))),
          openCodeObservedTotalPlusJevPromptCompletionTokens: aggregate(
            rows.map((row) => row.combined.openCodeObservedTotalPlusJevPromptCompletionTokens),
          ),
          jevReportedCostUsd: aggregate(
            rows.map((row) =>
              row.variant === "jev-off" ? 0 : row.jev.outcome === "completed" ? row.jev.costUsd : null,
            ),
          ),
          jevInputTokens: aggregate(
            rows.map((row) =>
              row.variant === "jev-off" ? 0 : row.jev.outcome === "completed" ? row.jev.inputTokens : null,
            ),
          ),
          jevOutputTokens: aggregate(
            rows.map((row) =>
              row.variant === "jev-off" ? 0 : row.jev.outcome === "completed" ? row.jev.outputTokens : null,
            ),
          ),
          actorEstimatedPlusJevReportedCostUsd: aggregate(rows.map((row) => row.combined.costUsd)),
          judgeNaturalness: {
            ratedRuns: rated.length,
            unassessableRuns: judged.length - rated.length,
            missingRuns: rows.length - judged.length,
            meanScore: mean(rated.map((row) => row.naturalness!)),
          },
          judgeReportedCostUsd: aggregate(judged.map((row) => row.judgeUsage.reportedCostUsd)),
        },
      ];
    }),
  );
  const pairs: Array<{ scenarioId: string; baselineRunId: string; candidateRunId: string }> = [];
  const on = byVariant("jev-on"),
    off = byVariant("jev-off");
  for (const candidate of on) {
    const baseline = off.find((row) => row.scenarioId === candidate.scenarioId);
    if (baseline)
      pairs.push({ scenarioId: candidate.scenarioId, baselineRunId: baseline.runId, candidateRunId: candidate.runId });
  }
  const observations: ObservedConversationRun[] = triggers.map((row) => ({
    scenarioId: row.scenarioId,
    runId: row.runId,
    reportedCostUsd: row.combined.costUsd,
    usageCoverage: row.combined.coverage,
    firstVisibleMs: row.firstVisibleMs,
  }));
  const human = ratings.length ? summarizeConversationRatings(ratings, observations, pairs) : null;
  const unsubmittedHumanRuns = triggers.length - ratings.length;
  const humanReviewCoverage = {
    submittedRuns: ratings.length,
    unsubmittedRuns: unsubmittedHumanRuns,
    metrics: Object.fromEntries(
      HUMAN_METRICS.map((metric) => {
        const counts = human?.coverage[metric];
        return [
          metric,
          {
            ratedRuns: counts?.ratedRuns ?? 0,
            notApplicableRuns: counts?.notApplicableRuns ?? 0,
            notAssessableRuns: counts?.notAssessableRuns ?? 0,
            missingRuns: (counts?.missingRuns ?? 0) + unsubmittedHumanRuns,
          },
        ];
      }),
    ),
  };
  const judges = new Map(judgments.map((row) => [`${row.scenarioId}\u0000${row.runId}`, row]));
  const humanRatings = new Map(ratings.map((row) => [`${row.scenarioId}\u0000${row.runId}`, row]));
  const actorJevObservedTotal: number[] = [],
    judgeNaturalness: number[] = [];
  const jointJudgeNaturalness: number[] = [],
    jointActorJevCost: number[] = [];
  const jointJudgeNaturalnessTokens: number[] = [],
    jointActorJevTokensForJudge: number[] = [];
  const jointHumanNaturalness: number[] = [],
    jointHumanActorJevCost: number[] = [];
  const jointHumanNaturalnessTokens: number[] = [],
    jointActorJevTokensForHuman: number[] = [];
  for (const pair of pairs) {
    const a = triggers.find((row) => row.scenarioId === pair.scenarioId && row.runId === pair.baselineRunId)!;
    const b = triggers.find((row) => row.scenarioId === pair.scenarioId && row.runId === pair.candidateRunId)!;
    if (
      a.combined.openCodeObservedTotalPlusJevPromptCompletionTokens !== null &&
      b.combined.openCodeObservedTotalPlusJevPromptCompletionTokens !== null
    )
      actorJevObservedTotal.push(
        b.combined.openCodeObservedTotalPlusJevPromptCompletionTokens -
          a.combined.openCodeObservedTotalPlusJevPromptCompletionTokens,
      );
    const jA = judges.get(`${pair.scenarioId}\u0000${pair.baselineRunId}`);
    const jB = judges.get(`${pair.scenarioId}\u0000${pair.candidateRunId}`);
    if (jA?.status === "rated" && jB?.status === "rated") {
      const naturalnessDelta = jB.naturalness! - jA.naturalness!;
      judgeNaturalness.push(naturalnessDelta);
      if (a.combined.costUsd !== null && b.combined.costUsd !== null) {
        jointJudgeNaturalness.push(naturalnessDelta);
        jointActorJevCost.push(b.combined.costUsd - a.combined.costUsd);
      }
      if (
        a.combined.openCodeObservedTotalPlusJevPromptCompletionTokens !== null &&
        b.combined.openCodeObservedTotalPlusJevPromptCompletionTokens !== null
      ) {
        jointJudgeNaturalnessTokens.push(naturalnessDelta);
        jointActorJevTokensForJudge.push(
          b.combined.openCodeObservedTotalPlusJevPromptCompletionTokens -
            a.combined.openCodeObservedTotalPlusJevPromptCompletionTokens,
        );
      }
    }
    const hA = humanRatings.get(`${pair.scenarioId}\u0000${pair.baselineRunId}`)?.naturalness;
    const hB = humanRatings.get(`${pair.scenarioId}\u0000${pair.candidateRunId}`)?.naturalness;
    if (hA?.status === "rated" && hB?.status === "rated") {
      const naturalnessDelta = hB.score - hA.score;
      if (a.combined.costUsd !== null && b.combined.costUsd !== null) {
        jointHumanNaturalness.push(naturalnessDelta);
        jointHumanActorJevCost.push(b.combined.costUsd - a.combined.costUsd);
      }
      if (
        a.combined.openCodeObservedTotalPlusJevPromptCompletionTokens !== null &&
        b.combined.openCodeObservedTotalPlusJevPromptCompletionTokens !== null
      ) {
        jointHumanNaturalnessTokens.push(naturalnessDelta);
        jointActorJevTokensForHuman.push(
          b.combined.openCodeObservedTotalPlusJevPromptCompletionTokens -
            a.combined.openCodeObservedTotalPlusJevPromptCompletionTokens,
        );
      }
    }
  }
  const costAndLatency = summarizeConversationRatings([], observations, pairs).paired;
  const humanPaired = human
    ? {
        requestedPairs: human.paired.requestedPairs,
        naturalness: human.paired.naturalness,
        actorEstimatedPlusJevReportedCostUsd: human.paired.reportedCostUsd,
        firstVisibleMs: human.paired.firstVisibleMs,
        naturalnessAndMixedCostPairs: human.paired.naturalnessAndReportedCostPairs,
      }
    : null;
  const humanNaturalness = ratings.flatMap((row) =>
    row.naturalness?.status === "rated"
      ? [{ scenarioId: row.scenarioId, runId: row.runId, score: row.naturalness.score }]
      : [],
  );
  const spotChecks = selectHumanSpotChecks(judgments, humanNaturalness, {
    seed: options.seed ?? "pilot-1",
    maxCases: options.maxSpotChecks ?? 4,
  });
  return {
    schemaVersion: 1 as const,
    kind: "conversation-routing-live-analysis" as const,
    source: {
      commit: manifest.sourceCommit,
      dirty: manifest.sourceDirty,
      digest: manifest.sourceSha256,
      openCodeVersion: manifest.openCodeVersion,
      scenarioCatalogDigests: manifest.scenarioCatalogSha256s,
    },
    runs: triggers.length,
    matchedPairs: pairs.length,
    variants,
    judgeOnly: {
      judgedRuns: judgments.length,
      missingRuns: triggers.length - judgments.length,
      pairedNaturalness: delta(judgeNaturalness),
      naturalnessAndMixedCost: {
        pairedRuns: jointJudgeNaturalness.length,
        naturalness: delta(jointJudgeNaturalness),
        actorEstimatedPlusJevReportedCostUsd: delta(jointActorJevCost),
      },
      naturalnessAndObservedTokens: {
        pairedRuns: jointJudgeNaturalnessTokens.length,
        naturalness: delta(jointJudgeNaturalnessTokens),
        openCodeObservedTotalPlusJevPromptCompletionTokens: delta(jointActorJevTokensForJudge),
      },
    },
    humanRated: human
      ? {
          ...human,
          paired: humanPaired!,
          limitation:
            "Human ratings cover only reviewed output. Actor cost is OpenCode-estimated, Jev cost is provider-reported, and older actor usage lacks field provenance.",
          naturalnessAndMixedCost: {
            pairedRuns: jointHumanNaturalness.length,
            naturalness: delta(jointHumanNaturalness),
            actorEstimatedPlusJevReportedCostUsd: delta(jointHumanActorJevCost),
          },
          naturalnessAndObservedTokens: {
            pairedRuns: jointHumanNaturalnessTokens.length,
            naturalness: delta(jointHumanNaturalnessTokens),
            openCodeObservedTotalPlusJevPromptCompletionTokens: delta(jointActorJevTokensForHuman),
          },
        }
      : null,
    humanReviewCoverage,
    pairedActorAndJev: {
      actorEstimatedPlusJevReportedCostUsd: costAndLatency.reportedCostUsd,
      openCodeObservedTotalPlusJevPromptCompletionTokens: delta(actorJevObservedTotal),
      firstVisibleMs: costAndLatency.firstVisibleMs,
    },
    spotChecks,
    limitations:
      "Judge scores are model judgments; human ratings have separate denominators. Actor cost is an OpenCode estimate, while Jev and judge costs are provider-reported. Mixed cost comparisons require explicit OpenCode step-field provenance and complete Jev cost on both matched runs. Token comparisons use OpenCode-observed totals plus Jev prompt/completion counts; their sum is derived. Older actor usage is legacy-unverified diagnostic data only. Uninvoked replies and missing usage are unknown; small matched cases do not prove causality.",
  };
}

export function privateRatingTemplate(manifest: ScalarCanaryManifest) {
  return {
    schemaVersion: 1 as const,
    ratings: manifest.cases.flatMap((row) => row.triggers.map(({ scenarioId, runId }) => ({ scenarioId, runId }))),
  };
}

async function readBounded(path: string) {
  if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error("Input file exceeds the private analysis limit.");
  const bytes = await readFile(path);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Input file exceeds the private analysis limit.");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const manifestPaths: string[] = [];
  let template = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--template") {
      if (template) throw new Error("Invalid analysis invocation.");
      template = true;
      continue;
    }
    if (!["--manifest", "--ratings", "--seed", "--spot-checks"].includes(arg) || !args[i + 1])
      throw new Error("Invalid analysis invocation.");
    if (arg === "--manifest") {
      if (manifestPaths.length >= MAX_CASES) throw new Error("Invalid analysis invocation.");
      manifestPaths.push(args[++i]!);
      continue;
    }
    if (values.has(arg)) throw new Error("Invalid analysis invocation.");
    values.set(arg, args[++i]!);
  }
  if (!manifestPaths.length || (template && values.has("--ratings"))) throw new Error("Invalid analysis invocation.");
  const manifests: ScalarCanaryManifest[] = [];
  for (const path of manifestPaths) manifests.push(parseScalarCanaryManifest(await readBounded(path)));
  const manifest = mergeScalarCanaryManifests(manifests);
  const ratings = values.has("--ratings")
    ? parsePrivateConversationRatings(await readBounded(values.get("--ratings")!))
    : [];
  const maxSpotChecks = values.has("--spot-checks") ? Number(values.get("--spot-checks")) : 4;
  if (!Number.isSafeInteger(maxSpotChecks) || maxSpotChecks < 0 || maxSpotChecks > 12)
    throw new Error("Invalid analysis invocation.");
  process.stdout.write(
    `${JSON.stringify(template ? privateRatingTemplate(manifest) : analyzeConversationCanary(manifest, ratings, { ...(values.has("--seed") ? { seed: values.get("--seed")! } : {}), maxSpotChecks }), null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Invalid or unavailable scalar canary analysis input.\n");
    process.exitCode = 1;
  });
}
