/** Private, offline human review. Raw fictional room text stays in the generated 0600 pack. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeScalarCanaryManifests, parseScalarCanaryManifest } from "./conversation-routing-live-analysis.js";
import {
  type FrameHumanRating,
  parsePrivateFrameRatings,
  parsePrivateQualityRatings,
  type QualityHumanRating,
} from "./conversation-routing-live-annotations.js";
import { QUALITY_AXES, type QualityAxis } from "./conversation-routing-live-judge-v2.js";

const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const REVIEW_ID = /^review-[a-f0-9]{12}$/;
const MAX_REVIEWS = 48;
const MAX_INPUT_BYTES = 4_000_000;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AXIS_LABELS: Record<QualityAxis, string> = {
  social_cadence: "Social cadence",
  length_fit: "Length fit",
  address_radius: "Address radius",
  contribution_value: "Contribution value",
};
const AXIS_ANCHORS: Record<QualityAxis, string> = {
  social_cadence: "1 flat or disruptive · 3 coherent but ordinary · 5 smoothly responsive",
  length_fit: "1 missing or rambling · 3 minor mismatch · 5 sufficient and concise; fitting silence counts",
  address_radius: "1 wrong recipient · 3 mixed audience · 5 addresses the right people",
  contribution_value: "1 filler or repeat · 3 some value · 5 distinct knowledge or fitting entertainment",
};
const FRAME_AXIS = "frame_integrity" as const;
const FRAME_LABELS = { frame_integrity: "Frame integrity" };
const FRAME_ANCHORS = {
  frame_integrity:
    "1 rejects the room frame or amplifies a break · 3 leaks private setup or process · 5 stays within the room task",
};

export interface PrivateReviewQueue {
  schemaVersion: 1;
  reviewIds: string[];
}
export interface PrivateReviewLocator {
  schemaVersion: 1;
  manifestFingerprint?: string;
  entries: Array<{ reviewId: string; scenarioId: string; runId: string; sourceFile: string; priority: string }>;
}
export interface OfflineReviewBundle {
  schemaVersion: 1;
  reviewId: string;
  scenarioKind: string;
  expectedDirectAgents: string[];
  prompt: string;
  messages: Array<{ speaker: string; kind: "human" | "agent"; text: string }>;
  qualityContext: { originalHumanAlias: string; roster: Array<{ agentId: string; conversationalName: string }> };
}
export interface OfflineReviewExport {
  schemaVersion: 1;
  kind: "blinded-quality-ratings";
  packFingerprint: string;
  ratings: Array<{
    reviewId: string;
    axes: Partial<Record<QualityAxis, { status: "rated"; score: 1 | 2 | 3 | 4 | 5 } | { status: "not_assessable" }>>;
  }>;
}
export interface OfflineFrameExport {
  schemaVersion: 1;
  kind: "blinded-frame-ratings";
  packFingerprint: string;
  ratings: Array<{
    reviewId: string;
    axes: { frame_integrity?: { status: "rated"; score: 1 | 2 | 3 | 4 | 5 } | { status: "not_assessable" } };
  }>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid private review input.");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error("Invalid private review input.");
  return row;
}
function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}
function manifestFingerprint(input: unknown): string {
  const top = record(input);
  scalarRunKeys(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceSha256: top.sourceSha256 ?? null,
        studyPlan: top.studyPlan ?? null,
        cases: (top.cases as unknown[]).map((value) => {
          const room = record(value);
          return {
            scenarioId: room.scenarioId,
            study: room.study ?? null,
            triggers: (room.triggers as unknown[]).map((trigger) => {
              const row = record(trigger);
              return [row.scenarioId, row.runId];
            }),
          };
        }),
      }),
    )
    .digest("hex");
}

export function parseReviewQueue(input: unknown): PrivateReviewQueue {
  const row = exact(input, ["schemaVersion", "reviewIds"]);
  if (
    row.schemaVersion !== 1 ||
    !Array.isArray(row.reviewIds) ||
    row.reviewIds.length < 1 ||
    row.reviewIds.length > MAX_REVIEWS ||
    row.reviewIds.some((id) => typeof id !== "string" || !REVIEW_ID.test(id)) ||
    new Set(row.reviewIds).size !== row.reviewIds.length
  )
    throw new Error("Invalid private review input.");
  return { schemaVersion: 1, reviewIds: row.reviewIds as string[] };
}
export function parseReviewLocator(
  input: unknown,
  queue: PrivateReviewQueue | null,
  manifest: unknown,
): PrivateReviewLocator {
  const row = exact(input, ["schemaVersion", "manifestFingerprint", "entries"]);
  if (row.schemaVersion !== 1 || !Array.isArray(row.entries) || row.entries.length > 500)
    throw new Error("Invalid private review input.");
  const fingerprint = manifestFingerprint(manifest);
  const study = record(manifest).studyPlan;
  if (
    (study !== undefined && study !== null && row.manifestFingerprint !== fingerprint) ||
    (row.manifestFingerprint !== undefined && row.manifestFingerprint !== fingerprint)
  )
    throw new Error("Invalid private review input.");
  const knownRuns = scalarRunKeys(manifest);
  const entries = row.entries.map((value: unknown) => {
    const entry = exact(value, ["reviewId", "scenarioId", "runId", "sourceFile", "priority"]);
    if (
      typeof entry.reviewId !== "string" ||
      !REVIEW_ID.test(entry.reviewId) ||
      !safeId(entry.scenarioId) ||
      !safeId(entry.runId) ||
      typeof entry.sourceFile !== "string" ||
      !/^[a-z0-9_-]{1,240}\.json$/.test(entry.sourceFile) ||
      !text(entry.priority, 80) ||
      !knownRuns.has(`${entry.scenarioId}\u0000${entry.runId}`)
    )
      throw new Error("Invalid private review input.");
    return entry as unknown as PrivateReviewLocator["entries"][number];
  });
  if (
    new Set(entries.map((entry) => entry.reviewId)).size !== entries.length ||
    new Set(entries.map((entry) => `${entry.scenarioId}\u0000${entry.runId}`)).size !== entries.length ||
    (queue !== null && queue.reviewIds.some((id) => !entries.some((entry) => entry.reviewId === id)))
  )
    throw new Error("Invalid private review input.");
  return {
    schemaVersion: 1,
    ...(row.manifestFingerprint === undefined ? {} : { manifestFingerprint: fingerprint }),
    entries,
  };
}
function scalarRunKeys(input: unknown): Set<string> {
  const top = record(input);
  if (
    !(
      (top.schemaVersion === 1 && top.kind === "conversation-routing-live-canary") ||
      (top.schemaVersion === undefined && top.kind === undefined && typeof top.sourceSha256 === "string")
    ) ||
    !Array.isArray(top.cases) ||
    top.cases.length > 144
  )
    throw new Error("Invalid private review input.");
  const keys = new Set<string>();
  for (const value of top.cases) {
    const room = record(value);
    if (!Array.isArray(room.triggers) || room.triggers.length > 3) throw new Error("Invalid private review input.");
    for (const value of room.triggers) {
      const trigger = record(value);
      if (!safeId(trigger.scenarioId) || !safeId(trigger.runId)) throw new Error("Invalid private review input.");
      const key = `${trigger.scenarioId}\u0000${trigger.runId}`;
      if (keys.has(key)) throw new Error("Invalid private review input.");
      keys.add(key);
    }
  }
  return keys;
}
export function parseOfflineReviewBundle(input: unknown, expectedId: string): OfflineReviewBundle {
  const row = exact(input, [
    "schemaVersion",
    "reviewId",
    "scenarioKind",
    "expectedDirectAgents",
    "prompt",
    "messages",
    "qualityContext",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.reviewId !== expectedId ||
    !text(row.scenarioKind, 80) ||
    !text(row.prompt, 16_000) ||
    !Array.isArray(row.expectedDirectAgents) ||
    row.expectedDirectAgents.length > 8 ||
    row.expectedDirectAgents.some((id) => !safeId(id)) ||
    !Array.isArray(row.messages) ||
    row.messages.length > 40
  )
    throw new Error("Invalid private review input.");
  const messages = row.messages.map((value: unknown) => {
    const message = exact(value, ["speaker", "kind", "text"]);
    if (
      !text(message.speaker, 80) ||
      (message.kind !== "human" && message.kind !== "agent") ||
      !text(message.text, 16_000)
    )
      throw new Error("Invalid private review input.");
    return message as unknown as OfflineReviewBundle["messages"][number];
  });
  const context = exact(row.qualityContext, ["originalHumanAlias", "roster"]);
  if (!text(context.originalHumanAlias, 80) || !Array.isArray(context.roster) || context.roster.length > 8)
    throw new Error("Invalid private review input.");
  const roster = context.roster.map((value: unknown) => {
    const agent = exact(value, ["agentId", "conversationalName"]);
    if (!safeId(agent.agentId) || !text(agent.conversationalName, 80)) throw new Error("Invalid private review input.");
    return agent as unknown as OfflineReviewBundle["qualityContext"]["roster"][number];
  });
  return {
    schemaVersion: 1,
    reviewId: expectedId,
    scenarioKind: row.scenarioKind as string,
    expectedDirectAgents: row.expectedDirectAgents as string[],
    prompt: row.prompt as string,
    messages,
    qualityContext: { originalHumanAlias: context.originalHumanAlias as string, roster },
  };
}

/** Binds exported opaque ratings to the exact ordered private cards without exporting their content. */
export function reviewFingerprint(queueInput: unknown, bundlesInput: readonly unknown[]): string {
  const queue = parseReviewQueue(queueInput);
  if (bundlesInput.length !== queue.reviewIds.length) throw new Error("Invalid private review input.");
  const bundles = queue.reviewIds.map((id, index) => parseOfflineReviewBundle(bundlesInput[index], id));
  return createHash("sha256")
    .update(JSON.stringify({ reviewIds: queue.reviewIds, bundles }))
    .digest("hex");
}

