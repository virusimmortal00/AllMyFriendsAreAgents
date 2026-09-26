/** Private judgments for a live room evaluation. This module never retains review text. */
import { QUALITY_AXES, type QualityAxis } from "./conversation-routing-live-judge-v2.js";

const MAX_RATINGS = 500;
const MAX_PAIRS = 250;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;

type Unrated = { status: "not_applicable" | "not_assessable" };
type Rating<T> = ({ status: "rated" } & T) | Unrated;

export interface ConversationRating {
  scenarioId: string;
  runId: string;
  directReply?: Rating<{ expectedTargets: number; missedTargets: number; humanCorrection: boolean }>;
  naturalness?: Rating<{ score: 1 | 2 | 3 | 4 | 5 }>;
  distinctValue?: Rating<{ assessedReplies: number; valuableReplies: number }>;
  replyWaste?: Rating<{ assessedReplies: number; unnecessaryReplies: number; duplicateReplies: number }>;
  handoff?: Rating<{ correct: boolean }>;
  closure?: Rating<{ correct: boolean }>;
}

export type QualityHumanAxisRating =
  | { status: "rated"; score: 1 | 2 | 3 | 4 | 5 }
  | { status: "not_applicable" | "not_assessable" };

export interface QualityHumanRating {
  scenarioId: string;
  runId: string;
  /** Empty or absent axes remain missing, never favorable scores. */
  axes: Partial<Record<QualityAxis, QualityHumanAxisRating>>;
}

export interface FrameHumanRating {
  scenarioId: string;
  runId: string;
  frame_integrity?: QualityHumanAxisRating;
}

/** Version 3 is independent of the four quality axes; missing is never a favorable score. */
export function parsePrivateFrameRatings(input: unknown): FrameHumanRating[] {
  const envelope = object(input, ["schemaVersion", "rubricVersion", "ratings"]);
  if (
    envelope.schemaVersion !== 3 ||
    envelope.rubricVersion !== "room-frame-integrity-v1" ||
    !Array.isArray(envelope.ratings) ||
    envelope.ratings.length > MAX_RATINGS
  )
    throw new Error("Invalid private frame rating input.");
  const rows = envelope.ratings.map((value: unknown): FrameHumanRating => {
    const row = object(value, ["scenarioId", "runId", "frame_integrity"]);
    if (!id(row.scenarioId) || !id(row.runId)) throw new Error("Invalid private frame rating input.");
    if (row.frame_integrity === undefined) return { scenarioId: row.scenarioId, runId: row.runId };
    const rating = object(row.frame_integrity, ["status", "score"]);
    if (rating.status === "rated") {
      if (Object.keys(rating).length !== 2 || !count(rating.score, 5) || rating.score < 1)
        throw new Error("Invalid private frame rating input.");
      return {
        scenarioId: row.scenarioId,
        runId: row.runId,
        frame_integrity: { status: "rated", score: rating.score as 1 | 2 | 3 | 4 | 5 },
      };
    }
    if (rating.status !== "not_assessable" || Object.keys(rating).length !== 1)
      throw new Error("Invalid private frame rating input.");
    return { scenarioId: row.scenarioId, runId: row.runId, frame_integrity: { status: "not_assessable" } };
  });
  if (new Set(rows.map((row) => `${row.scenarioId}\u0000${row.runId}`)).size !== rows.length)
    throw new Error("Invalid private frame rating input.");
  return rows;
}

/** Only fields already projected by the live collector may cross into comparison. */
export interface ObservedConversationRun {
  scenarioId: string;
  runId: string;
  reportedCostUsd: number | null;
  /** Cost is comparable only if every observed generation reported cost. */
  usageCoverage: "reported" | "partial" | "missing";
  firstVisibleMs: number | null;
}

