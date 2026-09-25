import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  type ConversationRating,
  type ObservedConversationRun,
  parsePrivateConversationRatings,
  parsePrivateQualityRatings,
  type QualityHumanRating,
  summarizeConversationRatings,
} from "./conversation-routing-live-annotations.js";
import { type JudgeScalarResult, selectHumanSpotChecks } from "./conversation-routing-live-judge.js";
import { QUALITY_AXES, type QualityAxis, type QualityAxisOutcome } from "./conversation-routing-live-judge-v2.js";
import type { StudyCaseMetadataV1 } from "./conversation-routing-live-study.js";

const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{1,150}$/i;
const RESOLVED_MODEL = /^(?=.{3,160}$)~?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/;
const MAX_FILE_BYTES = 512_000;
const MAX_CASES = 36;
const MAX_TRIGGERS = 108;
const MAX_STUDY_PAIRS = 72;
const MAX_MERGED_CASES = MAX_STUDY_PAIRS * 2;
const MAX_MERGED_TRIGGERS = MAX_MERGED_CASES * 3;
const DISCOVERY_STATUSES = [
  "available",
  "cli_missing",
  "authentication_required",
  "configuration_required",
  "discovery_unsupported",
  "runtime_incompatible",
  "error",
] as const;
const AVAILABILITY_REASONS = [
  "runtime_unavailable",
  "model_removed",
  "provider_removed",
  "variant_removed",
  "reasoning_effort_removed",
  "variant_conflict",
  "selection_unpinnable",
] as const;
type AvailabilityCheck = {
  initialDiscoveryStatus: (typeof DISCOVERY_STATUSES)[number];
  initialUnavailableReasons: (typeof AVAILABILITY_REASONS)[number][];
  refreshAttempted: boolean;
  finalDiscoveryStatus: (typeof DISCOVERY_STATUSES)[number];
  finalUnavailableReasons: (typeof AVAILABILITY_REASONS)[number][];
  recovered: boolean;
};
const JUDGE_FAILURES = [
  "timeout",
  "cancelled",
  "transport",
  "http-auth",
  "http-rate-limit",
  "http-client",
  "http-server",
  "http-other",
  "response-too-large",
  "response-envelope-json",
  "response-content-json",
  "response-shape",
  "completion-truncated",
  "judgment-schema",
] as const;
const HUMAN_METRICS = ["directReply", "naturalness", "distinctValue", "replyWaste", "handoff", "closure"] as const;

type Variant = "jev-on" | "jev-off";
type Energy = "low" | "balanced" | "lively" | "party";
type PreflightMode = "off" | "shadow" | "enforce";
const ATTRIBUTION_CATEGORIES = [
  "visible-delivered",
  "gate-suppressed",
  "routing-unavailable",
  "generation-failed",
  "completed-yielded",
  "completed-no-delivery",
  "mixed-or-unresolved",
] as const;
const GENERATION_CATEGORIES = [
  "delivered",
  "yielded",
  "undelivered",
  "completed-no-delivery-evidence",
  "failed",
  "cancelled",
  "incomplete",
] as const;
type NoVisibleAttribution = {
  schemaVersion: 1;
  category: (typeof ATTRIBUTION_CATEGORIES)[number];
  generations: Array<{ ordinal: number; category: (typeof GENERATION_CATEGORIES)[number] }>;
};
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
  resolvedJevModelId: string | null;
  attemptedTurns: number;
  respondedTurns: number;
  yieldedTurns: number;
  confirmedDeliveredBursts: number;
  requiredTargetCount: number;
  noVisibleAttributionV1: NoVisibleAttribution | null;
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
  judgeRubric: "v1" | "v2";
  studyPlan: { schemaVersion: 1; planId: string; planSha256: string; orderSeed: number; jevModel: string } | null;
  studyBatch: {
    schemaVersion: 1;
    planCaseCount: number;
    planPairCount: number;
    batchIndex: number;
    batchCount: number;
    pairsPerBatch: number;
    pairCount: number;
    pairIds: string[];
  } | null;
  runLimits: { maxGenerationsPerCase: number; scenarioTimeoutMs: number };
  cases: Array<{
    scenarioId: string;
    variant: Variant;
    agentCount: number;
    energy: Energy;
    preflightMode: PreflightMode;
    triggers: ScalarTrigger[];
    judge: JudgeScalarResult[];
    qualityJudge: Array<{ scenarioId: string; runId: string; outcomes: ParsedQualityAxisOutcome[] }>;
    study: StudyCaseMetadataV1 | null;
    availabilityCheck: AvailabilityCheck | null;
  }>;
}

type ParsedQualityAxisOutcome =
  | QualityAxisOutcome
  | { axis: QualityAxis; status: "invalid"; category: "semantic_conflict" };