export function parseOfflineReviewExport(
  input: unknown,
  queue: PrivateReviewQueue,
  fingerprint: string,
): OfflineReviewExport {
  const top = exact(input, ["schemaVersion", "kind", "packFingerprint", "ratings"]);
  if (
    top.schemaVersion !== 1 ||
    top.kind !== "blinded-quality-ratings" ||
    top.packFingerprint !== fingerprint ||
    !Array.isArray(top.ratings) ||
    top.ratings.length > queue.reviewIds.length
  )
    throw new Error("Invalid private review export.");
  const allowed = new Set(queue.reviewIds);
  const ratings = top.ratings.map((value: unknown) => {
    const row = exact(value, ["reviewId", "axes"]);
    if (typeof row.reviewId !== "string" || !allowed.has(row.reviewId))
      throw new Error("Invalid private review export.");
    const axes = exact(row.axes, QUALITY_AXES);
    const parsed: OfflineReviewExport["ratings"][number]["axes"] = {};
    for (const axis of QUALITY_AXES) {
      if (!(axis in axes)) continue;
      const rating = exact(axes[axis], ["status", "score"]);
      if (
        rating.status === "rated" &&
        Number.isSafeInteger(rating.score) &&
        Number(rating.score) >= 1 &&
        Number(rating.score) <= 5 &&
        Object.keys(rating).length === 2
      )
        parsed[axis] = { status: "rated", score: rating.score as 1 | 2 | 3 | 4 | 5 };
      else if (rating.status === "not_assessable" && Object.keys(rating).length === 1)
        parsed[axis] = { status: "not_assessable" };
      else throw new Error("Invalid private review export.");
    }
    return { reviewId: row.reviewId as string, axes: parsed };
  });
  if (new Set(ratings.map((row) => row.reviewId)).size !== ratings.length)
    throw new Error("Invalid private review export.");
  return { schemaVersion: 1, kind: "blinded-quality-ratings", packFingerprint: fingerprint, ratings };
}
export function convertOfflineReviewExport(
  input: unknown,
  queueInput: unknown,
  locatorInput: unknown,
  manifestInput: unknown,
  bundlesInput: readonly unknown[],
): { schemaVersion: 2; ratings: QualityHumanRating[] } {
  const queue = parseReviewQueue(queueInput);
  const locator = parseReviewLocator(locatorInput, queue, manifestInput);
  const exported = parseOfflineReviewExport(input, queue, reviewFingerprint(queue, bundlesInput));
  const byId = new Map(locator.entries.map((entry) => [entry.reviewId, entry]));
  const ratings = exported.ratings.map((row) => {
    const location = byId.get(row.reviewId)!;
    return { scenarioId: location.scenarioId, runId: location.runId, axes: row.axes };
  });
  return { schemaVersion: 2, ratings: parsePrivateQualityRatings({ schemaVersion: 2, ratings }) };
}

export function parseOfflineFrameExport(
  input: unknown,
  queue: PrivateReviewQueue,
  fingerprint: string,
): OfflineFrameExport {
  const top = exact(input, ["schemaVersion", "kind", "packFingerprint", "ratings"]);
  if (
    top.schemaVersion !== 1 ||
    top.kind !== "blinded-frame-ratings" ||
    top.packFingerprint !== fingerprint ||
    !Array.isArray(top.ratings) ||
    top.ratings.length > queue.reviewIds.length
  )
    throw new Error("Invalid private frame export.");
  const allowed = new Set(queue.reviewIds);
  const ratings = top.ratings.map((value: unknown) => {
    const row = exact(value, ["reviewId", "axes"]);
    if (typeof row.reviewId !== "string" || !allowed.has(row.reviewId))
      throw new Error("Invalid private frame export.");
    const axes = exact(row.axes, [FRAME_AXIS]);
    if (!(FRAME_AXIS in axes)) return { reviewId: row.reviewId, axes: {} };
    const rating = exact(axes.frame_integrity, ["status", "score"]);
    if (
      rating.status === "rated" &&
      Object.keys(rating).length === 2 &&
      Number.isSafeInteger(rating.score) &&
      Number(rating.score) >= 1 &&
      Number(rating.score) <= 5
    )
      return {
        reviewId: row.reviewId,
        axes: { frame_integrity: { status: "rated" as const, score: rating.score as 1 | 2 | 3 | 4 | 5 } },
      };
    if (rating.status === "not_assessable" && Object.keys(rating).length === 1)
      return { reviewId: row.reviewId, axes: { frame_integrity: { status: "not_assessable" as const } } };
    throw new Error("Invalid private frame export.");
  });
  if (new Set(ratings.map((row) => row.reviewId)).size !== ratings.length)
    throw new Error("Invalid private frame export.");
  return { schemaVersion: 1, kind: "blinded-frame-ratings", packFingerprint: fingerprint, ratings };
}

export function convertOfflineFrameExport(
  input: unknown,
  queueInput: unknown,
  locatorInput: unknown,
  manifestInput: unknown,
  bundlesInput: readonly unknown[],
): { schemaVersion: 3; rubricVersion: "room-frame-integrity-v1"; ratings: FrameHumanRating[] } {
  const queue = parseReviewQueue(queueInput);
  const locator = parseReviewLocator(locatorInput, queue, manifestInput);
  const exported = parseOfflineFrameExport(input, queue, reviewFingerprint(queue, bundlesInput));
  const byId = new Map(locator.entries.map((entry) => [entry.reviewId, entry]));
  const ratings = exported.ratings.map((row) => {
    const location = byId.get(row.reviewId)!;
    return {
      scenarioId: location.scenarioId,
      runId: location.runId,
      ...(row.axes.frame_integrity ? { frame_integrity: row.axes.frame_integrity } : {}),
    };
  });
  return {
    schemaVersion: 3,
    rubricVersion: "room-frame-integrity-v1",
    ratings: parsePrivateFrameRatings({ schemaVersion: 3, rubricVersion: "room-frame-integrity-v1", ratings }),
  };
}