export interface ConversationRunPair {
  scenarioId: string;
  baselineRunId: string;
  candidateRunId: string;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid private rating input.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("Invalid private rating input.");
  return record;
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function count(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function rating<T extends Record<string, unknown>>(
  value: unknown,
  fields: readonly string[],
  validate: (entry: Record<string, unknown>) => T,
): Rating<T> | undefined {
  if (value === undefined) return undefined;
  const entry = object(value, ["status", ...fields]);
  if (entry.status === "not_applicable" || entry.status === "not_assessable") {
    if (Object.keys(entry).length !== 1) throw new Error("Invalid private rating input.");
    return { status: entry.status };
  }
  if (entry.status !== "rated" || fields.some((field) => !(field in entry)))
    throw new Error("Invalid private rating input.");
  return { status: "rated", ...validate(entry) };
}

function parseRating(value: unknown): ConversationRating {
  const row = object(value, [
    "scenarioId",
    "runId",
    "privateNote",
    "directReply",
    "naturalness",
    "distinctValue",
    "replyWaste",
    "handoff",
    "closure",
  ]);
  if (
    !id(row.scenarioId) ||
    !id(row.runId) ||
    (row.privateNote !== undefined && (typeof row.privateNote !== "string" || row.privateNote.length > 1_000))
  ) {
    throw new Error("Invalid private rating input.");
  }
  const directReply = rating(row.directReply, ["expectedTargets", "missedTargets", "humanCorrection"], (entry) => {
    if (
      !count(entry.expectedTargets, 32) ||
      entry.expectedTargets === 0 ||
      !count(entry.missedTargets, entry.expectedTargets) ||
      typeof entry.humanCorrection !== "boolean"
    )
      throw new Error("Invalid private rating input.");
    return {
      expectedTargets: entry.expectedTargets,
      missedTargets: entry.missedTargets,
      humanCorrection: entry.humanCorrection,
    };
  });
  const naturalness = rating(row.naturalness, ["score"], (entry) => {
    if (!count(entry.score, 5) || entry.score < 1) throw new Error("Invalid private rating input.");
    return { score: entry.score as 1 | 2 | 3 | 4 | 5 };
  });
  const distinctValue = rating(row.distinctValue, ["assessedReplies", "valuableReplies"], (entry) => {
    if (
      !count(entry.assessedReplies, 32) ||
      entry.assessedReplies === 0 ||
      !count(entry.valuableReplies, entry.assessedReplies)
    )
      throw new Error("Invalid private rating input.");
    return { assessedReplies: entry.assessedReplies, valuableReplies: entry.valuableReplies };
  });
  const replyWaste = rating(row.replyWaste, ["assessedReplies", "unnecessaryReplies", "duplicateReplies"], (entry) => {
    if (
      !count(entry.assessedReplies, 32) ||
      entry.assessedReplies === 0 ||
      !count(entry.unnecessaryReplies, entry.assessedReplies) ||
      !count(entry.duplicateReplies, entry.assessedReplies)
    )
      throw new Error("Invalid private rating input.");
    return {
      assessedReplies: entry.assessedReplies,
      unnecessaryReplies: entry.unnecessaryReplies,
      duplicateReplies: entry.duplicateReplies,
    };
  });
  const booleanRating = (value: unknown) =>
    rating(value, ["correct"], (entry) => {
      if (typeof entry.correct !== "boolean") throw new Error("Invalid private rating input.");
      return { correct: entry.correct };
    });
  const handoff = booleanRating(row.handoff);
  const closure = booleanRating(row.closure);
  return {
    scenarioId: row.scenarioId,
    runId: row.runId,
    ...(directReply === undefined ? {} : { directReply }),
    ...(naturalness === undefined ? {} : { naturalness }),
    ...(distinctValue === undefined ? {} : { distinctValue }),
    ...(replyWaste === undefined ? {} : { replyWaste }),
    ...(handoff === undefined ? {} : { handoff }),
    ...(closure === undefined ? {} : { closure }),
  };
}

/** Closed input; privateNote is deliberately discarded before this function returns. */
export function parsePrivateConversationRatings(input: unknown): ConversationRating[] {
  const envelope = object(input, ["schemaVersion", "ratings"]);
  if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.ratings) || envelope.ratings.length > MAX_RATINGS)
    throw new Error("Invalid private rating input.");
  const rows = envelope.ratings.map(parseRating);
  const keys = rows.map((row) => `${row.scenarioId}\u0000${row.runId}`);
  if (new Set(keys).size !== keys.length) throw new Error("Invalid private rating input.");
  return rows;
}

