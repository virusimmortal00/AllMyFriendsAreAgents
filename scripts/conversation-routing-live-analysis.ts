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
interface ScalarTrigger {
  scenarioId: string;
  runId: string;
  variant: Variant;
  actor: {
    inputTokens: number | null;
    outputTokens: number | null;
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
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    coverage: "reported" | "partial" | "missing";
  };
}
export interface ScalarCanaryManifest {
  sourceCommit: string;
  sourceDirty: boolean;
  sourceSha256: string;
  scenarioCatalogSha256: string;
  actorModel: string;
  judgeModel: string | null;
  cases: Array<{ scenarioId: string; variant: Variant; triggers: ScalarTrigger[]; judge: JudgeScalarResult[] }>;
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
        "reportedCostUsd",
        "usageCoverage",
      ]);
      if (
        trigger.schemaVersion !== 1 ||
        !id(trigger.scenarioId) ||
        trigger.variant !== row.variant ||
        !id(trigger.runId) ||
        !["reported", "partial", "missing"].includes(String(trigger.usageCoverage)) ||
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
        inputTokens: nullableInteger(trigger.reportedInputTokens, 1_000_000_000),
        outputTokens: nullableInteger(trigger.reportedOutputTokens, 1_000_000_000),
        costUsd: nullableNumber(trigger.reportedCostUsd, 1_000),
        coverage: trigger.usageCoverage as ScalarTrigger["actor"]["coverage"],
      };
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
        actor.coverage === "reported" &&
        actor.inputTokens !== null &&
        actor.outputTokens !== null &&
        actor.costUsd !== null &&
        jevComplete;
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
          inputTokens: complete ? actor.inputTokens! + (noJev ? 0 : jev.inputTokens!) : null,
          outputTokens: complete ? actor.outputTokens! + (noJev ? 0 : jev.outputTokens!) : null,
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
    return { scenarioId: row.scenarioId as string, variant: row.variant as Variant, triggers, judge };
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
    scenarioCatalogSha256: top.scenarioCatalogSha256,
    actorModel: top.actorModel,
    judgeModel: top.judgeModel,
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
      return [
        variant,
        {
          runs: rows.length,
          jevCompleted: rows.filter((row) => row.jev.outcome === "completed").length,
          actorCostUsd: aggregate(rows.map((row) => (row.actor.coverage === "reported" ? row.actor.costUsd : null))),
          actorPlusJevInputTokens: aggregate(rows.map((row) => row.combined.inputTokens)),
          actorPlusJevOutputTokens: aggregate(rows.map((row) => row.combined.outputTokens)),
          jevCostUsd: aggregate(
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
          actorPlusJevCostUsd: aggregate(rows.map((row) => row.combined.costUsd)),
          judgeNaturalness: {
            ratedRuns: rated.length,
            unassessableRuns: judged.length - rated.length,
            missingRuns: rows.length - judged.length,
            meanScore: mean(rated.map((row) => row.naturalness!)),
          },
          judgeCostUsd: aggregate(judged.map((row) => row.judgeUsage.reportedCostUsd)),
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
  const actorJevInput: number[] = [],
    actorJevOutput: number[] = [],
    judgeNaturalness: number[] = [];
  const jointJudgeNaturalness: number[] = [],
    jointActorJevCost: number[] = [];
  const jointHumanNaturalness: number[] = [],
    jointHumanActorJevCost: number[] = [];
  for (const pair of pairs) {
    const a = triggers.find((row) => row.scenarioId === pair.scenarioId && row.runId === pair.baselineRunId)!;
    const b = triggers.find((row) => row.scenarioId === pair.scenarioId && row.runId === pair.candidateRunId)!;
    if (a.combined.inputTokens !== null && b.combined.inputTokens !== null)
      actorJevInput.push(b.combined.inputTokens - a.combined.inputTokens);
    if (a.combined.outputTokens !== null && b.combined.outputTokens !== null)
      actorJevOutput.push(b.combined.outputTokens - a.combined.outputTokens);
    const jA = judges.get(`${pair.scenarioId}\u0000${pair.baselineRunId}`);
    const jB = judges.get(`${pair.scenarioId}\u0000${pair.candidateRunId}`);
    if (jA?.status === "rated" && jB?.status === "rated") {
      const naturalnessDelta = jB.naturalness! - jA.naturalness!;
      judgeNaturalness.push(naturalnessDelta);
      if (a.combined.costUsd !== null && b.combined.costUsd !== null) {
        jointJudgeNaturalness.push(naturalnessDelta);
        jointActorJevCost.push(b.combined.costUsd - a.combined.costUsd);
      }
    }
    const hA = humanRatings.get(`${pair.scenarioId}\u0000${pair.baselineRunId}`)?.naturalness;
    const hB = humanRatings.get(`${pair.scenarioId}\u0000${pair.candidateRunId}`)?.naturalness;
    if (
      hA?.status === "rated" &&
      hB?.status === "rated" &&
      a.combined.costUsd !== null &&
      b.combined.costUsd !== null
    ) {
      jointHumanNaturalness.push(hB.score - hA.score);
      jointHumanActorJevCost.push(b.combined.costUsd - a.combined.costUsd);
    }
  }
  const costAndLatency = summarizeConversationRatings([], observations, pairs).paired;
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
      scenarioCatalogDigest: manifest.scenarioCatalogSha256,
    },
    runs: triggers.length,
    matchedPairs: pairs.length,
    variants,
    judgeOnly: {
      judgedRuns: judgments.length,
      missingRuns: triggers.length - judgments.length,
      pairedNaturalness: delta(judgeNaturalness),
      naturalnessAndReportedCost: {
        pairedRuns: jointJudgeNaturalness.length,
        naturalness: delta(jointJudgeNaturalness),
        actorPlusJevCostUsd: delta(jointActorJevCost),
      },
    },
    humanRated: human
      ? {
          ...human,
          naturalnessAndReportedCost: {
            pairedRuns: jointHumanNaturalness.length,
            naturalness: delta(jointHumanNaturalness),
            actorPlusJevCostUsd: delta(jointHumanActorJevCost),
          },
        }
      : null,
    humanReviewCoverage,
    pairedActorPlusJev: {
      reportedCostUsd: costAndLatency.reportedCostUsd,
      inputTokens: delta(actorJevInput),
      outputTokens: delta(actorJevOutput),
      firstVisibleMs: costAndLatency.firstVisibleMs,
    },
    spotChecks,
    limitations:
      "Judge scores are model judgments; human ratings have separate denominators. Cost/token comparisons require complete actor and Jev reports on both matched runs. Judge cost is separate. Uninvoked replies and missing usage are unknown; small matched cases do not prove causality.",
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
  let template = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--template") {
      if (template) throw new Error("Invalid analysis invocation.");
      template = true;
      continue;
    }
    if (!["--manifest", "--ratings", "--seed", "--spot-checks"].includes(arg) || !args[i + 1] || values.has(arg))
      throw new Error("Invalid analysis invocation.");
    values.set(arg, args[++i]!);
  }
  const manifestPath = values.get("--manifest");
  if (!manifestPath || (template && values.has("--ratings"))) throw new Error("Invalid analysis invocation.");
  const manifest = parseScalarCanaryManifest(await readBounded(manifestPath));
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