/** Seed-stable paired sample: both arms at one trigger ordinal, stratified by factor and agent count. */
export function selectPairedReviewQueue(
  manifestInput: unknown,
  locatorInput: unknown,
  options: { seed: string; maxPairs: number },
): PrivateReviewQueue {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(options.seed) ||
    !Number.isSafeInteger(options.maxPairs) ||
    options.maxPairs < 1 ||
    options.maxPairs > 24
  )
    throw new Error("Invalid private review selection.");
  const locator = parseReviewLocator(locatorInput, null, manifestInput);
  const byRun = new Map(locator.entries.map((entry) => [`${entry.scenarioId}\u0000${entry.runId}`, entry.reviewId]));
  const expected = scalarRunKeys(manifestInput);
  if (byRun.size !== expected.size || [...expected].some((key) => !byRun.has(key)))
    throw new Error("Incomplete private review locator.");
  const top = record(manifestInput);
  const cases = top.cases as unknown[];
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const value of cases) {
    const row = record(value);
    const study = record(row.study);
    if (
      !safeId(study.pairId) ||
      !["a", "b"].includes(String(study.arm)) ||
      !["jev", "gate", "agent-prompt"].includes(String(study.factor)) ||
      !Number.isInteger(row.agentCount) ||
      Number(row.agentCount) < 1 ||
      Number(row.agentCount) > 4
    )
      throw new Error("Invalid private review selection.");
    groups.set(study.pairId, [...(groups.get(study.pairId) ?? []), row]);
  }
  type Unit = { key: string; pairId: string; ids: [string, string]; bucket: string; priority: number };
  const units: Unit[] = [];
  for (const [pairId, rows] of groups) {
    const a = rows.find((row) => record(row.study).arm === "a");
    const b = rows.find((row) => record(row.study).arm === "b");
    if (
      rows.length !== 2 ||
      !a ||
      !b ||
      a.agentCount !== b.agentCount ||
      record(a.study).factor !== record(b.study).factor
    )
      continue;
    const aTriggers = a.triggers as unknown[],
      bTriggers = b.triggers as unknown[];
    if (!Array.isArray(aTriggers) || !Array.isArray(bTriggers) || aTriggers.length !== bTriggers.length) continue;
    for (let ordinal = 0; ordinal < aTriggers.length; ordinal++) {
      const first = record(aTriggers[ordinal]),
        second = record(bTriggers[ordinal]);
      const aId = byRun.get(`${first.scenarioId}\u0000${first.runId}`),
        bId = byRun.get(`${second.scenarioId}\u0000${second.runId}`);
      if (!aId || !bId || aId === bId) continue;
      const judged = (room: Record<string, unknown>, trigger: Record<string, unknown>) => {
        const rows = Array.isArray(room.qualityJudge) ? room.qualityJudge : [];
        const entry = rows.find((value: unknown) => {
          const row = record(value);
          return row.scenarioId === trigger.scenarioId && row.runId === trigger.runId;
        });
        return entry && Array.isArray(record(entry).outcomes) ? (record(entry).outcomes as unknown[]) : [];
      };
      const left = judged(a, first),
        right = judged(b, second);
      let priority = 0;
      for (let axis = 0; axis < QUALITY_AXES.length; axis++) {
        const x = left[axis] ? record(left[axis]) : null,
          y = right[axis] ? record(right[axis]) : null;
        if (!x || !y || x.status === "failed" || y.status === "failed") {
          priority = Math.max(priority, 2);
          continue;
        }
        const rx = record(x.result),
          ry = record(y.result);
        if (rx.status !== "rated" || ry.status !== "rated") priority = Math.max(priority, 2);
        else if (
          (typeof rx.score === "number" && rx.score <= 2) ||
          (typeof ry.score === "number" && ry.score <= 2) ||
          (typeof rx.score === "number" && typeof ry.score === "number" && Math.abs(rx.score - ry.score) >= 2)
        )
          priority = Math.max(priority, 1);
      }
      units.push({
        key: `${pairId}:${ordinal}`,
        pairId,
        ids: [aId, bId],
        bucket: `${record(a.study).factor}:${a.agentCount}`,
        priority,
      });
    }
  }
  const hash = (value: string) => createHash("sha256").update(`${options.seed}:${value}`).digest("hex");
  const buckets = new Map<string, Unit[]>();
  for (const unit of units) buckets.set(unit.bucket, [...(buckets.get(unit.bucket) ?? []), unit]);
  for (const values of buckets.values())
    values.sort((a, b) => b.priority - a.priority || hash(a.key).localeCompare(hash(b.key)));
  const keys = [...buckets.keys()].sort((a, b) => hash(a).localeCompare(hash(b)));
  const selected: Unit[] = [];
  const selectedPairs = new Set<string>();
  while (selected.length < options.maxPairs && keys.some((key) => (buckets.get(key)?.length ?? 0) > 0))
    for (const key of keys) {
      const next = buckets.get(key)?.shift();
      if (next && !selectedPairs.has(next.pairId)) {
        selected.push(next);
        selectedPairs.add(next.pairId);
      }
      if (selected.length >= options.maxPairs) break;
    }
  if (!selected.length) throw new Error("No complete blinded study pairs are available.");
  const first = selected.map((unit) => ({
    unit,
    id: unit.ids[Number.parseInt(hash(`${unit.key}:orientation`).slice(0, 2), 16) % 2]!,
  }));
  const second = selected.map((unit) => ({
    unit,
    id: unit.ids.find((id) => id !== first.find((entry) => entry.unit === unit)!.id)!,
  }));
  first.sort((a, b) => hash(`first:${a.unit.key}`).localeCompare(hash(`first:${b.unit.key}`)));
  second.sort((a, b) => hash(`second:${a.unit.key}`).localeCompare(hash(`second:${b.unit.key}`)));
  if (second.length > 1 && first[first.length - 1]!.unit === second[0]!.unit)
    [second[0], second[1]] = [second[1]!, second[0]!];
  return parseReviewQueue({ schemaVersion: 1, reviewIds: [...first, ...second].map((entry) => entry.id) });
}

type StudyFactor = "jev" | "gate" | "agent-prompt";
type ReviewPair = {
  pairId: string;
  factor: StudyFactor;
  agentCount: number;
  ordinals: Array<{ ids: [string, string]; requiredNoVisible: boolean; bothVisible: boolean }>;
};
type SelectedReviewPair = {
  pairId: string;
  factor: StudyFactor;
  agentCount: number;
  triggerOrdinal: number;
  reviewIds: [string, string];
};
export interface PrivateReviewSelectionReceipt {
  schemaVersion: 1;
  kind: "calibration" | "flagged-inspection" | "visible-enriched";
  manifestFingerprint: string;
  seed: string;
  selected: SelectedReviewPair[];
  unavailableFactors: StudyFactor[];
}