function parseAvailabilityCheck(input: unknown): AvailabilityCheck {
  const row = object(input, [
    "initialDiscoveryStatus",
    "initialUnavailableReasons",
    "refreshAttempted",
    "finalDiscoveryStatus",
    "finalUnavailableReasons",
    "recovered",
  ]);
  const reasons = (value: unknown) =>
    Array.isArray(value) &&
    value.length <= AVAILABILITY_REASONS.length &&
    value.every((reason) => AVAILABILITY_REASONS.includes(reason)) &&
    JSON.stringify(value) === JSON.stringify([...new Set(value)].sort());
  if (
    Object.keys(row).length !== 6 ||
    !DISCOVERY_STATUSES.includes(row.initialDiscoveryStatus as AvailabilityCheck["initialDiscoveryStatus"]) ||
    !DISCOVERY_STATUSES.includes(row.finalDiscoveryStatus as AvailabilityCheck["finalDiscoveryStatus"]) ||
    !["available", "discovery_unsupported"].includes(String(row.finalDiscoveryStatus)) ||
    !reasons(row.initialUnavailableReasons) ||
    !reasons(row.finalUnavailableReasons) ||
    (row.finalUnavailableReasons as unknown[]).length !== 0 ||
    typeof row.refreshAttempted !== "boolean" ||
    typeof row.recovered !== "boolean" ||
    (row.refreshAttempted &&
      (row.initialDiscoveryStatus !== "error" ||
        JSON.stringify(row.initialUnavailableReasons) !== '["runtime_unavailable"]')) ||
    (!row.refreshAttempted &&
      (row.initialDiscoveryStatus !== row.finalDiscoveryStatus ||
        JSON.stringify(row.initialUnavailableReasons) !== JSON.stringify(row.finalUnavailableReasons))) ||
    row.recovered !==
      (row.refreshAttempted &&
        row.finalDiscoveryStatus === "available" &&
        (row.finalUnavailableReasons as unknown[]).length === 0)
  )
    throw new Error("Invalid scalar canary availability check.");
  return row as AvailabilityCheck;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scalar canary manifest.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error("Invalid scalar canary manifest.");
  return row;
}
function parseNoVisibleAttribution(input: unknown, trigger: Record<string, unknown>): NoVisibleAttribution {
  const row = object(input, ["schemaVersion", "category", "generations"]);
  const starts = integer(trigger.generationStarts, 100);
  if (
    Object.keys(row).length !== 3 ||
    row.schemaVersion !== 1 ||
    !ATTRIBUTION_CATEGORIES.includes(row.category as NoVisibleAttribution["category"]) ||
    !Array.isArray(row.generations) ||
    starts === null ||
    row.generations.length !== starts
  )
    throw new Error("Invalid scalar no-visible attribution.");
  const generations = row.generations.map((entry: unknown, index: number) => {
    const generation = object(entry, ["ordinal", "category"]);
    if (
      Object.keys(generation).length !== 2 ||
      generation.ordinal !== index + 1 ||
      !GENERATION_CATEGORIES.includes(generation.category as NoVisibleAttribution["generations"][number]["category"])
    )
      throw new Error("Invalid scalar no-visible attribution.");
    return generation as NoVisibleAttribution["generations"][number];
  });
  const routing = trigger.routing as Array<{ outcome: string }>;
  const delivered = integer(trigger.confirmedDeliveredBursts, 100);
  const completions = integer(trigger.generationCompletions, 100);
  const failures = integer(trigger.generationFailures, 100);
  if (delivered === null || completions === null || failures === null)
    throw new Error("Invalid scalar no-visible attribution.");
  const kinds = generations.map((generation) => generation.category);
  if (
    kinds.filter((kind) => ["delivered", "yielded", "undelivered", "completed-no-delivery-evidence"].includes(kind))
      .length > completions ||
    kinds.filter((kind) => kind === "failed").length > failures
  )
    throw new Error("Contradictory scalar no-visible attribution.");
  let expected: NoVisibleAttribution["category"] = "mixed-or-unresolved";
  if (delivered > 0) expected = "visible-delivered";
  else if (
    trigger.preflightMode === "enforce" &&
    starts === 0 &&
    routing.length > 0 &&
    routing.every((item) => item.outcome === "suppress")
  )
    expected = "gate-suppressed";
  else if (
    trigger.preflightMode === "enforce" &&
    starts === 0 &&
    routing.some((item) => item.outcome === "unavailable") &&
    routing.every((item) => item.outcome !== "invoke")
  )
    expected = "routing-unavailable";
  else if (kinds.length > 0 && kinds.every((kind) => kind === "failed")) expected = "generation-failed";
  else if (kinds.length > 0 && kinds.every((kind) => kind === "yielded")) expected = "completed-yielded";
  else if (
    kinds.length > 0 &&
    kinds.every((kind) => kind === "undelivered" || kind === "completed-no-delivery-evidence")
  )
    expected = "completed-no-delivery";
  if (row.category !== expected) throw new Error("Contradictory scalar no-visible attribution.");
  return { schemaVersion: 1, category: expected, generations };
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

function parseStudy(value: unknown): StudyCaseMetadataV1 {
  const row = object(value, [
    "schemaVersion",
    "planId",
    "planSha256",
    "blockId",
    "replicateId",
    "pairId",
    "caseId",
    "arm",
    "factor",
    "order",
    "arcProfileId",
    "jevProfileId",
    "gateProfileId",
    "agentPromptProfileId",
    "agentPromptProfileDigest",
    "jevProfileDigest",
    "gateProfileDigest",
    "rosterOrder",
  ]);
  if (
    row.schemaVersion !== 1 ||
    !["planId", "blockId", "replicateId", "pairId", "caseId"].every((key) => id(row[key])) ||
    ![row.planSha256, row.jevProfileDigest, row.gateProfileDigest, row.agentPromptProfileDigest].every(
      (value) => typeof value === "string" && SHA.test(value),
    ) ||
    !["a", "b"].includes(String(row.arm)) ||
    !["jev", "gate", "agent-prompt"].includes(String(row.factor)) ||
    !["ab", "ba"].includes(String(row.order)) ||
    ![
      "single-v1",
      "casual-thread-v1",
      "agent-exchange-v1",
      "agent-exchange-v2",
      "handoff-choice-v1",
      "dispute-resolution-v1",
    ].includes(String(row.arcProfileId)) ||
    !["off-v1", "current-v1", "lean-v1", "relevance-v1"].includes(String(row.jevProfileId)) ||
    !["current-v1", "relevance-v1"].includes(String(row.gateProfileId)) ||
    !["current-v1", "social-v1"].includes(String(row.agentPromptProfileId)) ||
    !Array.isArray(row.rosterOrder) ||
    row.rosterOrder.length < 1 ||
    row.rosterOrder.length > 4 ||
    row.rosterOrder.some((value) => !id(value)) ||
    new Set(row.rosterOrder).size !== row.rosterOrder.length
  )
    throw new Error("Invalid scalar canary manifest.");
  return row as unknown as StudyCaseMetadataV1;
}

function parseQualityOutcome(
  value: unknown,
  axis: QualityAxis,
  scenarioId: string,
  runId: string,
  judgeModel: string,
  visibleBursts: number,
  requiredTargets: number,
): ParsedQualityAxisOutcome {
  const row = object(value, ["axis", "status", "result", "category"]);
  if (row.axis !== axis) throw new Error("Invalid scalar canary manifest.");
  if (row.status === "failed") {
    if (Object.keys(row).length !== 3 || !JUDGE_FAILURES.includes(row.category as (typeof JUDGE_FAILURES)[number]))
      throw new Error("Invalid scalar canary manifest.");
    return {
      axis,
      status: "failed",
      category: row.category as Extract<QualityAxisOutcome, { status: "failed" }>["category"],
    };
  }
  if (row.status !== "completed" || Object.keys(row).length !== 3) throw new Error("Invalid scalar canary manifest.");
  const result = object(row.result, [
    "schemaVersion",
    "rubricVersion",
    "scenarioId",
    "runId",
    "judgeModel",
    "resolvedJudgeModel",
    "axis",
    "status",
    "score",
    "reasonCode",
    "details",
    "judgeUsage",
  ]);
  if (
    result.schemaVersion !== 2 ||
    result.rubricVersion !== "room-quality-v2" ||
    result.scenarioId !== scenarioId ||
    result.runId !== runId ||
    result.judgeModel !== judgeModel ||
    result.axis !== axis ||
    (result.resolvedJudgeModel !== null &&
      (typeof result.resolvedJudgeModel !== "string" || !RESOLVED_MODEL.test(result.resolvedJudgeModel))) ||
    !["rated", "not_applicable", "not_assessable"].includes(String(result.status)) ||
    ![
      "observable_exchange",
      "required_reply_missing",
      "silence_fit",
      "no_applicable_obligation",
      "no_visible_reply",
      "insufficient_context",
    ].includes(String(result.reasonCode)) ||
    (result.status === "rated" ? !score(result.score) : result.score !== null)
  )
    throw new Error("Invalid scalar canary manifest.");
  const detailKeys: Record<QualityAxis, readonly string[]> = {
    social_cadence: ["cueFit", "textTurnRhythm"],
    length_fit: ["direction"],
    address_radius: ["observedAudience", "audienceFit"],
    contribution_value: ["valueMode"],
  };
  const enums: Record<string, readonly string[]> = {
    cueFit: ["missed", "neutral", "attuned"],
    textTurnRhythm: ["disruptive", "uneven", "smooth"],
    direction: ["too_short", "appropriate", "too_long"],
    observedAudience: ["user", "agent", "both", "unclear"],
    audienceFit: ["misdirected", "mixed", "aligned"],
    valueMode: ["knowledge", "entertainment", "both", "neither"],
  };
  const details = object(result.details, detailKeys[axis]);
  if (
    Object.keys(details).length !== detailKeys[axis].length ||
    detailKeys[axis].some((key) => ![...enums[key]!, null].includes(details[key] as string))
  )
    throw new Error("Invalid scalar canary manifest.");
  const requiredMissing =
    axis === "length_fit" &&
    visibleBursts === 0 &&
    requiredTargets > 0 &&
    result.status === "rated" &&
    result.score === 1 &&
    result.reasonCode === "required_reply_missing" &&
    details.direction === "too_short";
  const optionalSilence =
    axis === "length_fit" &&
    visibleBursts === 0 &&
    requiredTargets === 0 &&
    result.status === "rated" &&
    result.reasonCode === "silence_fit" &&
    (details.direction === "too_short" || details.direction === "appropriate");
  const semanticConflict =
    result.status === "rated"
      ? !requiredMissing &&
        !optionalSilence &&
        (result.reasonCode !== "observable_exchange" ||
          visibleBursts === 0 ||
          Object.values(details).some((value) => value === null))
      : Object.values(details).some((value) => value !== null) ||
        (result.status === "not_applicable" && result.reasonCode !== "no_applicable_obligation") ||
        (result.status === "not_assessable" &&
          !["no_visible_reply", "insufficient_context"].includes(String(result.reasonCode))) ||
        (visibleBursts > 0 && result.reasonCode === "no_visible_reply");
  const usage = object(result.judgeUsage, ["inputTokens", "outputTokens", "reportedCostUsd"]);
  if (Object.keys(usage).length !== 3) throw new Error("Invalid scalar canary manifest.");
  nullableInteger(usage.inputTokens, 1_000_000);
  nullableInteger(usage.outputTokens, 1_000_000);
  nullableNumber(usage.reportedCostUsd, 1_000);
  if (
    (result.reasonCode === "required_reply_missing" || result.reasonCode === "no_visible_reply") &&
    (usage.inputTokens !== null || usage.outputTokens !== null || usage.reportedCostUsd !== null)
  )
    throw new Error("Invalid scalar canary manifest.");
  // A structurally valid receipt can still contradict the observed turn. Keep its
  // axis denominator, but never treat its score or cost as a valid observation.
  if (semanticConflict) return { axis, status: "invalid", category: "semantic_conflict" };
  return {
    axis,
    status: "completed",
    result: result as unknown as Extract<QualityAxisOutcome, { status: "completed" }>["result"],
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
    "judgeRubric",
    "maximumScheduledJudgeCalls",
    "planningAllowanceMs",
    "studyPlan",
    "studyBatch",
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
    (top.judgeRubric !== undefined && top.judgeRubric !== "v1" && top.judgeRubric !== "v2") ||
    (top.maximumScheduledJudgeCalls !== undefined && integer(top.maximumScheduledJudgeCalls, 500) === null) ||
    (top.planningAllowanceMs !== undefined && integer(top.planningAllowanceMs, 86_400_000) === null) ||
    top.concurrency !== 1 ||
    integer(top.maxCases, top.studyBatch === undefined ? MAX_CASES : MAX_MERGED_CASES) === null ||
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
    top.cases.length > (top.studyBatch === undefined ? MAX_CASES : 12)
  )
    throw new Error("Invalid scalar canary manifest.");
  let studyPlan: ScalarCanaryManifest["studyPlan"] = null;
  if (top.studyPlan !== undefined) {
    const plan = object(top.studyPlan, ["schemaVersion", "planId", "planSha256", "orderSeed", "jevModel"]);
    if (
      plan.schemaVersion !== 1 ||
      !id(plan.planId) ||
      typeof plan.planSha256 !== "string" ||
      !SHA.test(plan.planSha256) ||
      integer(plan.orderSeed, 0xffffffff) === null ||
      typeof plan.jevModel !== "string" ||
      !MODEL.test(`openrouter/${plan.jevModel}`)
    )
      throw new Error("Invalid scalar canary manifest.");
    studyPlan = plan as unknown as NonNullable<ScalarCanaryManifest["studyPlan"]>;
  }
  let studyBatch: ScalarCanaryManifest["studyBatch"] = null;
  if (top.studyBatch !== undefined) {
    const batch = object(top.studyBatch, [
      "schemaVersion",
      "planCaseCount",
      "planPairCount",
      "batchIndex",
      "batchCount",
      "pairsPerBatch",
      "pairCount",
      "pairIds",
    ]);
    const planPairCount = integer(batch.planPairCount, MAX_STUDY_PAIRS);
    const pairsPerBatch = integer(batch.pairsPerBatch, 6);
    const batchCount = integer(batch.batchCount, MAX_STUDY_PAIRS);
    const pairCount = integer(batch.pairCount, 6);
    if (
      !studyPlan ||
      top.sourceDirty !== false ||
      batch.schemaVersion !== 1 ||
      planPairCount === null ||
      planPairCount < 1 ||
      batch.planCaseCount !== 2 * planPairCount ||
      pairsPerBatch === null ||
      pairsPerBatch < 1 ||
      batchCount !== Math.ceil(planPairCount / pairsPerBatch) ||
      integer(batch.batchIndex, batchCount - 1) === null ||
      pairCount === null ||
      pairCount < 1 ||
      pairCount !== Math.min(pairsPerBatch, planPairCount - Number(batch.batchIndex) * pairsPerBatch) ||
      !Array.isArray(batch.pairIds) ||
      batch.pairIds.length !== pairCount ||
      batch.pairIds.some((pairId) => !id(pairId)) ||
      new Set(batch.pairIds).size !== pairCount ||
      top.cases.length !== pairCount * 2
    )
      throw new Error("Invalid scalar canary study batch.");
    studyBatch = batch as unknown as NonNullable<ScalarCanaryManifest["studyBatch"]>;
  }
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
      "qualityJudge",
      "study",
      "privateReviewRetained",
      "availabilityCheck",
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
      row.triggers.length > 3 ||
      !Array.isArray(row.judge) ||
      row.judge.length > 3 ||
      (row.qualityJudge !== undefined && (!Array.isArray(row.qualityJudge) || row.qualityJudge.length > 3))
    )
      throw new Error("Invalid scalar canary manifest.");
    const study = row.study === undefined ? null : parseStudy(row.study);
    const availabilityCheck =
      row.availabilityCheck === undefined ? null : parseAvailabilityCheck(row.availabilityCheck);
    if (
      (studyPlan === null) !== (study === null) ||
      (study &&
        (study.planId !== studyPlan?.planId ||
          study.planSha256 !== studyPlan?.planSha256 ||
          study.rosterOrder.length !== row.agentCount))
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
        "noVisibleAttributionV1",
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
      const noVisibleAttributionV1 =
        trigger.noVisibleAttributionV1 === undefined
          ? null
          : parseNoVisibleAttribution(trigger.noVisibleAttributionV1, trigger);
      const classifier = object(trigger.classifier, [
        "outcome",
        "reason",
        "durationMs",
        "reportedInputTokens",
        "reportedOutputTokens",
        "reportedCostUsd",
        "resolvedModelId",
      ]);
      if (
        !["completed", "failed", "skipped", "not-consulted"].includes(String(classifier.outcome)) ||
        (classifier.reason !== null && !/^[a-z][a-z_-]{1,79}$/.test(String(classifier.reason))) ||
        (classifier.resolvedModelId !== undefined &&
          classifier.resolvedModelId !== null &&
          (typeof classifier.resolvedModelId !== "string" || !RESOLVED_MODEL.test(classifier.resolvedModelId)))
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
        (row.variant === "jev-on" && study === null && jev.outcome !== "completed") ||
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
        resolvedJevModelId:
          classifier.resolvedModelId === undefined ? null : (classifier.resolvedModelId as string | null),
        attemptedTurns:
          integer(trigger.attemptedTurns, 100) ??
          (() => {
            throw new Error("Invalid scalar canary manifest.");
          })(),
        respondedTurns:
          integer(trigger.respondedTurns, 100) ??
          (() => {
            throw new Error("Invalid scalar canary manifest.");
          })(),
        yieldedTurns:
          integer(trigger.yieldedTurns, 100) ??
          (() => {
            throw new Error("Invalid scalar canary manifest.");
          })(),
        confirmedDeliveredBursts:
          integer(trigger.confirmedDeliveredBursts, 100) ??
          (() => {
            throw new Error("Invalid scalar canary manifest.");
          })(),
        requiredTargetCount: trigger.requiredAddressAgents.length,
        noVisibleAttributionV1,
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
    const qualityJudge = ((row.qualityJudge ?? []) as unknown[]).map((entry: unknown) => {
      const value = object(entry, ["scenarioId", "runId", "outcomes"]);
      if (
        !id(value.scenarioId) ||
        !id(value.runId) ||
        !top.judgeModel ||
        !Array.isArray(value.outcomes) ||
        value.outcomes.length !== QUALITY_AXES.length ||
        !triggers.some((trigger) => trigger.scenarioId === value.scenarioId && trigger.runId === value.runId)
      )
        throw new Error("Invalid scalar canary manifest.");
      return {
        scenarioId: value.scenarioId,
        runId: value.runId,
        outcomes: QUALITY_AXES.map((axis, index) =>
          parseQualityOutcome(
            (value.outcomes as unknown[])[index],
            axis,
            value.scenarioId as string,
            value.runId as string,
            (top.judgeModel as string).slice("openrouter/".length),
            triggers.find((trigger) => trigger.scenarioId === value.scenarioId && trigger.runId === value.runId)!
              .confirmedDeliveredBursts,
            triggers.find((trigger) => trigger.scenarioId === value.scenarioId && trigger.runId === value.runId)!
              .requiredTargetCount,
          ),
        ),
      };
    });
    if (
      new Set(qualityJudge.map((entry) => `${entry.scenarioId}\u0000${entry.runId}`)).size !== qualityJudge.length ||
      ((top.judgeRubric ?? "v1") === "v2" && judge.length !== 0) ||
      ((top.judgeRubric ?? "v1") === "v1" && qualityJudge.length !== 0)
    )
      throw new Error("Invalid scalar canary manifest.");
    return {
      scenarioId: row.scenarioId as string,
      variant: row.variant as Variant,
      agentCount: row.agentCount as number,
      energy: row.energy as Energy,
      preflightMode: row.preflightMode as PreflightMode,
      triggers,
      judge,
      qualityJudge,
      study,
      availabilityCheck,
    };
  });
  if (new Set(cases.map((row) => `${row.scenarioId}\u0000${row.variant}`)).size !== cases.length)
    throw new Error("Invalid scalar canary manifest.");
  if (studyBatch) {
    const orderedPairIds = [...new Set(cases.map((row) => row.study?.pairId))];
    if (
      orderedPairIds.length !== studyBatch.pairCount ||
      orderedPairIds.some((pairId, index) => pairId !== studyBatch.pairIds[index]) ||
      studyBatch.pairIds.some((pairId) => {
        const rows = cases.filter((row) => row.study?.pairId === pairId);
        return rows.length !== 2 || new Set(rows.map((row) => row.study?.arm)).size !== 2;
      })
    )
      throw new Error("Invalid scalar canary study batch.");
  }
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
    judgeRubric: (top.judgeRubric ?? "v1") as "v1" | "v2",
    studyPlan,
    studyBatch,
    runLimits: {
      maxGenerationsPerCase: top.maxGenerationsPerCase as number,
      scenarioTimeoutMs: top.scenarioTimeoutMs as number,
    },
    cases,
  };
}