/** Closed blinded-axis ratings; optional privateNote is discarded before export. */
export function parsePrivateQualityRatings(input: unknown): QualityHumanRating[] {
  const envelope = object(input, ["schemaVersion", "ratings"]);
  if (envelope.schemaVersion !== 2 || !Array.isArray(envelope.ratings) || envelope.ratings.length > MAX_RATINGS)
    throw new Error("Invalid private quality rating input.");
  const rows: QualityHumanRating[] = envelope.ratings.map((value: unknown) => {
    const row = object(value, ["scenarioId", "runId", "axes", "privateNote"]);
    if (
      !id(row.scenarioId) ||
      !id(row.runId) ||
      (row.privateNote !== undefined && (typeof row.privateNote !== "string" || row.privateNote.length > 1_000))
    )
      throw new Error("Invalid private quality rating input.");
    const axes = object(row.axes, QUALITY_AXES);
    const parsed: QualityHumanRating["axes"] = {};
    for (const axis of QUALITY_AXES) {
      if (!(axis in axes)) continue;
      const rating = object(axes[axis], ["status", "score"]);
      if (rating.status === "rated") {
        if (Object.keys(rating).length !== 2 || !count(rating.score, 5) || rating.score < 1)
          throw new Error("Invalid private quality rating input.");
        parsed[axis] = { status: "rated", score: rating.score as 1 | 2 | 3 | 4 | 5 };
      } else if (
        (rating.status === "not_applicable" || rating.status === "not_assessable") &&
        Object.keys(rating).length === 1
      ) {
        parsed[axis] = { status: rating.status };
      } else {
        throw new Error("Invalid private quality rating input.");
      }
    }
    return { scenarioId: row.scenarioId, runId: row.runId, axes: parsed };
  });
  if (new Set(rows.map((row) => `${row.scenarioId}\u0000${row.runId}`)).size !== rows.length)
    throw new Error("Invalid private quality rating input.");
  return rows;
}

type MetricName = "directReply" | "naturalness" | "distinctValue" | "replyWaste" | "handoff" | "closure";
const METRICS: readonly MetricName[] = [
  "directReply",
  "naturalness",
  "distinctValue",
  "replyWaste",
  "handoff",
  "closure",
];
const key = (scenarioId: string, runId: string) => `${scenarioId}\u0000${runId}`;

function coverage(rows: readonly ConversationRating[], metric: MetricName) {
  return {
    ratedRuns: rows.filter((row) => row[metric]?.status === "rated").length,
    notApplicableRuns: rows.filter((row) => row[metric]?.status === "not_applicable").length,
    notAssessableRuns: rows.filter((row) => row[metric]?.status === "not_assessable").length,
    missingRuns: rows.filter((row) => row[metric] === undefined).length,
  };
}

const rated = <T extends Record<string, unknown>>(
  value: Rating<T> | undefined,
): (T & { status: "rated" }) | undefined => (value?.status === "rated" ? value : undefined);