function seedHash(seed: string, label: string): string {
  return createHash("sha256")
    .update(JSON.stringify([seed, label]))
    .digest("hex");
}
function validSeed(seed: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(seed)) throw new Error("Invalid private review selection.");
}
function studyPairs(manifest: unknown, locatorInput: unknown): ReviewPair[] {
  const locator = parseReviewLocator(locatorInput, null, manifest);
  const expected = scalarRunKeys(manifest);
  const byRun = new Map(locator.entries.map((entry) => [`${entry.scenarioId}\u0000${entry.runId}`, entry.reviewId]));
  if (byRun.size !== expected.size || [...expected].some((key) => !byRun.has(key)))
    throw new Error("Incomplete private review locator.");
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const value of record(manifest).cases as unknown[]) {
    const room = record(value);
    const study = record(room.study);
    if (
      !safeId(study.pairId) ||
      !["a", "b"].includes(String(study.arm)) ||
      !["jev", "gate", "agent-prompt"].includes(String(study.factor)) ||
      !Number.isSafeInteger(room.agentCount) ||
      Number(room.agentCount) < 1 ||
      Number(room.agentCount) > 4
    )
      throw new Error("Invalid private review selection.");
    groups.set(study.pairId, [...(groups.get(study.pairId) ?? []), room]);
  }
  const pairs: ReviewPair[] = [];
  for (const [pairId, rows] of groups) {
    const a = rows.find((row) => record(row.study).arm === "a");
    const b = rows.find((row) => record(row.study).arm === "b");
    if (
      !a ||
      !b ||
      rows.length !== 2 ||
      a.agentCount !== b.agentCount ||
      record(a.study).factor !== record(b.study).factor ||
      !Array.isArray(a.triggers) ||
      !Array.isArray(b.triggers) ||
      a.triggers.length !== b.triggers.length ||
      a.triggers.length < 1 ||
      a.triggers.length > 3
    )
      throw new Error("Incomplete private study pair.");
    const ordinals = a.triggers.map((value: unknown, ordinal: number) => {
      const left = record(value),
        right = record((b.triggers as unknown[])[ordinal]);
      const idA = byRun.get(`${left.scenarioId}\u0000${left.runId}`);
      const idB = byRun.get(`${right.scenarioId}\u0000${right.runId}`);
      if (!idA || !idB || idA === idB) throw new Error("Incomplete private study pair.");
      const missing = [left, right].some((trigger) => {
        const required =
          trigger.requiredTargetCount ??
          (Array.isArray(trigger.requiredAddressAgents) ? trigger.requiredAddressAgents.length : null);
        return typeof required === "number" && required > 0 && trigger.confirmedDeliveredBursts === 0;
      });
      return {
        ids: [idA, idB] as [string, string],
        requiredNoVisible: missing,
        bothVisible:
          typeof left.confirmedDeliveredBursts === "number" &&
          left.confirmedDeliveredBursts > 0 &&
          typeof right.confirmedDeliveredBursts === "number" &&
          right.confirmedDeliveredBursts > 0,
      };
    });
    pairs.push({ pairId, factor: record(a.study).factor as StudyFactor, agentCount: Number(a.agentCount), ordinals });
  }
  return pairs;
}
function blindSelected(selected: SelectedReviewPair[], seed: string): PrivateReviewQueue {
  if (!selected.length) throw new Error("No review pairs available.");
  const cards = selected.map((pair) => {
    const key = `${pair.pairId}:${pair.triggerOrdinal}`;
    const flip = Number.parseInt(seedHash(seed, `orientation:${key}`).slice(0, 2), 16) % 2;
    return { key, first: pair.reviewIds[flip]!, second: pair.reviewIds[1 - flip]! };
  });
  const first = [...cards].sort((a, b) =>
    seedHash(seed, `first:${a.key}`).localeCompare(seedHash(seed, `first:${b.key}`)),
  );
  const second = [...cards].sort((a, b) =>
    seedHash(seed, `second:${a.key}`).localeCompare(seedHash(seed, `second:${b.key}`)),
  );
  if (second.length > 1 && first.at(-1)?.key === second[0]?.key) [second[0], second[1]] = [second[1]!, second[0]!];
  return parseReviewQueue({
    schemaVersion: 1,
    reviewIds: [...first.map((row) => row.first), ...second.map((row) => row.second)],
  });
}

/** Twelve judge-independent, factor-balanced pairs; one seed-selected trigger per pair. */
export function selectCalibrationReviewQueue(manifest: unknown, locator: unknown, seed: string) {
  validSeed(seed);
  const pairs = studyPairs(manifest, locator);
  const factors: StudyFactor[] = ["jev", "gate", "agent-prompt"];
  const selected: SelectedReviewPair[] = [];
  for (const factor of factors) {
    const available = pairs.filter((pair) => pair.factor === factor);
    const counts = [...new Set(available.map((pair) => pair.agentCount))].sort();
    if (available.length < 4 || counts.length < 2 || counts.length > 4)
      throw new Error("Insufficient calibration strata.");
    const chosen: ReviewPair[] = [];
    for (const count of counts) {
      const stratum = available.filter((pair) => pair.agentCount === count);
      stratum.sort((a, b) => seedHash(seed, `pair:${a.pairId}`).localeCompare(seedHash(seed, `pair:${b.pairId}`)));
      chosen.push(stratum[0]!);
    }
    const remainder = available.filter((pair) => !chosen.includes(pair));
    remainder.sort((a, b) => seedHash(seed, `pair:${a.pairId}`).localeCompare(seedHash(seed, `pair:${b.pairId}`)));
    chosen.push(...remainder.slice(0, 4 - chosen.length));
    if (chosen.length !== 4) throw new Error("Insufficient calibration strata.");
    for (const pair of chosen) {
      const ordinals = pair.ordinals.map((_, ordinal) => ordinal);
      ordinals.sort((a, b) =>
        seedHash(seed, `ordinal:${pair.pairId}:${a}`).localeCompare(seedHash(seed, `ordinal:${pair.pairId}:${b}`)),
      );
      const triggerOrdinal = ordinals[0]!;
      selected.push({
        pairId: pair.pairId,
        factor,
        agentCount: pair.agentCount,
        triggerOrdinal,
        reviewIds: pair.ordinals[triggerOrdinal]!.ids,
      });
    }
  }
  const receipt: PrivateReviewSelectionReceipt = {
    schemaVersion: 1,
    kind: "calibration",
    manifestFingerprint: manifestFingerprint(manifest),
    seed,
    selected,
    unavailableFactors: [],
  };
  return { queue: blindSelected(selected, seed), receipt };
}

/** A separate outcome-conditioned inspection set; never mix it into calibration denominators. */
export function selectFlaggedReviewQueue(manifest: unknown, locator: unknown, calibrationInput: unknown, seed: string) {
  validSeed(seed);
  const calibration = exact(calibrationInput, [
    "schemaVersion",
    "kind",
    "manifestFingerprint",
    "seed",
    "selected",
    "unavailableFactors",
  ]);
  if (
    calibration.schemaVersion !== 1 ||
    calibration.kind !== "calibration" ||
    calibration.manifestFingerprint !== manifestFingerprint(manifest) ||
    !Array.isArray(calibration.selected) ||
    typeof calibration.seed !== "string"
  )
    throw new Error("Invalid private calibration receipt.");
  const expectedCalibration = selectCalibrationReviewQueue(manifest, locator, calibration.seed).receipt;
  if (JSON.stringify(calibration) !== JSON.stringify(expectedCalibration))
    throw new Error("Invalid private calibration receipt.");
  const covered = new Set(
    calibration.selected.map((value: unknown) => {
      const row = record(value);
      if (!safeId(row.pairId) || !Number.isSafeInteger(row.triggerOrdinal))
        throw new Error("Invalid private calibration receipt.");
      return `${row.pairId}:${row.triggerOrdinal}`;
    }),
  );
  const pairs = studyPairs(manifest, locator);
  const factors: StudyFactor[] = ["jev", "gate", "agent-prompt"];
  const selected: SelectedReviewPair[] = [];
  const unavailableFactors: StudyFactor[] = [];
  for (const factor of factors) {
    const options = pairs
      .filter((pair) => pair.factor === factor)
      .flatMap((pair) =>
        pair.ordinals.flatMap((ordinal, triggerOrdinal) =>
          ordinal.requiredNoVisible && !covered.has(`${pair.pairId}:${triggerOrdinal}`)
            ? [{ pair, triggerOrdinal, ids: ordinal.ids }]
            : [],
        ),
      );
    options.sort((a, b) =>
      seedHash(seed, `flag:${a.pair.pairId}:${a.triggerOrdinal}`).localeCompare(
        seedHash(seed, `flag:${b.pair.pairId}:${b.triggerOrdinal}`),
      ),
    );
    const selectedOption = options[0];
    if (!selectedOption) {
      unavailableFactors.push(factor);
      continue;
    }
    selected.push({
      pairId: selectedOption.pair.pairId,
      factor,
      agentCount: selectedOption.pair.agentCount,
      triggerOrdinal: selectedOption.triggerOrdinal,
      reviewIds: selectedOption.ids,
    });
  }
  const receipt: PrivateReviewSelectionReceipt = {
    schemaVersion: 1,
    kind: "flagged-inspection",
    manifestFingerprint: manifestFingerprint(manifest),
    seed,
    selected,
    unavailableFactors,
  };
  return { queue: selected.length ? blindSelected(selected, seed) : null, receipt };
}