/** Merge independent completed canary invocations without equating different source builds. */
export function mergeScalarCanaryManifests(manifests: readonly ScalarCanaryManifest[]): ScalarCanaryManifest {
  if (!manifests.length || manifests.length > MAX_STUDY_PAIRS) throw new Error("Invalid scalar canary manifest set.");
  const first = manifests[0]!;
  const cases = manifests.flatMap((manifest) => manifest.cases);
  const batched = first.studyBatch !== null;
  if (batched) {
    const batches = manifests.map((manifest) => manifest.studyBatch);
    const expected = first.studyBatch!;
    if (
      batches.some(
        (batch) =>
          !batch ||
          batch.planCaseCount !== expected.planCaseCount ||
          batch.planPairCount !== expected.planPairCount ||
          batch.batchCount !== expected.batchCount ||
          batch.pairsPerBatch !== expected.pairsPerBatch,
      ) ||
      batches.length !== expected.batchCount ||
      new Set(batches.map((batch) => batch?.batchIndex)).size !== expected.batchCount ||
      batches.some((batch) => batch === null || batch.batchIndex < 0 || batch.batchIndex >= expected.batchCount) ||
      cases.length !== expected.planCaseCount ||
      new Set(batches.flatMap((batch) => batch?.pairIds ?? [])).size !== expected.planPairCount ||
      batches.flatMap((batch) => batch?.pairIds ?? []).length !== expected.planPairCount
    )
      throw new Error("Incomplete or overlapping scalar canary study batches.");
  } else if (manifests.some((manifest) => manifest.studyBatch !== null)) {
    throw new Error("Cannot mix batched and unbatched scalar canary studies.");
  }
  const settings = new Map<string, string>();
  for (const row of cases) {
    const value = JSON.stringify([row.agentCount, row.energy, row.preflightMode]);
    const prior = settings.get(row.scenarioId);
    if (prior !== undefined && prior !== value) throw new Error("Incompatible scalar canary settings.");
    settings.set(row.scenarioId, value);
  }
  if (
    cases.length > (batched ? MAX_MERGED_CASES : MAX_CASES) ||
    cases.flatMap((row) => row.triggers).length > (batched ? MAX_MERGED_TRIGGERS : MAX_TRIGGERS) ||
    manifests.some(
      (manifest) =>
        manifest.sourceCommit !== first.sourceCommit ||
        manifest.sourceDirty !== first.sourceDirty ||
        manifest.sourceSha256 !== first.sourceSha256 ||
        manifest.openCodeVersion !== first.openCodeVersion ||
        manifest.actorModel !== first.actorModel ||
        manifest.judgeModel !== first.judgeModel ||
        manifest.judgeRubric !== first.judgeRubric ||
        JSON.stringify(manifest.studyPlan) !== JSON.stringify(first.studyPlan) ||
        JSON.stringify(manifest.runLimits) !== JSON.stringify(first.runLimits),
    ) ||
    new Set(manifests.map((manifest) => manifest.judgeModel).filter((value) => value !== null)).size > 1 ||
    new Set(cases.map((row) => `${row.scenarioId}\u0000${row.variant}`)).size !== cases.length ||
    new Set(cases.flatMap((row) => row.triggers.map((trigger) => trigger.runId))).size !==
      cases.flatMap((row) => row.triggers).length
  )
    throw new Error("Incompatible or duplicate scalar canary manifests.");
  const judgeModel = manifests.find((manifest) => manifest.judgeModel !== null)?.judgeModel ?? null;
  const profileDigests = new Map<string, string>();
  for (const row of cases) {
    if (!row.study) continue;
    const profiles: [string, string, string][] = [
      ["jev", row.study.jevProfileId, row.study.jevProfileDigest],
      ["gate", row.study.gateProfileId, row.study.gateProfileDigest],
      ["agent-prompt", row.study.agentPromptProfileId, row.study.agentPromptProfileDigest],
    ];
    for (const [kind, profileId, digest] of profiles) {
      const key = `${kind}:${profileId}`;
      const prior = profileDigests.get(key);
      if (prior !== undefined && prior !== digest) throw new Error("Incompatible scalar canary profile digest.");
      profileDigests.set(key, digest);
    }
  }
  return {
    ...first,
    scenarioCatalogSha256s: [...new Set(manifests.flatMap((manifest) => manifest.scenarioCatalogSha256s))].sort(),
    judgeModel,
    studyBatch: batched ? first.studyBatch : null,
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

/** Descriptive spread only: every value represents one isolated matched room pair. */
function blockDistribution(values: readonly number[], candidateBlocks: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const weight = position - lower;
    return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * weight;
  };
  return {
    candidateBlocks,
    pairedBlocks: sorted.length,
    missingBlocks: candidateBlocks - sorted.length,
    mean: mean(sorted),
    minimum: sorted[0] ?? null,
    firstQuartile: percentile(0.25),
    median: percentile(0.5),
    thirdQuartile: percentile(0.75),
    maximum: sorted.at(-1) ?? null,
    bHigher: sorted.filter((value) => value > 0).length,
    equal: sorted.filter((value) => value === 0).length,
    bLower: sorted.filter((value) => value < 0).length,
  };
}

/** Study observations preserve axis and coverage denominators; A/B is a paired observation, not a causal estimate. */
export function analyzeQualityStudy(
  manifest: ScalarCanaryManifest,
  ratings: readonly QualityHumanRating[] = [],
  options: { seed?: string; maxSpotChecks?: number } = {},
) {
  if (manifest.judgeRubric !== "v2" || !manifest.studyPlan || manifest.cases.some((row) => !row.study))
    throw new Error("A versioned study manifest is required.");
  if (manifest.studyBatch && manifest.cases.length !== manifest.studyBatch.planCaseCount)
    throw new Error("A complete set of final study batches is required.");
  const parsedRatings = parsePrivateQualityRatings({ schemaVersion: 2, ratings });
  const all = manifest.cases.flatMap((caseRow) =>
    caseRow.triggers.map((trigger, ordinal) => ({
      caseRow,
      trigger,
      ordinal,
      judgment: caseRow.qualityJudge.find(
        (row) => row.scenarioId === trigger.scenarioId && row.runId === trigger.runId,
      ),
    })),
  );
  const resolvedJevSnapshots = [
    ...new Set(
      all.flatMap(({ trigger }) =>
        trigger.jev.outcome === "completed" && trigger.resolvedJevModelId !== null ? [trigger.resolvedJevModelId] : [],
      ),
    ),
  ].sort();
  if (resolvedJevSnapshots.length > 1)
    throw new Error(`Mixed provider-resolved Jev snapshot IDs: ${resolvedJevSnapshots.join(", ")}`);
  const key = (scenarioId: string, runId: string) => `${scenarioId}\u0000${runId}`;
  const known = new Set(all.map(({ trigger }) => key(trigger.scenarioId, trigger.runId)));
  if (parsedRatings.some((row) => !known.has(key(row.scenarioId, row.runId))))
    throw new Error("Private rating does not match a completed canary run.");
  const human = new Map(parsedRatings.map((row) => [key(row.scenarioId, row.runId), row]));
  const outcome = (item: (typeof all)[number], axis: QualityAxis) =>
    item.judgment?.outcomes.find((row) => row.axis === axis);
  const scoreOf = (item: (typeof all)[number], axis: QualityAxis) => {
    const entry = outcome(item, axis);
    return entry?.status === "completed" && entry.result.status === "rated" ? entry.result.score : null;
  };
  const counts = (items: typeof all, axis: QualityAxis) => ({
    rated: items.filter(
      (item) =>
        outcome(item, axis)?.status === "completed" &&
        (outcome(item, axis) as Extract<QualityAxisOutcome, { status: "completed" }>).result.status === "rated",
    ).length,
    notApplicable: items.filter(
      (item) =>
        outcome(item, axis)?.status === "completed" &&
        (outcome(item, axis) as Extract<QualityAxisOutcome, { status: "completed" }>).result.status ===
          "not_applicable",
    ).length,
    notAssessable: items.filter(
      (item) =>
        outcome(item, axis)?.status === "completed" &&
        (outcome(item, axis) as Extract<QualityAxisOutcome, { status: "completed" }>).result.status ===
          "not_assessable",
    ).length,
    missing: items.filter((item) => !outcome(item, axis)).length,
    failed: items.filter((item) => outcome(item, axis)?.status === "failed").length,
    invalid: items.filter((item) => outcome(item, axis)?.status === "invalid").length,
    meanRatedScore: mean(
      items.map((item) => scoreOf(item, axis)).filter((value): value is 1 | 2 | 3 | 4 | 5 => value !== null),
    ),
  });
  const group = new Map<string, typeof manifest.cases>();
  for (const row of manifest.cases) {
    const pairId = row.study!.pairId;
    group.set(pairId, [...(group.get(pairId) ?? []), row]);
  }
  const compatible = (a: (typeof manifest.cases)[number], b: (typeof manifest.cases)[number]) => {
    const x = a.study!,
      y = b.study!;
    if (
      x.arm !== "a" ||
      y.arm !== "b" ||
      x.factor !== y.factor ||
      x.blockId !== y.blockId ||
      x.replicateId !== y.replicateId ||
      x.order !== y.order ||
      x.arcProfileId !== y.arcProfileId ||
      a.agentCount !== b.agentCount ||
      a.energy !== b.energy ||
      (x.factor !== "jev" && a.preflightMode !== b.preflightMode) ||
      JSON.stringify(x.rosterOrder) !== JSON.stringify(y.rosterOrder) ||
      a.triggers.length !== b.triggers.length
    )
      return false;
    const changed = [
      x.jevProfileId !== y.jevProfileId ? "jev" : null,
      x.gateProfileId !== y.gateProfileId ? "gate" : null,
      x.agentPromptProfileId !== y.agentPromptProfileId ? "agent-prompt" : null,
    ].filter(Boolean);
    return (
      changed.length === 1 &&
      changed[0] === x.factor &&
      (x.factor === "jev" || x.jevProfileDigest === y.jevProfileDigest) &&
      (x.factor === "gate" || x.factor === "jev" || x.gateProfileDigest === y.gateProfileDigest) &&
      (x.factor === "agent-prompt" || x.agentPromptProfileDigest === y.agentPromptProfileDigest) &&
      (x.factor !== "jev" || x.jevProfileDigest !== y.jevProfileDigest) &&
      (x.factor !== "gate" || x.gateProfileDigest !== y.gateProfileDigest) &&
      (x.factor !== "agent-prompt" || x.agentPromptProfileDigest !== y.agentPromptProfileDigest)
    );
  };
  const pairs: Array<{ a: (typeof all)[number]; b: (typeof all)[number]; pairId: string }> = [];
  let matchedCasePairs = 0,
    excludedCasePairs = 0,
    excludedTriggerPairsJevIncomplete = 0,
    excludedTriggerPairsModelUnknown = 0,
    excludedTriggerPairsModelMismatch = 0;
  for (const [pairId, cases] of group) {
    const a = cases.find((row) => row.study!.arm === "a"),
      b = cases.find((row) => row.study!.arm === "b");
    if (cases.length !== 2 || !a || !b || !compatible(a, b)) {
      excludedCasePairs++;
      continue;
    }
    matchedCasePairs++;
    for (let ordinal = 0; ordinal < a.triggers.length; ordinal++) {
      const first = all.find((item) => item.caseRow === a && item.ordinal === ordinal)!;
      const second = all.find((item) => item.caseRow === b && item.ordinal === ordinal)!;
      if (
        (first.trigger.variant === "jev-on" && first.trigger.jev.outcome !== "completed") ||
        (second.trigger.variant === "jev-on" && second.trigger.jev.outcome !== "completed")
      ) {
        excludedTriggerPairsJevIncomplete++;
        continue;
      }
      // Different consulted Jev model IDs cannot be interpreted as one controlled factor.
      if (first.trigger.jev.outcome === "completed" && second.trigger.jev.outcome === "completed") {
        if (first.trigger.resolvedJevModelId === null || second.trigger.resolvedJevModelId === null) {
          excludedTriggerPairsModelUnknown++;
          continue;
        }
        if (first.trigger.resolvedJevModelId !== second.trigger.resolvedJevModelId) {
          excludedTriggerPairsModelMismatch++;
          continue;
        }
      }
      pairs.push({ a: first, b: second, pairId });
    }
  }
  const axes = Object.fromEntries(
    QUALITY_AXES.map((axis) => {
      const reviewed = all.map((item) => ({
        judge: outcome(item, axis),
        human: human.get(key(item.trigger.scenarioId, item.trigger.runId))?.axes[axis],
      }));
      const both = reviewed.filter(({ judge, human }) => judge?.status === "completed" && human !== undefined);
      const jointlyRated = both.filter(
        ({ judge, human }) =>
          judge?.status === "completed" && judge.result.status === "rated" && human?.status === "rated",
      );
      const humanCounts = {
        rated: reviewed.filter(({ human }) => human?.status === "rated").length,
        notApplicable: reviewed.filter(({ human }) => human?.status === "not_applicable").length,
        notAssessable: reviewed.filter(({ human }) => human?.status === "not_assessable").length,
        missing: reviewed.filter(({ human }) => !human).length,
      };
      return [
        axis,
        {
          judge: counts(all, axis),
          judgeReportedCostUsd: aggregate(
            all.map((item) => {
              const entry = outcome(item, axis);
              return entry?.status === "completed" ? entry.result.judgeUsage.reportedCostUsd : null;
            }),
          ),
          human: humanCounts,
          agreement: {
            jointStatusReviews: both.length,
            statusExact: both.filter(
              ({ judge, human }) => judge?.status === "completed" && judge.result.status === human?.status,
            ).length,
            jointlyRated: jointlyRated.length,
            scoreExact: jointlyRated.filter(
              ({ judge, human }) =>
                judge?.status === "completed" && human?.status === "rated" && judge.result.score === human.score,
            ).length,
            scoreWithinOne: jointlyRated.filter(
              ({ judge, human }) =>
                judge?.status === "completed" &&
                human?.status === "rated" &&
                Math.abs(judge.result.score! - human.score) <= 1,
            ).length,
          },
        },
      ];
    }),
  );
  const rank = (item: (typeof all)[number]) => {
    let priority = 0;
    for (const axis of QUALITY_AXES) {
      const judge = outcome(item, axis),
        humanRating = human.get(key(item.trigger.scenarioId, item.trigger.runId))?.axes[axis];
      if (
        judge?.status === "failed" ||
        !judge ||
        (judge.status === "completed" && judge.result.status === "not_assessable")
      )
        priority = Math.max(priority, 3);
      if (judge?.status === "completed" && judge.result.status === "rated" && judge.result.score! <= 2)
        priority = Math.max(priority, 2);
      if (
        judge?.status === "completed" &&
        humanRating &&
        (judge.result.status !== humanRating.status ||
          (judge.result.status === "rated" &&
            humanRating.status === "rated" &&
            Math.abs(judge.result.score! - humanRating.score) > 1))
      )
        priority = 4;
    }
    return priority;
  };
  const seed = options.seed ?? "study-v2";
  const max = options.maxSpotChecks ?? 4;
  const sorted = [...all].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      createHash("sha256")
        .update(`${seed}:${a.trigger.scenarioId}:${a.trigger.runId}`)
        .digest("hex")
        .localeCompare(createHash("sha256").update(`${seed}:${b.trigger.scenarioId}:${b.trigger.runId}`).digest("hex")),
  );
  const selected = sorted.slice(0, max);
  if (
    max >= 2 &&
    selected.length >= 2 &&
    all.some((item) => rank(item) === 0) &&
    selected.every((item) => rank(item) > 0)
  )
    selected[selected.length - 1] = sorted.find((item) => rank(item) === 0)!;
  const metric = (get: (item: (typeof all)[number]) => number | null) => aggregate(all.map(get));
  const pairedMetric = (selectedPairs: typeof pairs, get: (item: (typeof all)[number]) => number | null) =>
    delta(
      selectedPairs.flatMap(({ a, b }) => {
        const av = get(a),
          bv = get(b);
        return av === null || bv === null ? [] : [bv - av];
      }),
    );
  const judgeCost = (item: (typeof all)[number]) =>
    item.judgment
      ? item.judgment.outcomes.reduce<number | null>(
          (sum, outcome) =>
            outcome.status !== "completed" || outcome.result.judgeUsage.reportedCostUsd === null || sum === null
              ? null
              : sum + outcome.result.judgeUsage.reportedCostUsd,
          0,
        )
      : null;
  const judgeAxisCosts = all.flatMap((item) =>
    QUALITY_AXES.map((axis) => {
      const entry = outcome(item, axis);
      return {
        reported: entry?.status === "completed" ? entry.result.judgeUsage.reportedCostUsd : null,
        knownNoCall:
          entry?.status === "completed" &&
          entry.result.judgeUsage.reportedCostUsd === null &&
          (entry.result.reasonCode === "required_reply_missing" || entry.result.reasonCode === "no_visible_reply"),
      };
    }),
  );
  const reportedAxisCosts = judgeAxisCosts.flatMap(({ reported }) => (reported === null ? [] : [reported]));
  const knownNoCallAxes = judgeAxisCosts.filter(({ knownNoCall }) => knownNoCall).length;
  const pairedReadout = (selectedPairs: typeof pairs) => ({
    triggerPairs: selectedPairs.length,
    axes: Object.fromEntries(
      QUALITY_AXES.map((axis) => {
        const judgeDeltas: number[] = [];
        const humanDeltas: number[] = [];
        let resolvedJudgeModelUnknownPairs = 0;
        let resolvedJudgeModelMismatchPairs = 0;
        for (const { a, b } of selectedPairs) {
          const first = outcome(a, axis);
          const second = outcome(b, axis);
          if (first?.status === "completed" && second?.status === "completed") {
            if (first.result.resolvedJudgeModel === null || second.result.resolvedJudgeModel === null)
              resolvedJudgeModelUnknownPairs++;
            else if (first.result.resolvedJudgeModel !== second.result.resolvedJudgeModel)
              resolvedJudgeModelMismatchPairs++;
            else if (first.result.status === "rated" && second.result.status === "rated")
              judgeDeltas.push(second.result.score! - first.result.score!);
          }
          const humanA = human.get(key(a.trigger.scenarioId, a.trigger.runId))?.axes[axis];
          const humanB = human.get(key(b.trigger.scenarioId, b.trigger.runId))?.axes[axis];
          if (humanA?.status === "rated" && humanB?.status === "rated") humanDeltas.push(humanB.score - humanA.score);
        }
        return [
          axis,
          {
            judgeArmBMinusA: delta(judgeDeltas),
            humanArmBMinusA: delta(humanDeltas),
            judgeUnscoredPairs: selectedPairs.length - judgeDeltas.length,
            humanUnscoredPairs: selectedPairs.length - humanDeltas.length,
            resolvedJudgeModelUnknownPairs,
            resolvedJudgeModelMismatchPairs,
          },
        ];
      }),
    ),
    resourcesArmBMinusA: {
      actorEstimatedCostUsd: pairedMetric(selectedPairs, (item) =>
        item.trigger.actor.provenance === "step-fields-v1" && item.trigger.actor.coverage === "reported"
          ? item.trigger.actor.costUsd
          : null,
      ),
      jevReportedCostUsd: pairedMetric(selectedPairs, (item) =>
        item.trigger.jev.outcome === "completed"
          ? item.trigger.jev.costUsd
          : item.trigger.variant === "jev-off"
            ? 0
            : null,
      ),
      judgeReportedCostUsd: pairedMetric(selectedPairs, judgeCost),
      openCodeObservedTotalTokens: pairedMetric(selectedPairs, (item) =>
        item.trigger.actor.provenance === "step-fields-v1" && item.trigger.actor.totalTokenCoverage === "reported"
          ? item.trigger.actor.totalTokens
          : null,
      ),
      firstVisibleMs: pairedMetric(selectedPairs, (item) => item.trigger.firstVisibleMs),
    },
  });
  type StudyCase = (typeof manifest.cases)[number];
  type StudyPair = (typeof pairs)[number];
  const profile = (row: StudyCase) => ({
    jevProfileId: row.study!.jevProfileId,
    jevProfileDigest: row.study!.jevProfileDigest,
    gateProfileId: row.study!.gateProfileId,
    gateProfileDigest: row.study!.gateProfileDigest,
    agentPromptProfileId: row.study!.agentPromptProfileId,
    agentPromptProfileDigest: row.study!.agentPromptProfileDigest,
  });
  const dynamicFor = (row: StudyCase) => {
    const prefix = /^(direct|multi-address|broadcast|casual|handoff|disagreement|quoted-name)-/.exec(
      row.scenarioId,
    )?.[1];
    if (prefix) return prefix;
    return (
      (
        {
          "agent-exchange-v1": "multi-address",
          "agent-exchange-v2": "multi-address",
          "casual-thread-v1": "casual",
          "handoff-choice-v1": "handoff",
          "dispute-resolution-v1": "disagreement",
        } as Record<string, string>
      )[row.study!.arcProfileId] ?? "unknown"
    );
  };
  const structurallyMatchedBlocks = [...group.entries()].flatMap(([pairId, rows]) => {
    const a = rows.find((row) => row.study!.arm === "a");
    const b = rows.find((row) => row.study!.arm === "b");
    if (!a || !b || rows.length !== 2 || !compatible(a, b)) return [];
    const triggerPairs = pairs
      .filter((pair) => pair.pairId === pairId)
      .sort((left, right) => left.a.ordinal - right.a.ordinal);
    const armA = profile(a);
    const armB = profile(b);
    const contrastId = createHash("sha256")
      .update(JSON.stringify([armA, armB]))
      .digest("hex")
      .slice(0, 16);
    const dynamic = dynamicFor(a);
    const stratumId = `${dynamic}:${a.agentCount}:${a.energy}:${a.study!.arcProfileId}`;
    return [
      {
        pairId,
        factor: a.study!.factor,
        contrastId,
        armA,
        armB,
        dynamic,
        stratumId,
        arcProfileId: a.study!.arcProfileId,
        agentCount: a.agentCount,
        energy: a.energy,
        triggerPairs,
        triggerCount: a.triggers.length,
        routingEligible: triggerPairs.length === a.triggers.length,
      },
    ];
  });
  type Block = (typeof structurallyMatchedBlocks)[number];
  const blockDelta = (block: Block, get: (item: StudyPair["a"]) => number | null, reduce: "sum" | "mean" = "sum") => {
    if (!block.routingEligible) return null;
    const first = block.triggerPairs.map(({ a }) => get(a));
    const second = block.triggerPairs.map(({ b }) => get(b));
    if (first.some((value) => value === null) || second.some((value) => value === null)) return null;
    const aTotal = first.reduce<number>((sum, value) => sum + value!, 0);
    const bTotal = second.reduce<number>((sum, value) => sum + value!, 0);
    return (bTotal - aTotal) / (reduce === "mean" ? block.triggerCount : 1);
  };
  const judgeBlockDelta = (block: Block, axis: QualityAxis) => {
    if (!block.routingEligible) return null;
    const models = new Set<string>();
    const deltas: number[] = [];
    for (const { a, b } of block.triggerPairs) {
      const first = outcome(a, axis);
      const second = outcome(b, axis);
      if (
        first?.status !== "completed" ||
        second?.status !== "completed" ||
        first.result.status !== "rated" ||
        second.result.status !== "rated" ||
        !first.result.resolvedJudgeModel ||
        first.result.resolvedJudgeModel !== second.result.resolvedJudgeModel
      )
        return null;
      models.add(first.result.resolvedJudgeModel);
      deltas.push(second.result.score! - first.result.score!);
    }
    return models.size === 1 ? mean(deltas) : null;
  };
  const humanBlockDelta = (block: Block, axis: QualityAxis) => {
    if (!block.routingEligible) return null;
    const deltas: number[] = [];
    for (const { a, b } of block.triggerPairs) {
      const first = human.get(key(a.trigger.scenarioId, a.trigger.runId))?.axes[axis];
      const second = human.get(key(b.trigger.scenarioId, b.trigger.runId))?.axes[axis];
      if (first?.status !== "rated" || second?.status !== "rated") return null;
      deltas.push(second.score - first.score);
    }
    return mean(deltas);
  };
  const judgeCostForBlock = (item: StudyPair["a"]) => {
    if (!item.judgment) return null;
    let total = 0;
    for (const entry of item.judgment.outcomes) {
      if (entry.status !== "completed") return null;
      const cost = entry.result.judgeUsage.reportedCostUsd;
      if (cost === null && !["required_reply_missing", "no_visible_reply"].includes(entry.result.reasonCode))
        return null;
      total += cost ?? 0;
    }
    return total;
  };
  const blockMetric = (blocks: readonly Block[], get: (block: Block) => number | null) =>
    blockDistribution(
      blocks.flatMap((block) => {
        const value = get(block);
        return value === null ? [] : [value];
      }),
      blocks.length,
    );
  const blockReadout = (blocks: readonly Block[]) => ({
    candidateBlocks: blocks.length,
    routingEligibleBlocks: blocks.filter((block) => block.routingEligible).length,
    axes: Object.fromEntries(
      QUALITY_AXES.map((axis) => [
        axis,
        {
          judgeArmBMinusA: blockMetric(blocks, (block) => judgeBlockDelta(block, axis)),
          humanArmBMinusA: blockMetric(blocks, (block) => humanBlockDelta(block, axis)),
        },
      ]),
    ),
    objectiveArmBMinusA: {
      attemptedTurns: blockMetric(blocks, (block) => blockDelta(block, (item) => item.trigger.attemptedTurns)),
      respondedTurns: blockMetric(blocks, (block) => blockDelta(block, (item) => item.trigger.respondedTurns)),
      yieldedTurns: blockMetric(blocks, (block) => blockDelta(block, (item) => item.trigger.yieldedTurns)),
      deliveredBursts: blockMetric(blocks, (block) =>
        blockDelta(block, (item) => item.trigger.confirmedDeliveredBursts),
      ),
      requiredPromptsWithoutVisibleReply: blockMetric(blocks, (block) =>
        blockDelta(block, (item) =>
          Number(item.trigger.requiredTargetCount > 0 && item.trigger.confirmedDeliveredBursts === 0),
        ),
      ),
      optionalPromptsWithoutVisibleReply: blockMetric(blocks, (block) =>
        blockDelta(block, (item) =>
          Number(item.trigger.requiredTargetCount === 0 && item.trigger.confirmedDeliveredBursts === 0),
        ),
      ),
      actorEstimatedCostUsd: blockMetric(blocks, (block) =>
        blockDelta(block, (item) =>
          item.trigger.actor.provenance === "step-fields-v1" && item.trigger.actor.coverage === "reported"
            ? item.trigger.actor.costUsd
            : null,
        ),
      ),
      jevReportedCostUsd: blockMetric(blocks, (block) =>
        blockDelta(block, (item) =>
          item.trigger.jev.outcome === "completed"
            ? item.trigger.jev.costUsd
            : item.trigger.variant === "jev-off"
              ? 0
              : null,
        ),
      ),
      judgeReportedCostUsd: blockMetric(blocks, (block) => blockDelta(block, judgeCostForBlock)),
      openCodeObservedTotalTokens: blockMetric(blocks, (block) =>
        blockDelta(block, (item) =>
          item.trigger.actor.provenance === "step-fields-v1" && item.trigger.actor.totalTokenCoverage === "reported"
            ? item.trigger.actor.totalTokens
            : null,
        ),
      ),
      meanFirstVisibleMsPerTrigger: blockMetric(blocks, (block) =>
        blockDelta(block, (item) => item.trigger.firstVisibleMs, "mean"),
      ),
    },
  });
  const contrastGroups = new Map<string, Block[]>();
  for (const block of structurallyMatchedBlocks) {
    const key = `${block.factor}:${block.contrastId}`;
    contrastGroups.set(key, [...(contrastGroups.get(key) ?? []), block]);
  }
  const byStratum = [...contrastGroups.values()]
    .flatMap((contrastBlocks) => {
      const strata = new Map<string, Block[]>();
      for (const block of contrastBlocks) strata.set(block.stratumId, [...(strata.get(block.stratumId) ?? []), block]);
      return [...strata.values()].map((stratumBlocks) => ({
        factor: stratumBlocks[0]!.factor,
        contrastId: stratumBlocks[0]!.contrastId,
        stratumId: stratumBlocks[0]!.stratumId,
        dynamic: stratumBlocks[0]!.dynamic,
        arcProfileId: stratumBlocks[0]!.arcProfileId,
        agentCount: stratumBlocks[0]!.agentCount,
        energy: stratumBlocks[0]!.energy,
        paired: blockReadout(stratumBlocks),
      }));
    })
    .sort((left, right) =>
      `${left.factor}:${left.contrastId}:${left.stratumId}`.localeCompare(
        `${right.factor}:${right.contrastId}:${right.stratumId}`,
      ),
    );
  const byFactorBlocks = Object.fromEntries(
    (["jev", "gate", "agent-prompt"] as const).map((factor) => {
      const requestedBlocks = [...group.values()].filter((rows) => rows[0]?.study?.factor === factor).length;
      const factorBlocks = structurallyMatchedBlocks.filter((block) => block.factor === factor);
      const contrasts = [...contrastGroups.values()]
        .filter((blocks) => blocks[0]?.factor === factor)
        .map((blocks) => ({
          contrastId: blocks[0]!.contrastId,
          armA: blocks[0]!.armA,
          armB: blocks[0]!.armB,
          paired: blockReadout(blocks),
        }))
        .sort((left, right) => left.contrastId.localeCompare(right.contrastId));
      return [factor, { requestedBlocks, structurallyMatchedBlocks: factorBlocks.length, contrasts }];
    }),
  );
  const availabilityCoverage = (rows: typeof manifest.cases) => {
    const observed = rows.flatMap((row) => (row.availabilityCheck ? [row.availabilityCheck] : []));
    return {
      completedCases: rows.length,
      checksRecorded: observed.length,
      legacyMissingChecks: rows.length - observed.length,
      initiallyUnavailable: observed.filter((check) => check.initialUnavailableReasons.length > 0).length,
      refreshAttempted: observed.filter((check) => check.refreshAttempted).length,
      recovered: observed.filter((check) => check.recovered).length,
      finallyUnavailable: observed.filter((check) => check.finalUnavailableReasons.length > 0).length,
      initialDiscoveryStatuses: Object.fromEntries(
        DISCOVERY_STATUSES.map((status) => [
          status,
          observed.filter((check) => check.initialDiscoveryStatus === status).length,
        ]),
      ),
      finalDiscoveryStatuses: Object.fromEntries(
        DISCOVERY_STATUSES.map((status) => [
          status,
          observed.filter((check) => check.finalDiscoveryStatus === status).length,
        ]),
      ),
    };
  };
  const attributionCoverage = (rows: typeof all) => {
    const recorded = rows.flatMap(({ trigger }) => (trigger.noVisibleAttributionV1 ? [trigger] : []));
    return {
      observedTriggers: rows.length,
      recordedTriggers: recorded.length,
      legacyMissingTriggers: rows.length - recorded.length,
      categories: Object.fromEntries(
        ATTRIBUTION_CATEGORIES.map((category) => [
          category,
          recorded.filter((trigger) => trigger.noVisibleAttributionV1?.category === category).length,
        ]),
      ),
      generationCategories: Object.fromEntries(
        GENERATION_CATEGORIES.map((category) => [
          category,
          recorded.reduce(
            (sum, trigger) =>
              sum +
              trigger.noVisibleAttributionV1!.generations.filter((generation) => generation.category === category)
                .length,
            0,
          ),
        ]),
      ),
      requiredNoVisible: recorded.filter(
        (trigger) => trigger.requiredTargetCount > 0 && trigger.confirmedDeliveredBursts === 0,
      ).length,
      optionalNoVisible: recorded.filter(
        (trigger) => trigger.requiredTargetCount === 0 && trigger.confirmedDeliveredBursts === 0,
      ).length,
    };
  };
  const blockWarnings = byStratum.flatMap((stratum) =>
    stratum.paired.routingEligibleBlocks < 5
      ? [
          {
            code: stratum.paired.routingEligibleBlocks === 0 ? "no-eligible-blocks" : "small-cell",
            factor: stratum.factor,
            contrastId: stratum.contrastId,
            stratumId: stratum.stratumId,
          },
        ]
      : [],
  );
  for (const factor of ["jev", "gate", "agent-prompt"] as const) {
    if (byFactorBlocks[factor]?.requestedBlocks === 0)
      blockWarnings.push({ code: "missing-factor", factor, contrastId: "", stratumId: "" });
    const contrasts = byFactorBlocks[factor]?.contrasts ?? [];
    if (contrasts.length > 1) {
      const stratumIds = new Set(byStratum.filter((row) => row.factor === factor).map((row) => row.stratumId));
      for (const contrast of contrasts) {
        const present = new Set(
          byStratum
            .filter((row) => row.factor === factor && row.contrastId === contrast.contrastId)
            .map((row) => row.stratumId),
        );
        for (const stratumId of stratumIds)
          if (!present.has(stratumId))
            blockWarnings.push({ code: "non-overlapping-cell", factor, contrastId: contrast.contrastId, stratumId });
      }
    }
  }
  return {
    schemaVersion: 2 as const,
    kind: "conversation-routing-live-study-analysis" as const,
    source: {
      commit: manifest.sourceCommit,
      digest: manifest.sourceSha256,
      openCodeVersion: manifest.openCodeVersion,
      actorModelRequested: manifest.actorModel,
      jevModelRequested: manifest.studyPlan.jevModel,
      judgeModelRequested: manifest.judgeModel,
    },
    plan: { id: manifest.studyPlan.planId, digest: manifest.studyPlan.planSha256 },
    availability: {
      overall: availabilityCoverage(manifest.cases),
      byFactorAndArm: Object.fromEntries(
        (["jev", "gate", "agent-prompt"] as const).flatMap((factor) =>
          (["a", "b"] as const).map((arm) => [
            `${factor}:${arm}`,
            availabilityCoverage(
              manifest.cases.filter((row) => row.study!.factor === factor && row.study!.arm === arm),
            ),
          ]),
        ),
      ),
      limitation:
        "Only completed final-manifest cases are counted; failed case-progress events remain separate and are never imputed as completed study pairs.",
    },
    noVisibleAttributionV1: {
      schemaVersion: 1 as const,
      overall: attributionCoverage(all),
      required: attributionCoverage(all.filter(({ trigger }) => trigger.requiredTargetCount > 0)),
      optional: attributionCoverage(all.filter(({ trigger }) => trigger.requiredTargetCount === 0)),
      byFactorAndArm: Object.fromEntries(
        (["jev", "gate", "agent-prompt"] as const).flatMap((factor) =>
          (["a", "b"] as const).map((arm) => [
            `${factor}:${arm}`,
            attributionCoverage(
              all.filter(({ caseRow }) => caseRow.study!.factor === factor && caseRow.study!.arm === arm),
            ),
          ]),
        ),
      ),
      limitation:
        "Recorded categories describe persisted routing and generation evidence; completed-no-delivery and mixed cases do not establish why no reply appeared. Missing legacy evidence is not imputed.",
    },
    denominators: {
      cases: manifest.cases.length,
      blocks: new Set(manifest.cases.map((row) => `${row.study!.blockId}\u0000${row.study!.replicateId}`)).size,
      triggers: all.length,
      requestedCasePairs: group.size,
      matchedCasePairs,
      excludedCasePairs,
      matchedTriggerPairs: pairs.length,
      excludedTriggerPairsModelUnknown,
      excludedTriggerPairsModelMismatch,
      excludedTriggerPairsJevIncomplete,
      jevCompletedTriggers: all.filter((item) => item.trigger.jev.outcome === "completed").length,
      jevFailedTriggers: all.filter((item) => item.trigger.jev.outcome === "failed").length,
      jevSkippedTriggers: all.filter((item) => item.trigger.jev.outcome === "skipped").length,
      jevNotConsultedTriggers: all.filter((item) => item.trigger.jev.outcome === "not-consulted").length,
    },
    blocks: [...group.entries()].map(([pairId, rows]) => ({
      pairId,
      blockId: rows[0]!.study!.blockId,
      replicateId: rows[0]!.study!.replicateId,
      factor: rows[0]!.study!.factor,
      cases: rows.length,
      triggers: rows.reduce((sum, row) => sum + row.triggers.length, 0),
      matched: rows.length === 2 && pairs.some((pair) => pair.pairId === pairId),
      paired: pairedReadout(pairs.filter((pair) => pair.pairId === pairId)),
    })),
    byFactor: Object.fromEntries(
      (["jev", "gate", "agent-prompt"] as const).map((factor) => {
        const cases = manifest.cases.filter((row) => row.study!.factor === factor);
        const selectedPairs = pairs.filter((pair) => pair.a.caseRow.study!.factor === factor);
        return [
          factor,
          {
            cases: cases.length,
            blocks: new Set(cases.map((row) => `${row.study!.blockId}\u0000${row.study!.replicateId}`)).size,
            triggers: cases.reduce((sum, row) => sum + row.triggers.length, 0),
            paired: pairedReadout(selectedPairs),
          },
        ];
      }),
    ),
    blockLevelV1: {
      schemaVersion: 1 as const,
      unit: "matched-room-pair" as const,
      byFactor: byFactorBlocks,
      byStratum,
      warnings: blockWarnings,
      interpretation:
        "Descriptive block-paired differences only. Every complete room pair has equal weight; correlated trigger turns are aggregated within its block. Missing metrics never become zero, and there is no pooled cross-contrast winner or inferential p-value.",
    },
    triggerObservations: all.map((item) => ({
      scenarioId: item.trigger.scenarioId,
      runId: item.trigger.runId,
      pairId: item.caseRow.study!.pairId,
      arm: item.caseRow.study!.arm,
      ordinal: item.ordinal,
      attemptedTurns: item.trigger.attemptedTurns,
      respondedTurns: item.trigger.respondedTurns,
      yieldedTurns: item.trigger.yieldedTurns,
      deliveredBursts: item.trigger.confirmedDeliveredBursts,
      axes: Object.fromEntries(
        QUALITY_AXES.map((axis) => {
          const result = outcome(item, axis);
          return [
            axis,
            result?.status === "completed"
              ? { status: result.result.status, score: result.result.score }
              : { status: result?.status ?? "missing", score: null },
          ];
        }),
      ),
    })),
    axes,
    resources: {
      actorEstimatedCostUsd: metric((item) =>
        item.trigger.actor.provenance === "step-fields-v1" && item.trigger.actor.coverage === "reported"
          ? item.trigger.actor.costUsd
          : null,
      ),
      jevReportedCostUsd: metric((item) =>
        item.trigger.jev.outcome === "completed"
          ? item.trigger.jev.costUsd
          : item.trigger.variant === "jev-off"
            ? 0
            : null,
      ),
      judgeReportedCostUsd: metric(judgeCost),
      judgeReportedAxisCostUsd: {
        totalAxes: judgeAxisCosts.length,
        reportedAxes: reportedAxisCosts.length,
        knownNoCallAxes,
        unresolvedCostAxes: judgeAxisCosts.length - reportedAxisCosts.length - knownNoCallAxes,
        reportedTotalUsd: reportedAxisCosts.length ? reportedAxisCosts.reduce((sum, value) => sum + value, 0) : null,
      },
      openCodeObservedTotalTokens: metric((item) =>
        item.trigger.actor.provenance === "step-fields-v1" && item.trigger.actor.totalTokenCoverage === "reported"
          ? item.trigger.actor.totalTokens
          : null,
      ),
      firstVisibleMs: metric((item) => item.trigger.firstVisibleMs),
    },
    spotChecks: selected.map((item) => ({
      scenarioId: item.trigger.scenarioId,
      runId: item.trigger.runId,
      priority:
        rank(item) === 4
          ? "discordant"
          : rank(item) === 3
            ? "unassessable-or-failed"
            : rank(item) === 2
              ? "low-score"
              : "seeded-control",
    })),
    limitations:
      "Four independent judge axes are model judgments, not factual verification. Missing and failed axes are separate. A/B differences are observed within matched fictional cases, not causal claims. Multi-trigger arcs carry earlier conversation history, so trigger-level observations are correlated. Actor cost is OpenCode-estimated; Jev and judge cost are provider-reported separately. Provider-resolved actor identity is unavailable and never inferred. Human spot checks remain a separate sample.",
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
  if (manifest.judgeRubric === "v2")
    return {
      schemaVersion: 2 as const,
      ratings: manifest.cases.flatMap((row) =>
        row.triggers.map(({ scenarioId, runId }) => ({ scenarioId, runId, axes: {} })),
      ),
    };
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
      if (manifestPaths.length >= MAX_STUDY_PAIRS) throw new Error("Invalid analysis invocation.");
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
  const rawRatings = values.has("--ratings") ? await readBounded(values.get("--ratings")!) : undefined;
  const maxSpotChecks = values.has("--spot-checks") ? Number(values.get("--spot-checks")) : 4;
  if (!Number.isSafeInteger(maxSpotChecks) || maxSpotChecks < 0 || maxSpotChecks > 12)
    throw new Error("Invalid analysis invocation.");
  process.stdout.write(
    `${JSON.stringify(template ? privateRatingTemplate(manifest) : manifest.judgeRubric === "v2" ? analyzeQualityStudy(manifest, rawRatings === undefined ? [] : parsePrivateQualityRatings(rawRatings), { ...(values.has("--seed") ? { seed: values.get("--seed")! } : {}), maxSpotChecks }) : analyzeConversationCanary(manifest, rawRatings === undefined ? [] : parsePrivateConversationRatings(rawRatings), { ...(values.has("--seed") ? { seed: values.get("--seed")! } : {}), maxSpotChecks }), null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Invalid or unavailable scalar canary analysis input.\n");
    process.exitCode = 1;
  });
}