/** No transcript, note, prompt, URL, credential, or raw provider response can enter this scalar export. */
export function summarizeConversationRatings(
  ratings: readonly ConversationRating[],
  observations: readonly ObservedConversationRun[] = [],
  pairs: readonly ConversationRunPair[] = [],
) {
  if (ratings.length > MAX_RATINGS || observations.length > MAX_RATINGS || pairs.length > MAX_PAIRS)
    throw new Error("Invalid rating comparison.");
  ratings = parsePrivateConversationRatings({ schemaVersion: 1, ratings });
  const byRating = new Map(ratings.map((row) => [key(row.scenarioId, row.runId), row]));
  const byObservation = new Map(observations.map((row) => [key(row.scenarioId, row.runId), row]));
  if (byRating.size !== ratings.length || byObservation.size !== observations.length)
    throw new Error("Invalid rating comparison.");
  for (const observation of observations) {
    if (
      !id(observation.scenarioId) ||
      !id(observation.runId) ||
      !["reported", "partial", "missing"].includes(observation.usageCoverage) ||
      (observation.reportedCostUsd !== null &&
        (typeof observation.reportedCostUsd !== "number" ||
          !Number.isFinite(observation.reportedCostUsd) ||
          observation.reportedCostUsd < 0 ||
          observation.reportedCostUsd > 1_000)) ||
      (observation.firstVisibleMs !== null && !count(observation.firstVisibleMs, 3_600_000)) ||
      (observation.usageCoverage === "reported" && observation.reportedCostUsd === null)
    )
      throw new Error("Invalid rating comparison.");
  }
  const judged = <T extends Record<string, unknown>>(metric: MetricName): T[] =>
    ratings.flatMap((row) => {
      const value = rated(row[metric]);
      return value ? [value as unknown as T] : [];
    });
  const direct = judged<{ expectedTargets: number; missedTargets: number; humanCorrection: boolean }>("directReply");
  const natural = judged<{ score: number }>("naturalness");
  const distinct = judged<{ assessedReplies: number; valuableReplies: number }>("distinctValue");
  const waste = judged<{ assessedReplies: number; unnecessaryReplies: number; duplicateReplies: number }>("replyWaste");
  const handoff = judged<{ correct: boolean }>("handoff");
  const closure = judged<{ correct: boolean }>("closure");
  const sum = <T>(rows: readonly T[], select: (row: T) => number) =>
    rows.reduce((total, row) => total + select(row), 0);
  const delta = (values: number[]) => ({
    pairedRuns: values.length,
    candidateMinusBaselineMean: values.length ? sum(values, (value) => value) / values.length : null,
  });
  const naturalDeltas: number[] = [],
    costDeltas: number[] = [],
    latencyDeltas: number[] = [];
  let jointNaturalnessCostPairs = 0;
  const usedPairs = new Set<string>();
  for (const pair of pairs) {
    if (
      !id(pair.scenarioId) ||
      !id(pair.baselineRunId) ||
      !id(pair.candidateRunId) ||
      pair.baselineRunId === pair.candidateRunId
    )
      throw new Error("Invalid rating comparison.");
    const pairKey = `${pair.scenarioId}\u0000${pair.baselineRunId}\u0000${pair.candidateRunId}`;
    if (usedPairs.has(pairKey)) throw new Error("Invalid rating comparison.");
    usedPairs.add(pairKey);
    const baseline = byRating.get(key(pair.scenarioId, pair.baselineRunId));
    const candidate = byRating.get(key(pair.scenarioId, pair.candidateRunId));
    const baselineObserved = byObservation.get(key(pair.scenarioId, pair.baselineRunId));
    const candidateObserved = byObservation.get(key(pair.scenarioId, pair.candidateRunId));
    const first = rated(baseline?.naturalness),
      second = rated(candidate?.naturalness);
    if (first && second) naturalDeltas.push(second.score - first.score);
    const coveredCost =
      baselineObserved?.usageCoverage === "reported" && candidateObserved?.usageCoverage === "reported";
    if (coveredCost && baselineObserved.reportedCostUsd !== null && candidateObserved.reportedCostUsd !== null) {
      costDeltas.push(candidateObserved.reportedCostUsd - baselineObserved.reportedCostUsd);
      if (first && second) jointNaturalnessCostPairs++;
    }
    if (
      baselineObserved?.firstVisibleMs !== null &&
      baselineObserved?.firstVisibleMs !== undefined &&
      candidateObserved?.firstVisibleMs !== null &&
      candidateObserved?.firstVisibleMs !== undefined
    ) {
      latencyDeltas.push(candidateObserved.firstVisibleMs - baselineObserved.firstVisibleMs);
    }
  }
  return {
    schemaVersion: 1 as const,
    runs: ratings.length,
    coverage: Object.fromEntries(METRICS.map((metric) => [metric, coverage(ratings, metric)])) as Record<
      MetricName,
      ReturnType<typeof coverage>
    >,
    directReply: {
      expectedTargets: sum(direct, (row) => row.expectedTargets),
      missedTargets: sum(direct, (row) => row.missedTargets),
      humanCorrections: direct.filter((row) => row.humanCorrection).length,
    },
    naturalness: { meanScore: natural.length ? sum(natural, (row) => row.score) / natural.length : null },
    distinctValue: {
      assessedReplies: sum(distinct, (row) => row.assessedReplies),
      valuableReplies: sum(distinct, (row) => row.valuableReplies),
    },
    replyWaste: {
      assessedReplies: sum(waste, (row) => row.assessedReplies),
      unnecessaryReplies: sum(waste, (row) => row.unnecessaryReplies),
      duplicateReplies: sum(waste, (row) => row.duplicateReplies),
    },
    handoff: { correctRuns: handoff.filter((row) => row.correct).length },
    closure: { correctRuns: closure.filter((row) => row.correct).length },
    paired: {
      requestedPairs: pairs.length,
      naturalness: delta(naturalDeltas),
      reportedCostUsd: delta(costDeltas),
      firstVisibleMs: delta(latencyDeltas),
      naturalnessAndReportedCostPairs: jointNaturalnessCostPairs,
    },
    limitation:
      "Human ratings apply only to reviewed output. Provider cost is compared only when both observed runs report every generation; uninvoked replies and unreported usage are unknown.",
  };
}