/** Outcome-conditioned both-visible inspection, with its own denominator. */
export function selectVisibleReviewQueue(manifest: unknown, locator: unknown, calibrationInput: unknown, seed: string) {
  validSeed(seed);
  const calibration = exact(calibrationInput, [
    "schemaVersion",
    "kind",
    "manifestFingerprint",
    "seed",
    "selected",
    "unavailableFactors",
  ]);
  if (
    calibration.schemaVersion !== 1 ||
    calibration.kind !== "calibration" ||
    calibration.manifestFingerprint !== manifestFingerprint(manifest) ||
    typeof calibration.seed !== "string"
  )
    throw new Error("Invalid private calibration receipt.");
  const expected = selectCalibrationReviewQueue(manifest, locator, calibration.seed).receipt;
  if (JSON.stringify(calibration) !== JSON.stringify(expected)) throw new Error("Invalid private calibration receipt.");
  const covered = new Set(expected.selected.map((row) => `${row.pairId}:${row.triggerOrdinal}`));
  const usedPairs = new Set(expected.selected.map((row) => row.pairId));
  const pairs = studyPairs(manifest, locator);
  const quota: Record<StudyFactor, number> = { "agent-prompt": 2, gate: 4, jev: 4 };
  const selected: SelectedReviewPair[] = [];
  for (const factor of ["agent-prompt", "gate", "jev"] as const) {
    const options = pairs
      .filter((pair) => pair.factor === factor)
      .flatMap((pair) =>
        pair.ordinals.flatMap((ordinal, triggerOrdinal) =>
          ordinal.bothVisible && !covered.has(`${pair.pairId}:${triggerOrdinal}`)
            ? [{ pair, triggerOrdinal, ids: ordinal.ids }]
            : [],
        ),
      );
    // A different ordinal from a calibration block is allowed, but prefer a new block.
    options.sort(
      (a, b) =>
        Number(usedPairs.has(a.pair.pairId)) - Number(usedPairs.has(b.pair.pairId)) ||
        seedHash(seed, `visible:${a.pair.pairId}:${a.triggerOrdinal}`).localeCompare(
          seedHash(seed, `visible:${b.pair.pairId}:${b.triggerOrdinal}`),
        ),
    );
    const distinct = new Set<string>();
    for (const option of options) {
      if (distinct.has(option.pair.pairId)) continue;
      distinct.add(option.pair.pairId);
      selected.push({
        pairId: option.pair.pairId,
        factor,
        agentCount: option.pair.agentCount,
        triggerOrdinal: option.triggerOrdinal,
        reviewIds: option.ids,
      });
      if (distinct.size === quota[factor]) break;
    }
    if (distinct.size !== quota[factor]) throw new Error("Insufficient both-visible review pairs.");
  }
  const receipt: PrivateReviewSelectionReceipt = {
    schemaVersion: 1,
    kind: "visible-enriched",
    manifestFingerprint: manifestFingerprint(manifest),
    seed,
    selected,
    unavailableFactors: [],
  };
  return { queue: blindSelected(selected, seed), receipt };
}

/** High-precision private screen. It proposes inspection, never a model score or prevalence estimate. */
export function frameCandidateFlags(bundle: OfflineReviewBundle) {
  const latestHuman = bundle.messages.findLastIndex((message) => message.kind === "human");
  const replies = bundle.messages.slice(latestHuman + 1).filter((message) => message.kind === "agent");
  const frameRejection = replies.some(
    ({ text }) =>
      (/\bI(?:'m| am) OpenCode\b/i.test(text) &&
        /\b(?:coding|software|roleplay|actual function|not designed)\b/i.test(text)) ||
      /\b(?:test of my room-chat behavior|if this is a test scenario|appears to be a test of my room-chat)\b/i.test(
        text,
      ),
  );
  const privateMachineryLeak = replies.some(({ text }) =>
    /\b(?:PINNED ROOM STATE|RECENT ROOM MESSAGES|system notifications|room instructions|SYSTEM reports)\b/i.test(text),
  );
  const peerAmplification = replies.some(({ text }) =>
    /\b(?:stay in character|break frame|break character|clarification attempt)\b/i.test(text),
  );
  return { frameRejection, privateMachineryLeak, peerAmplification };
}

export function selectFrameCandidateReviewQueue(
  manifest: unknown,
  locatorInput: unknown,
  privateSources: readonly unknown[],
  seed: string,
) {
  validSeed(seed);
  const locator = parseReviewLocator(locatorInput, null, manifest);
  const byRun = new Map(locator.entries.map((entry) => [`${entry.scenarioId}\u0000${entry.runId}`, entry]));
  if (privateSources.length !== byRun.size) throw new Error("Incomplete private frame sources.");
  const seen = new Set<string>();
  const candidates: Array<{ reviewId: string; flags: ReturnType<typeof frameCandidateFlags> }> = [];
  for (const input of privateSources) {
    const source = record(input);
    if (!safeId(source.scenarioId) || !safeId(source.runId)) throw new Error("Invalid private frame source.");
    const key = `${source.scenarioId}\u0000${source.runId}`;
    const entry = byRun.get(key);
    if (!entry || seen.has(key)) throw new Error("Unknown or duplicate private frame source.");
    seen.add(key);
    const bundle = parseOfflineReviewBundle(
      {
        schemaVersion: 1,
        reviewId: entry.reviewId,
        scenarioKind: source.scenarioKind,
        expectedDirectAgents: source.expectedDirectAgents,
        prompt: source.prompt,
        messages: source.messages,
        qualityContext: source.qualityContext,
      },
      entry.reviewId,
    );
    const flags = frameCandidateFlags(bundle);
    if (Object.values(flags).some(Boolean)) candidates.push({ reviewId: entry.reviewId, flags });
  }
  if (candidates.length > MAX_REVIEWS) throw new Error("Too many private frame candidates; split the inspection set.");
  candidates.sort((a, b) => seedHash(seed, `frame:${a.reviewId}`).localeCompare(seedHash(seed, `frame:${b.reviewId}`)));
  const reviewIds = candidates.map((row) => row.reviewId);
  const receipt = {
    schemaVersion: 1 as const,
    kind: "frame-candidate" as const,
    manifestFingerprint: manifestFingerprint(manifest),
    seed,
    screenedTriggers: privateSources.length,
    selectedTriggers: reviewIds.length,
    categories: {
      frameRejection: candidates.filter((row) => row.flags.frameRejection).length,
      privateMachineryLeak: candidates.filter((row) => row.flags.privateMachineryLeak).length,
      peerAmplification: candidates.filter((row) => row.flags.peerAmplification).length,
    },
    reviewIds,
  };
  return { queue: reviewIds.length ? parseReviewQueue({ schemaVersion: 1, reviewIds }) : null, receipt };
}

/** A complete, judge-independent frame census of one small V2 pilot. */
export function selectCompleteFrameReviewQueue(manifest: unknown, locatorInput: unknown, seed: string) {
  validSeed(seed);
  const top = record(manifest);
  const plan = record(top.studyPlan);
  if (plan.schemaVersion !== 2 || top.judgeRubric !== "v3" || !Array.isArray(top.cases))
    throw new Error("A V2 frame identity study is required.");
  const locator = parseReviewLocator(locatorInput, null, manifest);
  const keys = scalarRunKeys(manifest);
  const byRun = new Map(locator.entries.map((entry) => [`${entry.scenarioId}\u0000${entry.runId}`, entry.reviewId]));
  if (keys.size < 2 || keys.size > 30 || byRun.size !== keys.size || [...keys].some((key) => !byRun.has(key)))
    throw new Error("Incomplete or oversized private frame census.");
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const value of top.cases) {
    const room = record(value);
    const study = record(room.study);
    if (study.schemaVersion !== 2 || study.factor !== "room-system" || !safeId(study.pairId))
      throw new Error("Invalid private frame census.");
    groups.set(study.pairId, [...(groups.get(study.pairId) ?? []), room]);
  }
  const cards: Array<{ key: string; first: string; second: string }> = [];
  for (const [pairId, rows] of groups) {
    const a = rows.find((row) => record(row.study).arm === "a");
    const b = rows.find((row) => record(row.study).arm === "b");
    if (
      !a ||
      !b ||
      rows.length !== 2 ||
      record(a.study).roomSystemProfileId !== "legacy-v1" ||
      record(b.study).roomSystemProfileId !== "room-v1" ||
      !Array.isArray(a.triggers) ||
      !Array.isArray(b.triggers) ||
      a.triggers.length !== b.triggers.length ||
      a.triggers.length < 1 ||
      a.triggers.length > 3
    )
      throw new Error("Incomplete private frame pair.");
    for (let ordinal = 0; ordinal < a.triggers.length; ordinal++) {
      const left = record(a.triggers[ordinal]);
      const right = record(b.triggers[ordinal]);
      const idA = byRun.get(`${left.scenarioId}\u0000${left.runId}`);
      const idB = byRun.get(`${right.scenarioId}\u0000${right.runId}`);
      if (!idA || !idB || idA === idB) throw new Error("Incomplete private frame pair.");
      const key = `${pairId}:${ordinal}`;
      const flip = Number.parseInt(seedHash(seed, `orientation:${key}`).slice(0, 2), 16) % 2;
      cards.push({ key, first: flip ? idB : idA, second: flip ? idA : idB });
    }
  }
  if (cards.length * 2 !== keys.size || cards.length < 1) throw new Error("Incomplete private frame census.");
  const first = [...cards].sort((a, b) =>
    seedHash(seed, `first:${a.key}`).localeCompare(seedHash(seed, `first:${b.key}`)),
  );
  const second = [...cards].sort((a, b) =>
    seedHash(seed, `second:${a.key}`).localeCompare(seedHash(seed, `second:${b.key}`)),
  );
  if (second.length > 1 && first.at(-1)?.key === second[0]?.key) [second[0], second[1]] = [second[1]!, second[0]!];
  const queue = parseReviewQueue({
    schemaVersion: 1,
    reviewIds: [...first.map((row) => row.first), ...second.map((row) => row.second)],
  });
  return {
    queue,
    receipt: {
      schemaVersion: 1 as const,
      kind: "frame-complete" as const,
      manifestFingerprint: manifestFingerprint(manifest),
      seed,
      screenedTriggers: keys.size,
      selectedTriggers: queue.reviewIds.length,
      pairOrdinals: cards.length,
    },
  };
}

const STYLE = `:root{font:16px system-ui,sans-serif;color:#17212b;background:#f4f7fa}*{box-sizing:border-box}body{margin:0}main{max-width:920px;margin:auto;padding:1rem 1rem 4rem}header{position:sticky;top:0;background:#f4f7fa;padding:.75rem 0;z-index:1;border-bottom:1px solid #cad4de}h1{font-size:1.45rem;margin:.25rem 0}button,.file-button{border:1px solid #45657e;background:#fff;color:#123;padding:.55rem .75rem;border-radius:.4rem;cursor:pointer;font:inherit}button:focus-visible,input:focus-visible,.file-button:focus-within{outline:3px solid #2369b4}.toolbar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}.toolbar output{margin-left:auto}section,.card,fieldset{background:white;border:1px solid #c7d2dc;border-radius:.5rem;padding:1rem;margin:1rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:.4rem 0}.message{border-left:3px solid #8aa4bc;padding:.4rem .75rem;margin:.7rem 0;background:#f8fafc}.message strong{display:block}fieldset legend{font-weight:700;padding:0 .3rem}.anchors{color:#40576b;font-size:.92rem}.choices{display:flex;flex-wrap:wrap;gap:.8rem;margin-top:.65rem}.choices label{display:flex;align-items:center;gap:.2rem;min-height:2rem}#status{min-height:1.5rem;color:#345}#importFile{position:absolute;opacity:0;width:1px;height:1px}@media(max-width:550px){main{padding:.5rem}.toolbar output{margin-left:0;width:100%}}`;
const SCRIPT = `(function(){"use strict";const data=__DATA__;const fingerprint=__FINGERPRINT__;const axes=__AXES__;const labels=__LABELS__;const anchors=__ANCHORS__;const choices=["1","2","3","4","5","NA","Clear"];const exportKind=__EXPORT_KIND__;let index=0;const ratings={};const byId=new Set(data.map(x=>x.reviewId));const $=id=>document.getElementById(id);function clear(node){while(node.firstChild)node.removeChild(node.firstChild)}function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node}function complete(id){return axes.every(axis=>ratings[id]?.axes?.[axis])}function render(){const item=data[index];$("counter").textContent=(index+1)+" / "+data.length;$("progress").textContent=data.filter(x=>complete(x.reviewId)).length+" complete";$("reviewId").textContent=item.reviewId;$("kind").textContent=item.scenarioKind;$("human").textContent=item.qualityContext.originalHumanAlias;$("roster").textContent=item.qualityContext.roster.map(x=>x.conversationalName).join(", ");$("expected").textContent=item.expectedDirectAgents.map(id=>item.qualityContext.roster.find(x=>x.agentId===id)?.conversationalName||id).join(", ")||"None stated";$("prompt").textContent=item.prompt;const messages=$("messages");clear(messages);let latestHuman=-1;item.messages.forEach((message,i)=>{if(message.kind==="human")latestHuman=i});const currentReplies=item.messages.slice(latestHuman+1).filter(message=>message.kind==="agent").length;$("replyStatus").textContent=currentReplies===0?"No visible agent reply after the latest human prompt.":currentReplies+" visible agent reply"+(currentReplies===1?"":"ies")+" after the latest human prompt.";for(const message of item.messages){const box=el("div","message");box.append(el("strong","",(message.kind==="human"?item.qualityContext.originalHumanAlias:(item.qualityContext.roster.find(x=>x.agentId===message.speaker)?.conversationalName||message.speaker))+" · "+message.kind),el("pre","",message.text));messages.append(box)}const scores=$("scores");clear(scores);for(const axis of axes){const group=el("fieldset","");group.dataset.axis=axis;group.append(el("legend","",labels[axis]),el("div","anchors",anchors[axis]));const row=el("div","choices");for(const option of choices){const label=el("label","");const input=document.createElement("input");input.type="radio";input.name=axis;input.value=option;input.checked=(option==="Clear"&&!ratings[item.reviewId]?.axes?.[axis])||(option==="NA"&&ratings[item.reviewId]?.axes?.[axis]?.status==="not_assessable")||(ratings[item.reviewId]?.axes?.[axis]?.status==="rated"&&String(ratings[item.reviewId].axes[axis].score)===option);input.addEventListener("change",()=>{const entry=ratings[item.reviewId]??={reviewId:item.reviewId,axes:{}};if(option==="Clear")delete entry.axes[axis];else entry.axes[axis]=option==="NA"?{status:"not_assessable"}:{status:"rated",score:Number(option)};if(!Object.keys(entry.axes).length)delete ratings[item.reviewId];$("progress").textContent=data.filter(x=>complete(x.reviewId)).length+" complete"});label.append(input,document.createTextNode(option));row.append(label)}group.append(row);scores.append(group)}$("previous").disabled=index===0;$("next").disabled=index===data.length-1}function validate(input){if(!input||input.schemaVersion!==1||input.kind!==exportKind||input.packFingerprint!==fingerprint||Object.keys(input).some(k=>!["schemaVersion","kind","packFingerprint","ratings"].includes(k))||!Array.isArray(input.ratings)||input.ratings.length>data.length)throw Error();const seen=new Set();const parsed={};for(const row of input.ratings){if(!row||typeof row.reviewId!=="string"||!byId.has(row.reviewId)||seen.has(row.reviewId)||!row.axes||typeof row.axes!=="object"||Array.isArray(row.axes)||Object.keys(row).some(k=>!["reviewId","axes"].includes(k)))throw Error();seen.add(row.reviewId);const entry={reviewId:row.reviewId,axes:{}};for(const axis of Object.keys(row.axes)){if(!axes.includes(axis))throw Error();const rating=row.axes[axis];if(!rating||typeof rating!=="object"||Array.isArray(rating))throw Error();if(rating.status==="rated"&&Number.isInteger(rating.score)&&rating.score>=1&&rating.score<=5&&Object.keys(rating).length===2)entry.axes[axis]={status:"rated",score:rating.score};else if(rating.status==="not_assessable"&&Object.keys(rating).length===1)entry.axes[axis]={status:"not_assessable"};else throw Error()}if(Object.keys(entry.axes).length)parsed[row.reviewId]=entry}return parsed}$("previous").onclick=()=>{index=Math.max(0,index-1);render()};$("next").onclick=()=>{index=Math.min(data.length-1,index+1);render()};$("export").onclick=()=>{const payload={schemaVersion:1,kind:exportKind,packFingerprint:fingerprint,ratings:data.flatMap(x=>ratings[x.reviewId]?[ratings[x.reviewId]]:[])};const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));const anchor=document.createElement("a");anchor.href=url;anchor.download=exportKind==="blinded-frame-ratings"?"blinded-frame-ratings.json":"blinded-ratings.json";anchor.click();setTimeout(()=>URL.revokeObjectURL(url),3000);$("status").textContent="Private ratings exported. Save outside the repository."};$("importFile").onchange=async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>128000)throw Error();const parsed=validate(JSON.parse(await file.text()));for(const key of Object.keys(ratings))delete ratings[key];Object.assign(ratings,parsed);$("status").textContent="Private partial ratings imported.";render()}catch{$("status").textContent="Invalid ratings file; current ratings were retained."}event.target.value=""};document.addEventListener("keydown",event=>{if(event.altKey&&event.key==="ArrowRight"){event.preventDefault();$("next").click()}else if(event.altKey&&event.key==="ArrowLeft"){event.preventDefault();$("previous").click()}else if(!event.altKey&&!event.metaKey&&!event.ctrlKey&&event.target.closest?.("[data-axis]")){const option=/^[1-5]$/.test(event.key)?event.key:event.key.toLowerCase()==="n"?"NA":null;if(option){event.preventDefault();const input=event.target.closest("[data-axis]").querySelector('input[value="'+option+'"]');input?.click()}}});render()})();`;

/** Pure HTML renderer. No run IDs, policy metadata, cost, or judge scores enter the page. */
export function buildOfflineReviewHtml(
  queueInput: unknown,
  bundlesInput: readonly unknown[],
  reviewSet: "calibration" | "flagged" | "visible-enriched" | "frame-candidate" | "frame-complete" | null = null,
): string {
  const queue = parseReviewQueue(queueInput);
  if (bundlesInput.length !== queue.reviewIds.length) throw new Error("Invalid private review input.");
  const bundles = queue.reviewIds.map((id, index) => parseOfflineReviewBundle(bundlesInput[index], id));
  const json = JSON.stringify(bundles).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const script = SCRIPT.replace("__DATA__", json)
    .replace("__FINGERPRINT__", JSON.stringify(reviewFingerprint(queue, bundles)))
    .replace("__AXES__", JSON.stringify(reviewSet?.startsWith("frame-") ? [FRAME_AXIS] : QUALITY_AXES))
    .replace("__LABELS__", JSON.stringify(reviewSet?.startsWith("frame-") ? FRAME_LABELS : AXIS_LABELS))
    .replace("__ANCHORS__", JSON.stringify(reviewSet?.startsWith("frame-") ? FRAME_ANCHORS : AXIS_ANCHORS))
    .replace(
      "__EXPORT_KIND__",
      JSON.stringify(reviewSet?.startsWith("frame-") ? "blinded-frame-ratings" : "blinded-quality-ratings"),
    );
  const hash = (value: string) => createHash("sha256").update(value).digest("base64");
  const heading = reviewSet?.startsWith("frame-")
    ? `Blinded conversation review · ${reviewSet === "frame-complete" ? "complete frame pilot" : "frame-candidate inspection"}`
    : reviewSet === "visible-enriched"
      ? "Blinded conversation review · visible-response enriched inspection"
      : reviewSet === "flagged"
        ? "Blinded conversation review · flagged inspection"
        : reviewSet === "calibration"
          ? "Blinded conversation review · calibration sample"
          : "Blinded conversation review";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(STYLE)}'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; form-action 'none'"><title>Private ${heading}</title><style>${STYLE}</style></head><body><main><header><h1>${heading}</h1><div class="toolbar"><button id="previous" type="button">Previous</button><button id="next" type="button">Next</button><button id="export" type="button">Export partial ratings</button><label class="file-button">Import ratings<input id="importFile" type="file" accept="application/json,.json"></label><output id="counter"></output><output id="progress"></output></div><div id="status" role="status" aria-live="polite"></div></header><section><strong id="reviewId"></strong><p>Conversation: <span id="kind"></span></p><p>Original human: <span id="human"></span></p><p>Roster: <span id="roster"></span></p><p>Expected direct agents: <span id="expected"></span></p><h2>Latest prompt</h2><pre id="prompt"></pre><h2>Visible messages</h2><p id="replyStatus"></p><div id="messages"></div></section><section><h2>${reviewSet?.startsWith("frame-") ? "Frame integrity" : "Four independent ratings"}</h2><p>Choose 1–5, NA if not assessable, or Clear to leave missing. Tab to an axis and press 1–5 or N; Alt+arrows move between reviews.</p><div id="scores"></div></section></main><script>${script}</script></body></html>`;
}

async function readBounded(file: string): Promise<unknown> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new Error("Invalid private review input.");
  const bytes = await readFile(file);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error("Invalid private review input.");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
async function privateDirectory(directory: string) {
  if (!isAbsolute(directory)) throw new Error("Private directory path must be absolute.");
  const real = await realpath(directory);
  const info = await stat(real);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || real === REPO_ROOT || real.startsWith(`${REPO_ROOT}${sep}`))
    throw new Error("Private directory must be outside the repository with 0700 permissions.");
}
async function sourceBundles(manifest: unknown, sourceDirs: readonly string[]) {
  if (!sourceDirs.length || sourceDirs.length > 12 || new Set(sourceDirs).size !== sourceDirs.length)
    throw new Error("Invalid private source directories.");
  const expected = scalarRunKeys(manifest);
  const byRun = new Map<string, { filename: string; source: Record<string, unknown> }>();
  const filenames = new Set<string>();
  for (const directory of sourceDirs) {
    await privateDirectory(directory);
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    if (names.length > 500) throw new Error("Too many private source bundles.");
    for (const filename of names) {
      if (!/^[a-z0-9_-]{1,240}\.json$/.test(filename) || filenames.has(filename))
        throw new Error("Duplicate or invalid private source filename.");
      filenames.add(filename);
      const source = record(await readBounded(resolve(directory, filename)));
      if (!safeId(source.scenarioId) || !safeId(source.runId)) throw new Error("Invalid private source bundle.");
      const key = `${source.scenarioId}\u0000${source.runId}`;
      if (!expected.has(key) || byRun.has(key)) throw new Error("Unknown or duplicate private source case.");
      byRun.set(key, { filename, source });
    }
  }
  if (byRun.size !== expected.size) throw new Error("Missing private source case.");
  return byRun;
}
/** Generates an opaque locator and cards from every completed scalar trigger, fail-closed. */
export async function blindPrivateSources(manifest: unknown, sourceDirs: readonly string[]) {
  const sources = await sourceBundles(manifest, sourceDirs);
  const entries: PrivateReviewLocator["entries"] = [];
  const cards: OfflineReviewBundle[] = [];
  for (const [key, { filename, source }] of sources) {
    const [scenarioId, runId] = key.split("\u0000") as [string, string];
    let reviewId: string;
    do {
      reviewId = `review-${randomBytes(6).toString("hex")}`;
    } while (entries.some((entry) => entry.reviewId === reviewId));
    const card = parseOfflineReviewBundle(
      {
        schemaVersion: 1,
        reviewId,
        scenarioKind: source.scenarioKind,
        expectedDirectAgents: source.expectedDirectAgents,
        prompt: source.prompt,
        messages: source.messages,
        qualityContext: source.qualityContext,
      },
      reviewId,
    );
    entries.push({ reviewId, scenarioId, runId, sourceFile: filename, priority: "unselected" });
    cards.push(card);
  }
  return { locator: { schemaVersion: 1 as const, manifestFingerprint: manifestFingerprint(manifest), entries }, cards };
}
async function loadVerifiedBundles(
  queue: PrivateReviewQueue,
  locator: PrivateReviewLocator,
  blindedDirs: readonly string[],
  sourceDirs: readonly string[],
): Promise<OfflineReviewBundle[]> {
  if (
    !blindedDirs.length ||
    !sourceDirs.length ||
    blindedDirs.length > 12 ||
    sourceDirs.length > 12 ||
    new Set(blindedDirs).size !== blindedDirs.length ||
    new Set(sourceDirs).size !== sourceDirs.length
  )
    throw new Error("Invalid private review input.");
  const unique = async (directories: readonly string[], filename: string): Promise<unknown> => {
    const found: unknown[] = [];
    for (const directory of directories) {
      await privateDirectory(directory);
      try {
        found.push(await readBounded(resolve(directory, filename)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (found.length !== 1) throw new Error("Missing or duplicate private review bundle.");
    return found[0];
  };
  const byId = new Map(locator.entries.map((entry) => [entry.reviewId, entry]));
  const bundles: OfflineReviewBundle[] = [];
  for (const id of queue.reviewIds) {
    const location = byId.get(id)!;
    const bundle = parseOfflineReviewBundle(await unique(blindedDirs, `${id}.json`), id);
    const source = record(await unique(sourceDirs, location.sourceFile));
    const comparable = ["scenarioKind", "expectedDirectAgents", "prompt", "messages", "qualityContext"] as const;
    if (
      source.scenarioId !== location.scenarioId ||
      source.runId !== location.runId ||
      comparable.some((key) => JSON.stringify(source[key]) !== JSON.stringify(bundle[key]))
    )
      throw new Error("Invalid private review input.");
    bundles.push(bundle);
  }
  return bundles;
}
async function privateWrite(file: string, content: string) {
  if (!isAbsolute(file)) throw new Error("Private output requires an absolute path.");
  const parent = dirname(resolve(file));
  await privateDirectory(parent);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}
function args(values: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index],
      value = values[index + 1];
    if (
      !key?.startsWith("--") ||
      !value ||
      (result.has(key) && !["--manifest", "--source-dir", "--blinded-dir"].includes(key))
    )
      throw new Error("Invalid review command.");
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = args(rest);
  const required =
    command === "blind"
      ? ["--manifest", "--source-dir", "--output-dir"]
      : command === "select"
        ? ["--manifest", "--map", "--seed", "--pairs", "--output"]
        : command === "select-calibration"
          ? ["--manifest", "--map", "--seed", "--output", "--receipt"]
          : command === "select-flagged"
            ? ["--manifest", "--map", "--seed", "--calibration-receipt", "--output", "--receipt"]
            : command === "select-visible"
              ? ["--manifest", "--map", "--seed", "--calibration-receipt", "--output", "--receipt"]
              : command === "select-frame"
                ? ["--manifest", "--map", "--source-dir", "--seed", "--output", "--receipt"]
                : command === "select-frame-all"
                  ? ["--manifest", "--map", "--seed", "--output", "--receipt"]
                  : command === "pack"
                    ? ["--manifest", "--queue", "--map", "--blinded-dir", "--source-dir", "--output"]
                    : command === "convert"
                      ? ["--manifest", "--queue", "--map", "--blinded-dir", "--source-dir", "--ratings", "--output"]
                      : [];
  if (
    !required.length ||
    (flags.size !== required.length &&
      !(
        ["pack", "convert"].includes(command ?? "") &&
        flags.size === required.length + 1 &&
        flags.has("--review-set")
      )) ||
    required.some((key) => !flags.has(key))
  )
    throw new Error("Invalid review command.");
  if (
    [...flags].some(
      ([key, values]) => !["--manifest", "--source-dir", "--blinded-dir"].includes(key) && values.length !== 1,
    )
  )
    throw new Error("Invalid review command.");
  const one = (key: string) => flags.get(key)![0]!;
  const manifestFiles = flags.get("--manifest")!;
  if (manifestFiles.length > 72 || new Set(manifestFiles).size !== manifestFiles.length)
    throw new Error("Invalid review manifests.");
  const manifest = mergeScalarCanaryManifests(
    await Promise.all(manifestFiles.map(async (file) => parseScalarCanaryManifest(await readBounded(file)))),
  );
  if (command === "blind") {
    const output = one("--output-dir");
    if (!isAbsolute(output)) throw new Error("Private output requires an absolute path.");
    await privateDirectory(dirname(output));
    const { locator, cards } = await blindPrivateSources(manifest, flags.get("--source-dir")!);
    await mkdir(output, { mode: 0o700 });
    try {
      await mkdir(resolve(output, "blinded"), { mode: 0o700 });
      for (const card of cards)
        await privateWrite(resolve(output, "blinded", `${card.reviewId}.json`), `${JSON.stringify(card)}\n`);
      await privateWrite(resolve(output, "blinded-map.json"), `${JSON.stringify(locator, null, 2)}\n`);
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      throw error;
    }
    process.stdout.write("Private review artifact created.\n");
    return;
  }
  if (command === "select") {
    const queue = selectPairedReviewQueue(manifest, await readBounded(one("--map")), {
      seed: one("--seed"),
      maxPairs: Number(one("--pairs")),
    });
    await privateWrite(one("--output"), `${JSON.stringify(queue, null, 2)}\n`);
    process.stdout.write("Private review artifact created.\n");
    return;
  }
  if (command === "select-frame") {
    const sources = await sourceBundles(manifest, flags.get("--source-dir")!);
    const result = selectFrameCandidateReviewQueue(
      manifest,
      await readBounded(one("--map")),
      [...sources.values()].map((row) => row.source),
      one("--seed"),
    );
    if (result.queue) await privateWrite(one("--output"), `${JSON.stringify(result.queue, null, 2)}\n`);
    await privateWrite(one("--receipt"), `${JSON.stringify(result.receipt, null, 2)}\n`);
    process.stdout.write(
      result.queue ? "Private frame inspection created.\n" : "No frame candidates; private receipt created.\n",
    );
    return;
  }
  if (command === "select-frame-all") {
    const result = selectCompleteFrameReviewQueue(manifest, await readBounded(one("--map")), one("--seed"));
    await privateWrite(one("--output"), `${JSON.stringify(result.queue, null, 2)}\n`);
    await privateWrite(one("--receipt"), `${JSON.stringify(result.receipt, null, 2)}\n`);
    process.stdout.write("Private complete frame review created.\n");
    return;
  }
  if (command === "select-calibration" || command === "select-flagged" || command === "select-visible") {
    const locator = await readBounded(one("--map"));
    const result =
      command === "select-calibration"
        ? selectCalibrationReviewQueue(manifest, locator, one("--seed"))
        : command === "select-flagged"
          ? selectFlaggedReviewQueue(manifest, locator, await readBounded(one("--calibration-receipt")), one("--seed"))
          : selectVisibleReviewQueue(manifest, locator, await readBounded(one("--calibration-receipt")), one("--seed"));
    if (result.queue) await privateWrite(one("--output"), `${JSON.stringify(result.queue, null, 2)}\n`);
    await privateWrite(one("--receipt"), `${JSON.stringify(result.receipt, null, 2)}\n`);
    process.stdout.write(
      result.queue ? "Private review selection created.\n" : "No additional flagged cards; private receipt created.\n",
    );
    return;
  }
  const queue = parseReviewQueue(await readBounded(one("--queue")));
  const locator = parseReviewLocator(await readBounded(one("--map")), queue, manifest);
  const bundles = await loadVerifiedBundles(queue, locator, flags.get("--blinded-dir")!, flags.get("--source-dir")!);
  if (command === "convert") {
    const reviewSet = flags.get("--review-set")?.[0];
    if (reviewSet !== undefined && !["frame-candidate", "frame-complete"].includes(reviewSet))
      throw new Error("Invalid review set.");
    const converted = reviewSet?.startsWith("frame-")
      ? convertOfflineFrameExport(await readBounded(one("--ratings")), queue, locator, manifest, bundles)
      : convertOfflineReviewExport(await readBounded(one("--ratings")), queue, locator, manifest, bundles);
    await privateWrite(one("--output"), `${JSON.stringify(converted, null, 2)}\n`);
  } else {
    const reviewSet = flags.get("--review-set")?.[0];
    if (
      reviewSet !== undefined &&
      !["calibration", "flagged", "visible-enriched", "frame-candidate", "frame-complete"].includes(reviewSet)
    )
      throw new Error("Invalid review set.");
    await privateWrite(
      one("--output"),
      buildOfflineReviewHtml(
        queue,
        bundles,
        (reviewSet ?? null) as
          | "calibration"
          | "flagged"
          | "visible-enriched"
          | "frame-candidate"
          | "frame-complete"
          | null,
      ),
    );
  }
  process.stdout.write("Private review artifact created.\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write("Private review input or output invalid.\n");
    process.exitCode = 1;
  });
