import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PreflightStore } from "../server/preflight-store.js";
import { RoomStore } from "../server/room-store.js";
import type { DiscoveryStatus, ModelAvailability } from "../shared/model-discovery.js";
import {
  collectLiveScenarioEvidence,
  type LiveScenarioResult,
  readRoutingEvents,
} from "./conversation-routing-live-evidence.js";
import {
  JudgeFailure,
  type JudgeFailureCategory,
  type JudgeScalarResult,
  judgeConversationCase,
  parsePrivateJudgeCase,
} from "./conversation-routing-live-judge.js";
import {
  judgeConversationQualityAxes,
  parsePrivateQualityCase,
  type QualityAxisOutcome,
} from "./conversation-routing-live-judge-v2.js";
import {
  buildLiveScenario,
  FIXTURE_AGENTS,
  type LiveScenario,
  pilotScenarios,
  ROUTING_DYNAMICS,
  ROUTING_ENERGIES,
  ROUTING_MODES,
  type RoutingDynamic,
} from "./conversation-routing-live-scenarios.js";
import {
  expandStudyPlan,
  MAX_STUDY_CASES,
  parseStudyPlan,
  STUDY_AGENT_BASE_PROMPTS,
  type StudyPlanV1,
  studyPlanDigest,
} from "./conversation-routing-live-study.js";
import { createLiveOpenCodeWrapper } from "./conversation-routing-live-wrapper.js";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = /^[A-Za-z0-9._-]{10,300}$/;
const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{1,150}$/i;
const MAX_PILOT_CASES = 12;
const MAX_WIDE_CASES = 36;
const MAX_BATCH_PAIRS = 6;
const SOURCE_FILES = [
  "scripts/conversation-routing-live-canary.ts",
  "scripts/conversation-routing-live-evidence.ts",
  "scripts/conversation-routing-live-scenarios.ts",
  "scripts/conversation-routing-live-study.ts",
  "scripts/conversation-routing-live-wrapper.ts",
  "scripts/conversation-routing-live-judge.ts",
  "scripts/conversation-routing-live-judge-v2.ts",
  "scripts/conversation-routing-live-annotations.ts",
  "server/agent-runner.ts",
  "server/agent-behavior.ts",
  "server/conversation.ts",
  "server/room-configuration.ts",
  "server/preflight-gate.ts",
  "server/intent-classifier.ts",
  "server/jev-experiment-profiles.ts",
  "server/index.ts",
  "server/structured-room-turn.ts",
  "shared/agent-behavior.ts",
  "shared/conversation-energy.ts",
  "shared/direct-address.ts",
  "shared/preflight.ts",
] as const;

async function sourceDigest() {
  const hash = createHash("sha256");
  for (const file of SOURCE_FILES) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(repositoryRoot, file)));
  }
  return hash.digest("hex");
}

interface CanaryOptions {
  cases: LiveScenario[];
  model: string;
  command: string;
  secretLauncher: string;
  judgeModel?: string;
  privateReviewDirectory?: string;
  maxCases: number;
  maxGenerations: number;
  timeoutMs: number;
  totalTimeoutMs: number;
  allowWideMatrix: boolean;
  requireVisible: boolean;
  dryRun: boolean;
  studyPlan?: StudyPlanV1;
  studyBatch?: StudyBatchMetadataV1;
  jevModel?: string;
  judgeRubric: "v1" | "v2";
  maxJudgeCalls: number;
  planningAllowanceMs: number;
}

export interface StudyBatchMetadataV1 {
  schemaVersion: 1;
  planCaseCount: number;
  planPairCount: number;
  batchIndex: number;
  batchCount: number;
  pairsPerBatch: number;
  pairCount: number;
  pairIds: string[];
}

function positiveInteger(raw: string | undefined, label: string, maximum: number, fallback: number) {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} is out of range.`);
  return parsed;
}

function scenarioTriggerCount(scenario: LiveScenario) {
  return 1 + (scenario.scriptedFollowups?.length ?? (scenario.followup ? 1 : 0));
}

/** OpenRouter may resolve a pinned Jev release to its dated snapshot. */
export function matchesPinnedJevResolution(requested: string, resolved: string): boolean {
  if (resolved === requested) return true;
  if (!resolved.startsWith(`${requested}-`)) return false;
  const date = resolved.slice(requested.length + 1);
  if (!/^\d{8}$/.test(date)) return false;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function customScenario(raw: string): LiveScenario {
  const parts = raw.split(":");
  if (parts.length !== 5) throw new Error("Custom case must be dynamic:agents:energy:mode:jev-on|jev-off.");
  const [dynamic, rawCount, energy, preflightMode, classifier] = parts;
  const agentCount = Number(rawCount);
  if (
    !ROUTING_DYNAMICS.includes(dynamic as RoutingDynamic) ||
    ![1, 2, 3, 4].includes(agentCount) ||
    !ROUTING_ENERGIES.includes(energy as LiveScenario["energy"]) ||
    !ROUTING_MODES.includes(preflightMode as LiveScenario["preflightMode"]) ||
    !["jev-on", "jev-off"].includes(classifier ?? "")
  )
    throw new Error("Custom case selection is invalid.");
  if (preflightMode === "off" && classifier === "jev-on")
    throw new Error("Jev cannot be consulted when initial preflight is off.");
  return buildLiveScenario({
    dynamic: dynamic as RoutingDynamic,
    agentCount: agentCount as LiveScenario["agentCount"],
    energy: energy as LiveScenario["energy"],
    preflightMode: preflightMode as LiveScenario["preflightMode"],
    classifierEnabled: classifier === "jev-on",
  });
}

/** Parsing is provider-free and gives the paid runner a closed, auditable case list. */
export function parseLiveCanaryOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  studyPlan?: StudyPlanV1,
): CanaryOptions {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const valueless = new Set([
    "--pilot",
    "--allow-wide-matrix",
    "--allow-large-study",
    "--require-visible",
    "--dry-run",
  ]);
  const valued = new Set([
    "--case",
    "--model",
    "--opencode",
    "--secret-launcher",
    "--judge-model",
    "--retain-private-review",
    "--max-cases",
    "--max-generations",
    "--timeout-ms",
    "--total-timeout-ms",
    "--study-plan",
    "--jev-model",
    "--judge-rubric",
    "--max-judge-calls",
    "--batch-index",
    "--pairs-per-batch",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (valueless.has(arg)) {
      if (flags.has(arg)) throw new Error("Duplicate canary flag.");
      flags.add(arg);
      continue;
    }
    if (!valued.has(arg) || !argv[index + 1] || argv[index + 1]!.startsWith("--"))
      throw new Error("Unknown or incomplete canary option.");
    values.set(arg, [...(values.get(arg) ?? []), argv[++index]!]);
  }
  for (const [key, entries] of values)
    if (key !== "--case" && entries.length !== 1) throw new Error("Duplicate canary option.");
  const selectedInputs =
    Number(flags.has("--pilot")) + Number(values.has("--case")) + Number(values.has("--study-plan"));
  if (selectedInputs !== 1 || Boolean(studyPlan) !== values.has("--study-plan"))
    throw new Error("Choose one pilot, case list, or validated study plan.");
  if (studyPlan && flags.has("--require-visible"))
    throw new Error("Study plans must retain quiet outcomes; --require-visible is not allowed.");
  const allowWideMatrix = flags.has("--allow-wide-matrix");
  const allowLargeStudy = flags.has("--allow-large-study");
  if (allowLargeStudy && !studyPlan) throw new Error("Large-study opt-in requires a validated study plan.");
  const allCases = studyPlan
    ? expandStudyPlan(studyPlan)
    : flags.has("--pilot")
      ? pilotScenarios()
      : (values.get("--case") ?? []).map(customScenario);
  if (!allowWideMatrix && allCases.some(({ agentCount }) => agentCount > 3))
    throw new Error("Four-agent cases require --allow-wide-matrix.");
  const batchIndexRaw = values.get("--batch-index")?.[0];
  const pairsPerBatchRaw = values.get("--pairs-per-batch")?.[0];
  if (Boolean(batchIndexRaw) !== Boolean(pairsPerBatchRaw) || (batchIndexRaw && !studyPlan))
    throw new Error("Batch index and pairs per batch require one validated study plan.");
  if (studyPlan && allCases.length > MAX_PILOT_CASES && !batchIndexRaw)
    throw new Error("Expanded studies require an explicit whole-pair batch selection.");
  let studyBatch: StudyBatchMetadataV1 | undefined;
  let cases = allCases;
  if (studyPlan && batchIndexRaw && pairsPerBatchRaw) {
    const pairsPerBatch = positiveInteger(pairsPerBatchRaw, "Pairs per batch", MAX_BATCH_PAIRS, MAX_BATCH_PAIRS);
    const planPairCount = studyPlan.blocks.length;
    const batchCount = Math.ceil(planPairCount / pairsPerBatch);
    const batchIndex = Number(batchIndexRaw);
    if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 || batchIndex >= batchCount)
      throw new Error("Study batch index is out of range.");
    const firstPair = batchIndex * pairsPerBatch;
    cases = allCases.slice(firstPair * 2, Math.min(planPairCount, firstPair + pairsPerBatch) * 2);
    const pairIds = [...new Set(cases.map(({ study }) => study?.pairId))];
    const adjacentPairs = Array.from({ length: cases.length / 2 }, (_, pair) => {
      const first = cases[pair * 2]?.study;
      const second = cases[pair * 2 + 1]?.study;
      return Boolean(first?.pairId && first.pairId === second?.pairId && first.arm !== second.arm);
    });
    if (
      cases.length === 0 ||
      cases.length !== pairIds.length * 2 ||
      pairIds.some((pairId) => !pairId) ||
      adjacentPairs.some((matched) => !matched)
    )
      throw new Error("Study batch is not composed of complete pairs.");
    studyBatch = {
      schemaVersion: 1,
      planCaseCount: allCases.length,
      planPairCount,
      batchIndex,
      batchCount,
      pairsPerBatch,
      pairCount: pairIds.length,
      pairIds: pairIds as string[],
    };
  }
  const upperLimit = allowLargeStudy ? MAX_STUDY_CASES : allowWideMatrix ? MAX_WIDE_CASES : MAX_PILOT_CASES;
  const maxCases = positiveInteger(
    values.get("--max-cases")?.[0],
    "Maximum cases",
    upperLimit,
    studyPlan?.maxCases ?? MAX_PILOT_CASES,
  );
  if (studyPlan && (studyPlan.maxCases > upperLimit || maxCases > studyPlan.maxCases || allCases.length > maxCases))
    throw new Error("Study plan exceeds its explicit case cap.");
  if (cases.length > maxCases) throw new Error("Selected cases exceed the case limit.");
  if (new Set(cases.map(({ scenarioId, variant }) => `${scenarioId}:${variant}`)).size !== cases.length)
    throw new Error("Duplicate scenario variants are not allowed.");
  const model = values.get("--model")?.[0] ?? env.AMFAA_ROUTING_ROOM_MODEL ?? "";
  const command = values.get("--opencode")?.[0] ?? env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND ?? "";
  const secretLauncher = values.get("--secret-launcher")?.[0] ?? env.AMFAA_ROUTING_SECRET_LAUNCHER ?? "";
  const dryRun = flags.has("--dry-run");
  const jevModel = values.get("--jev-model")?.[0];
  if (studyPlan && (!jevModel || !MODEL.test(`openrouter/${jevModel}`) || /(?:^|\/)(?:auto|latest)$/.test(jevModel)))
    throw new Error("Study plans require a concrete pinned Jev model ID.");
  if (!MODEL.test(model) || model.endsWith("/auto") || (!dryRun && !path.isAbsolute(command)))
    throw new Error("A concrete OpenRouter model and absolute audited OpenCode command are required.");
  if (!dryRun && !path.isAbsolute(secretLauncher)) throw new Error("An absolute secret launcher is required.");
  if (dryRun && !studyPlan) throw new Error("Dry-run requires a validated study plan.");
  const judgeModel = values.get("--judge-model")?.[0];
  if (judgeModel && (!MODEL.test(judgeModel) || judgeModel.endsWith("/auto") || judgeModel === model))
    throw new Error("Judge model must be a different pinned OpenRouter model.");
  const judgeRubric = values.get("--judge-rubric")?.[0] ?? "v1";
  if (!["v1", "v2"].includes(judgeRubric) || (judgeRubric === "v2" && !judgeModel))
    throw new Error("Quality rubric v2 requires a distinct pinned judge model.");
  const maxJudgeCalls = cases.reduce(
    (sum, scenario) => sum + (judgeModel ? (judgeRubric === "v2" ? 4 : 1) * scenarioTriggerCount(scenario) : 0),
    0,
  );
  const explicitJudgeCap = values.get("--max-judge-calls")?.[0];
  if (studyPlan && judgeModel && !explicitJudgeCap) throw new Error("Live study requires an explicit judge-call cap.");
  if (explicitJudgeCap && positiveInteger(explicitJudgeCap, "Maximum judge calls", 144, maxJudgeCalls) < maxJudgeCalls)
    throw new Error("Selected study exceeds the judge-call cap.");
  if (maxJudgeCalls > 144) throw new Error("Selected study exceeds the judge-call ceiling.");
  const timeoutMs = positiveInteger(values.get("--timeout-ms")?.[0], "Scenario timeout", 180_000, 120_000);
  const maxGenerations = positiveInteger(
    values.get("--max-generations")?.[0],
    "Maximum generations",
    studyPlan ? 24 : 12,
    8,
  );
  if (studyPlan && cases.some((scenario) => scenario.agentCount * scenarioTriggerCount(scenario) > maxGenerations))
    throw new Error("Study generation-start cap is below its roster-by-trigger planning minimum.");
  const totalTimeoutMs = positiveInteger(
    values.get("--total-timeout-ms")?.[0],
    "Total timeout",
    studyPlan ? 10_800_000 : 3_600_000,
    2_400_000,
  );
  const planningAllowanceMs =
    cases.reduce((sum, scenario) => sum + 40_000 + scenarioTriggerCount(scenario) * (timeoutMs + 5_000), 0) +
    maxJudgeCalls * 30_000;
  if (studyPlan && !values.has("--total-timeout-ms"))
    throw new Error("Live study requires an explicit total watchdog.");
  if (studyPlan && !flags.has("--dry-run") && totalTimeoutMs < planningAllowanceMs)
    throw new Error("Total watchdog is shorter than the study planning allowance.");
  const privateReviewDirectory = values.get("--retain-private-review")?.[0];
  if (privateReviewDirectory && !path.isAbsolute(privateReviewDirectory))
    throw new Error("Private review directory must be absolute.");
  return {
    cases,
    model,
    command,
    secretLauncher,
    ...(judgeModel ? { judgeModel } : {}),
    ...(privateReviewDirectory ? { privateReviewDirectory } : {}),
    maxCases,
    maxGenerations,
    timeoutMs,
    totalTimeoutMs,
    allowWideMatrix,
    requireVisible: flags.has("--require-visible"),
    dryRun,
    ...(studyPlan ? { studyPlan } : {}),
    ...(studyBatch ? { studyBatch } : {}),
    ...(jevModel ? { jevModel } : {}),
    judgeRubric: judgeRubric as "v1" | "v2",
    maxJudgeCalls,
    planningAllowanceMs,
  };
}

function processGroupSignal(child: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* Already exited. */
    }
  }
}

export async function stopProcessGroup(child: ChildProcess | undefined) {
  if (!child) return;
  const running = child.exitCode === null && child.signalCode === null;
  const exit = running
    ? once(child, "exit").then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
  processGroupSignal(child, "SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exit,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 3_000);
    }),
  ]);
  clearTimeout(timer);
  // A leader can exit while an OpenCode descendant remains in the same group.
  processGroupSignal(child, "SIGKILL");
  await Promise.race([
    exit,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 1_000);
    }),
  ]);
  clearTimeout(timer);
}

async function unusedLoopbackPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Loopback port allocation failed.");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function until<T>(check: () => Promise<T | undefined>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Isolated room evidence deadline elapsed.");
}

async function requestJson(
  base: string,
  route: string,
  cookie: string | undefined,
  body?: unknown,
  csrfToken?: string,
  timeoutMs = 10_000,
): Promise<{ status: number; json: Record<string, unknown>; cookie?: string }> {
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(csrfToken ? { "x-amfaa-csrf": csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    json,
    ...(response.headers.get("set-cookie") ? { cookie: response.headers.get("set-cookie")!.split(";")[0] } : {}),
  };
}

const DISCOVERY_STATUSES: readonly DiscoveryStatus[] = [
  "available",
  "cli_missing",
  "authentication_required",
  "configuration_required",
  "discovery_unsupported",
  "runtime_incompatible",
  "error",
];
type AvailabilityReason = NonNullable<ModelAvailability["reason"]>;
const AVAILABILITY_REASONS: readonly AvailabilityReason[] = [
  "runtime_unavailable",
  "model_removed",
  "provider_removed",
  "variant_removed",
  "reasoning_effort_removed",
  "variant_conflict",
  "selection_unpinnable",
];

export interface AvailabilityCheckV1 {
  initialDiscoveryStatus: DiscoveryStatus;
  initialUnavailableReasons: AvailabilityReason[];
  refreshAttempted: boolean;
  finalDiscoveryStatus: DiscoveryStatus;
  finalUnavailableReasons: AvailabilityReason[];
  recovered: boolean;
}

function projectAvailabilityCheck(check: AvailabilityCheckV1): AvailabilityCheckV1 {
  return {
    initialDiscoveryStatus: check.initialDiscoveryStatus,
    initialUnavailableReasons: [...check.initialUnavailableReasons],
    refreshAttempted: check.refreshAttempted,
    finalDiscoveryStatus: check.finalDiscoveryStatus,
    finalUnavailableReasons: [...check.finalUnavailableReasons],
    recovered: check.recovered,
  };
}

function rosterAvailabilitySnapshot(
  response: Awaited<ReturnType<typeof requestJson>>,
  selectedAgentIds: readonly string[],
) {
  if (response.status !== 200 || !selectedAgentIds.length) throw new Error("Isolated room roster check failed.");
  const discovery = response.json.modelDiscovery;
  const status =
    discovery && typeof discovery === "object" && !Array.isArray(discovery)
      ? (discovery as { status?: unknown }).status
      : undefined;
  if (!DISCOVERY_STATUSES.includes(status as DiscoveryStatus)) throw new Error("Invalid closed discovery status.");
  const entries = response.json.participantAvailability;
  if (!entries || typeof entries !== "object" || Array.isArray(entries))
    throw new Error("Invalid closed participant availability.");
  const availability = entries as Record<string, unknown>;
  const reasons: AvailabilityReason[] = [];
  let allAvailable = true;
  for (const agentId of selectedAgentIds) {
    const entry = availability[agentId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid closed participant availability.");
    const selected = entry as { available?: unknown; reason?: unknown };
    if (selected.available === true) continue;
    if (selected.available !== false || !AVAILABILITY_REASONS.includes(selected.reason as AvailabilityReason))
      throw new Error("Invalid closed participant availability.");
    allAvailable = false;
    reasons.push(selected.reason as AvailabilityReason);
  }
  return {
    status: status as DiscoveryStatus,
    reasons: [...new Set(reasons)].sort() as AvailabilityReason[],
    available: allAvailable && (status === "available" || status === "discovery_unsupported"),
    csrfToken:
      response.json.access && typeof response.json.access === "object"
        ? (response.json.access as { kind?: unknown; csrfToken?: unknown })
        : undefined,
  };
}

/** The only recovery is one authenticated catalog refresh before any human prompt. */
export async function checkIsolatedRosterAvailability(
  base: string,
  cookie: string,
  selectedAgentIds: readonly string[],
) {
  const initial = rosterAvailabilitySnapshot(await requestJson(base, "/api/roster", cookie), selectedAgentIds);
  const initialCheck: AvailabilityCheckV1 = {
    initialDiscoveryStatus: initial.status,
    initialUnavailableReasons: initial.reasons,
    refreshAttempted: false,
    finalDiscoveryStatus: initial.status,
    finalUnavailableReasons: initial.reasons,
    recovered: false,
  };
  if (
    initial.available ||
    initial.status !== "error" ||
    initial.reasons.length !== 1 ||
    initial.reasons[0] !== "runtime_unavailable"
  )
    return { available: initial.available, check: initialCheck };
  if (
    initial.csrfToken?.kind !== "room-member" ||
    typeof initial.csrfToken.csrfToken !== "string" ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(initial.csrfToken.csrfToken)
  )
    return { available: false, check: initialCheck };
  const attempted: AvailabilityCheckV1 = { ...initialCheck, refreshAttempted: true };
  try {
    const refreshed = await requestJson(
      base,
      "/api/model-discovery/refresh",
      cookie,
      {},
      initial.csrfToken.csrfToken,
      30_000,
    );
    if (refreshed.status !== 200) return { available: false, check: attempted };
    const final = rosterAvailabilitySnapshot(await requestJson(base, "/api/roster", cookie), selectedAgentIds);
    const available = final.available && final.status === "available";
    return {
      available,
      check: {
        ...attempted,
        finalDiscoveryStatus: final.status,
        finalUnavailableReasons: final.reasons,
        recovered: available,
      },
    };
  } catch {
    return { available: false, check: attempted };
  }
}

interface CaseResult {
  schemaVersion: 1;
  scenarioId: string;
  variant: "jev-on" | "jev-off";
  agentCount: number;
  energy: string;
  preflightMode: string;
  triggers: LiveScenarioResult[];
  judge: JudgeScalarResult[];
  qualityJudge?: Array<{ scenarioId: string; runId: string; outcomes: QualityAxisOutcome[] }>;
  privateReviewRetained: boolean;
  availabilityCheck: AvailabilityCheckV1;
  study?: NonNullable<LiveScenario["study"]>;
}

/** A batch exposes progress only once both arms of one matched pair have completed. */
export function projectPairCompleteProgress<T extends { study?: { pairId: string; arm: "a" | "b" } }>(
  completedCases: readonly T[],
) {
  if (completedCases.length === 0 || completedCases.length % 2 !== 0) return null;
  const cases = completedCases.slice(-2);
  const pairId = cases[0]?.study?.pairId;
  if (!pairId || cases[1]?.study?.pairId !== pairId || cases[0]?.study?.arm === cases[1]?.study?.arm)
    throw new Error("Completed batch cases did not form a matched pair.");
  return { event: "pair-complete" as const, pairId, cases, completedPairs: completedCases.length / 2 };
}

type FailureStage =
  | "fixture"
  | "startup"
  | "availability"
  | "trigger"
  | "evidence"
  | "classifier"
  | "delivery"
  | "judge"
  | "cleanup";
type FailureCategory =
  | "timeout"
  | "unavailable"
  | "limit"
  | "missing-proof"
  | "model-mismatch"
  | "fixture-changed"
  | "internal";
class CaseFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly category: FailureCategory,
    readonly triggers: readonly LiveScenarioResult[] = [],
    readonly judgeCategory: JudgeFailureCategory | null = null,
    readonly availabilityCheck?: AvailabilityCheckV1,
  ) {
    super("Isolated live case failed.");
  }
}

const ATTRIBUTION_TRIGGER_CATEGORIES = new Set([
  "visible-delivered",
  "gate-suppressed",
  "routing-unavailable",
  "generation-failed",
  "completed-yielded",
  "completed-no-delivery",
  "mixed-or-unresolved",
]);
const ATTRIBUTION_GENERATION_CATEGORIES = new Set([
  "delivered",
  "yielded",
  "undelivered",
  "completed-no-delivery-evidence",
  "failed",
  "cancelled",
  "incomplete",
]);

function projectNoVisibleAttribution(value: LiveScenarioResult["noVisibleAttributionV1"]) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !ATTRIBUTION_TRIGGER_CATEGORIES.has(value.category) ||
    !Array.isArray(value.generations) ||
    value.generations.length > 100 ||
    value.generations.some(
      (entry, index) =>
        !entry ||
        typeof entry !== "object" ||
        entry.ordinal !== index + 1 ||
        !ATTRIBUTION_GENERATION_CATEGORIES.has(entry.category),
    )
  )
    return undefined;
  return {
    schemaVersion: 1 as const,
    category: value.category,
    generations: value.generations.map(({ ordinal, category }) => ({ ordinal, category })),
  };
}

/** Preserve only the collector's closed scalar fields when a case stops after routing. */
export function projectFailedCaseEvidence(result: LiveScenarioResult): LiveScenarioResult {
  const noVisibleAttributionV1 = projectNoVisibleAttribution(result.noVisibleAttributionV1);
  return {
    schemaVersion: result.schemaVersion,
    openCodeUsageProvenance: result.openCodeUsageProvenance,
    scenarioId: result.scenarioId,
    variant: result.variant,
    runId: result.runId,
    preflightMode: result.preflightMode,
    requiredAddressAgents: result.requiredAddressAgents,
    routing: result.routing.map(({ agentId, outcome, reason }) => ({ agentId, outcome, reason })),
    classifier: {
      outcome: result.classifier.outcome,
      reason: result.classifier.reason,
      resolvedModelId: result.classifier.resolvedModelId,
      durationMs: result.classifier.durationMs,
      reportedInputTokens: result.classifier.reportedInputTokens,
      reportedOutputTokens: result.classifier.reportedOutputTokens,
      reportedCostUsd: result.classifier.reportedCostUsd,
    },
    queueDelayMs: result.queueDelayMs,
    firstVisibleMs: result.firstVisibleMs,
    terminalReason: result.terminalReason,
    attemptedTurns: result.attemptedTurns,
    respondedTurns: result.respondedTurns,
    yieldedTurns: result.yieldedTurns,
    confirmedDeliveredBursts: result.confirmedDeliveredBursts,
    generationStarts: result.generationStarts,
    generationCompletions: result.generationCompletions,
    generationFailures: result.generationFailures,
    ...(noVisibleAttributionV1 ? { noVisibleAttributionV1 } : {}),
    openCodeObservedInputTokens: result.openCodeObservedInputTokens,
    openCodeObservedOutputTokens: result.openCodeObservedOutputTokens,
    openCodeObservedReasoningTokens: result.openCodeObservedReasoningTokens,
    openCodeObservedCacheReadTokens: result.openCodeObservedCacheReadTokens,
    openCodeObservedCacheWriteTokens: result.openCodeObservedCacheWriteTokens,
    openCodeObservedTotalTokens: result.openCodeObservedTotalTokens,
    openCodeEstimatedCostUsd: result.openCodeEstimatedCostUsd,
    openCodeUsageCoverage: result.openCodeUsageCoverage,
    openCodeTotalCoverage: result.openCodeTotalCoverage,
  };
}
export function projectCaseFailedEvent(input: {
  scenarioId: string;
  variant: "jev-on" | "jev-off";
  stage: FailureStage;
  category: FailureCategory;
  completedCases: number;
  triggers: readonly LiveScenarioResult[];
  judgeCategory: JudgeFailureCategory | null;
  availabilityCheck?: AvailabilityCheckV1;
  study?: NonNullable<LiveScenario["study"]>;
}) {
  return {
    event: "case-failed" as const,
    scenarioId: input.scenarioId,
    variant: input.variant,
    stage: input.stage,
    category: input.category,
    completedCases: input.completedCases,
    observedTriggers: input.triggers.map(projectFailedCaseEvidence),
    ...(input.judgeCategory ? { judgeCategory: input.judgeCategory } : {}),
    ...(input.availabilityCheck ? { availabilityCheck: projectAvailabilityCheck(input.availabilityCheck) } : {}),
    ...(input.study ? { study: input.study } : {}),
  };
}
function failureCategory(error: unknown): FailureCategory {
  const message = error instanceof Error ? error.message : "";
  if (message === "Isolated room evidence deadline elapsed.") return "timeout";
  if (message === "Selected OpenCode participant is unavailable.") return "unavailable";
  if (message === "Observed generation cap exceeded." || message === "Observed turn cap exceeded.") return "limit";
  if (
    message === "Jev completion proof is missing." ||
    message === "Visible delivery proof is missing." ||
    message === "Conversation run evidence is incomplete." ||
    message === "Trigger consumption or terminal evidence is incomplete."
  )
    return "missing-proof";
  if (message === "Disposable fixture project changed.") return "fixture-changed";
  if (message === "Jev provider-resolved model differs from the pinned study model.") return "model-mismatch";
  return "internal";
}

function privateKind(dynamic: LiveScenario["dynamic"], followup: boolean) {
  if (followup && dynamic === "disagreement") return "resolved" as const;
  if (dynamic === "multi-address" || dynamic === "direct") return "direct" as const;
  if (dynamic === "quoted-name") return "casual" as const;
  return dynamic;
}

async function writePrivateReview(
  directory: string,
  scenario: LiveScenario,
  result: LiveScenarioResult,
  prompt: string,
  expectedDirectAgents: readonly string[],
  messages: unknown[],
  followup: boolean,
  qualityV2 = false,
) {
  const payload = buildPrivateReviewPayload(
    scenario,
    result,
    prompt,
    expectedDirectAgents,
    messages,
    followup,
    qualityV2,
  );
  const file = path.join(
    directory,
    `${scenario.scenarioId}-${scenario.variant}-${followup ? "resolution" : "opening"}-${result.runId}.json`,
  );
  await writeFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
  return payload;
}

export function buildPrivateReviewPayload(
  scenario: LiveScenario,
  result: LiveScenarioResult,
  prompt: string,
  expectedDirectAgents: readonly string[],
  messages: unknown[],
  followup: boolean,
  qualityV2: boolean,
) {
  const v1 = parsePrivateJudgeCase({
    schemaVersion: 1,
    scenarioId: result.scenarioId,
    runId: result.runId,
    scenarioKind: privateKind(scenario.dynamic, followup),
    expectedDirectAgents,
    prompt,
    messages: messages.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const message = value as { speaker?: unknown; kind?: unknown; text?: unknown };
      if (typeof message.text !== "string" || message.kind !== "chat") return [];
      if (message.speaker === "you") return [{ speaker: "avery", kind: "human", text: message.text }];
      if (FIXTURE_AGENTS.some(({ agentId }) => agentId === message.speaker))
        return [{ speaker: message.speaker, kind: "agent", text: message.text }];
      return [];
    }),
  });
  const payload = qualityV2
    ? parsePrivateQualityCase({
        ...v1,
        schemaVersion: 2,
        qualityContext: {
          originalHumanAlias: "Avery",
          roster: (
            scenario.rosterOrder ?? FIXTURE_AGENTS.slice(0, scenario.agentCount).map(({ agentId }) => agentId)
          ).map((agentId) => ({
            agentId,
            conversationalName: FIXTURE_AGENTS.find((agent) => agent.agentId === agentId)!.name,
          })),
        },
      })
    : v1;
  return payload;
}

async function runCase(
  scenario: LiveScenario,
  options: CanaryOptions,
  credential: string,
  abort: AbortSignal,
  privateDirectory: string | undefined,
): Promise<CaseResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-routing-canary-"));
  await chmod(root, 0o700);
  const project = path.join(root, "project");
  const data = path.join(root, "room");
  const xdgData = path.join(root, "xdg-data");
  let child: ChildProcess | undefined;
  let stage: FailureStage = "fixture";
  let availabilityCheck: AvailabilityCheckV1 | undefined;
  const triggerResults: LiveScenarioResult[] = [];
  try {
    await mkdir(project, { mode: 0o700 });
    const { wrapperPath } = await createLiveOpenCodeWrapper({
      root,
      realCommand: options.command,
      secretLauncher: options.secretLauncher,
      launcherHome: process.env.HOME ?? root,
      isolatedHome: root,
      modelId: options.model.slice("openrouter/".length),
    });
    await execute("git", ["init", "-b", "main", project], {
      timeout: 10_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    await execute(
      "git",
      [
        "-C",
        project,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--no-verify",
        "--allow-empty",
        "-m",
        "Fixture",
      ],
      { timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    const store = await RoomStore.open(project, data);
    await store.updateSettings({ conversationEnergy: scenario.energy });
    await store.updateRoomConfiguration(
      {
        preflightMode: scenario.preflightMode,
        intentClassifierEnabled: scenario.classifierEnabled,
        summarizerModel: null,
        ...(scenario.study ? { basePromptText: STUDY_AGENT_BASE_PROMPTS[scenario.study.agentPromptProfileId] } : {}),
      },
      "fixture-owner",
    );
    const selectedAgents = scenario.rosterOrder
      ? scenario.rosterOrder.map((agentId) => FIXTURE_AGENTS.find((entry) => entry.agentId === agentId)!)
      : FIXTURE_AGENTS.slice(0, scenario.agentCount);
    const roster = selectedAgents.map(({ agentId, name }) => ({
      agentId,
      conversationalName: name,
      providerId: "openrouter",
      modelId: options.model.slice("openrouter/".length),
      enabled: true,
      supportsProjectWrites: false,
      configurationRevision: 1,
      commandPermissions: { allowAll: false, allowed: [] as Array<"help"> },
    }));
    const update = await store.updateRoster(store.snapshot().roster!.revision, roster);
    assert.equal(update.kind, "accepted");
    const port = await unusedLoopbackPort();
    const base = `http://127.0.0.1:${port}`;
    stage = "startup";
    child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_DATA_HOME: xdgData,
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_CACHE_HOME: path.join(root, "xdg-cache"),
        XDG_STATE_HOME: path.join(root, "xdg-state"),
        TMPDIR: root,
        NODE_ENV: "test",
        OPENROUTER_API_KEY: credential,
        ALL_MY_FRIENDS_ARE_AGENTS_HOST: "127.0.0.1",
        ALL_MY_FRIENDS_ARE_AGENTS_PORT: String(port),
        ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND: "json",
        ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR: data,
        ALL_MY_FRIENDS_ARE_AGENTS_PROJECT_PATH: project,
        ALL_MY_FRIENDS_ARE_AGENTS_ASSIGNMENT_WORKTREES_DIR: path.join(root, "assignments"),
        ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND: wrapperPath,
        ALL_MY_FRIENDS_ARE_AGENTS_AGENT_CONCURRENCY: "1",
        ALL_MY_FRIENDS_ARE_AGENTS_ROOM_CONCURRENCY: "1",
        ALL_MY_FRIENDS_ARE_AGENTS_GLOBAL_CONCURRENCY: "1",
        ALL_MY_FRIENDS_ARE_AGENTS_INTENT_CLASSIFIER_DISABLED: scenario.classifierEnabled ? "false" : "true",
        ...(options.jevModel ? { ALL_MY_FRIENDS_ARE_AGENTS_INTENT_CLASSIFIER_MODEL: options.jevModel } : {}),
        ...(scenario.study
          ? {
              AMFAA_ROUTING_STUDY_ISOLATED: "true",
              ...(scenario.study.jevProfileId === "off-v1"
                ? {}
                : { AMFAA_ROUTING_JEV_PROFILE: scenario.study.jevProfileId }),
              AMFAA_ROUTING_GATE_PROFILE: scenario.study.gateProfileId,
            }
          : {}),
      },
    });
    await until(
      async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null)
          throw new Error("Isolated room exited before readiness.");
        try {
          const response = await fetch(base + "/api/ready", { signal: AbortSignal.timeout(500) });
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      30_000,
      abort,
    );
    const joined = await requestJson(base, "/api/humans", undefined, { name: "Avery" });
    if (joined.status !== 201 || !joined.cookie) throw new Error("Isolated room membership failed.");
    const cookie = joined.cookie;
    stage = "availability";
    const checked = await checkIsolatedRosterAvailability(
      base,
      cookie,
      roster.map(({ agentId }) => agentId),
    );
    availabilityCheck = checked.check;
    if (!checked.available) throw new Error("Selected OpenCode participant is unavailable.");
    const judgments: JudgeScalarResult[] = [];
    const qualityJudgments: NonNullable<CaseResult["qualityJudge"]> = [];
    const prompts = [
      {
        scenarioId: scenario.scenarioId,
        text: scenario.text,
        expected: scenario.expectedDirectAgents,
        followup: false,
      },
      ...(scenario.followup
        ? [
            {
              scenarioId: scenario.followup.scenarioId,
              text: scenario.followup.text,
              expected: scenario.followup.expectedDirectAgents,
              followup: true,
            },
          ]
        : []),
      ...(scenario.scriptedFollowups?.map((followup) => ({
        scenarioId: followup.scenarioId,
        text: followup.text,
        expected: followup.expectedDirectAgents,
        followup: true,
      })) ?? []),
    ];
    for (const prompt of prompts) {
      abort.throwIfAborted();
      stage = "trigger";
      const accepted = await requestJson(base, "/api/messages", cookie, {
        text: prompt.text,
        clientMessageId: `canary_${randomUUID().replaceAll("-", "")}`,
      });
      if (accepted.status !== 202 || typeof accepted.json.messageId !== "string")
        throw new Error("Isolated room trigger was not accepted.");
      const triggerMessageId = accepted.json.messageId;
      stage = "evidence";
      const records = await until(
        async () => {
          const current = await readRoutingEvents(path.join(data, "logs", "authoritative-v1")).catch(() => []);
          const starts = current.filter((record) => record.event === "generation.started").length;
          if (starts > options.maxGenerations) throw new Error("Observed generation cap exceeded.");
          const hasTerminal = current.some(
            (record) =>
              record.event === "conversation.trigger.stage" &&
              record.triggerMessageId === triggerMessageId &&
              record.stage === "terminal",
          );
          const hasRunComplete = current.some(
            (record) =>
              record.event === "conversation.run.completed" &&
              record.jobId ===
                current.find(
                  (record) =>
                    record.event === "conversation.trigger.stage" &&
                    record.triggerMessageId === triggerMessageId &&
                    record.stage === "consumed",
                )?.jobId,
          );
          return hasTerminal && hasRunComplete ? current : undefined;
        },
        options.timeoutMs,
        abort,
      );
      // Wait for the queue's settled marker so a follow-up cannot interrupt the previous run.
      await until(
        async () => {
          const current = await readRoutingEvents(path.join(data, "logs", "authoritative-v1"));
          return current.some(
            (record) =>
              record.event === "conversation.trigger.stage" &&
              record.triggerMessageId === triggerMessageId &&
              record.stage === "settled",
          )
            ? true
            : undefined;
        },
        5_000,
        abort,
      );
      const preflight = await PreflightStore.open(data);
      const latestRecords = await readRoutingEvents(path.join(data, "logs", "authoritative-v1"));
      const result = collectLiveScenarioEvidence({
        scenarioId: prompt.scenarioId,
        variant: scenario.variant,
        triggerMessageId,
        preflightMode: scenario.preflightMode,
        records: latestRecords.length >= records.length ? latestRecords : records,
        preflightDecisions: await preflight.rawDecisions(200),
        allowIncompleteJev: Boolean(scenario.study),
      });
      triggerResults.push(result);
      stage = "classifier";
      if (!scenario.study && scenario.classifierEnabled && result.classifier.outcome !== "completed")
        throw new Error("Jev completion proof is missing.");
      if (
        scenario.study &&
        scenario.classifierEnabled &&
        result.classifier.resolvedModelId !== null &&
        !matchesPinnedJevResolution(options.jevModel ?? "", result.classifier.resolvedModelId)
      )
        throw new Error("Jev provider-resolved model differs from the pinned study model.");
      if (result.attemptedTurns > options.maxGenerations || result.generationStarts > options.maxGenerations)
        throw new Error("Observed turn cap exceeded.");
      stage = "delivery";
      if (options.requireVisible && (result.confirmedDeliveredBursts < 1 || result.firstVisibleMs === null))
        throw new Error("Visible delivery proof is missing.");
      const snapshot = await requestJson(base, "/api/state", cookie);
      const messages = snapshot.json.messages;
      if (snapshot.status !== 200 || !Array.isArray(messages)) throw new Error("Isolated room delivery check failed.");
      const visibleCount = messages.filter((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const message = entry as { speaker?: unknown; kind?: unknown };
        return message.kind === "chat" && roster.some(({ agentId }) => agentId === message.speaker);
      }).length;
      if (result.confirmedDeliveredBursts > visibleCount)
        throw new Error("Delivery evidence disagrees with the room snapshot.");
      if (privateDirectory || options.judgeModel) {
        stage = "judge";
        const privateCase = await writePrivateReview(
          privateDirectory ?? root,
          scenario,
          result,
          prompt.text,
          prompt.expected,
          messages,
          prompt.followup,
          options.judgeRubric === "v2",
        );
        if (options.judgeModel) {
          const judgeOptions = {
            model: options.judgeModel.slice("openrouter/".length),
            actorModel: options.model,
            apiKey: credential,
            signal: abort,
            timeoutMs: 30_000,
          };
          if (options.judgeRubric === "v2") {
            if (!result.runId) throw new Error("Quality judge requires a correlated run ID.");
            qualityJudgments.push({
              scenarioId: result.scenarioId,
              runId: result.runId,
              outcomes: await judgeConversationQualityAxes(privateCase, judgeOptions),
            });
          } else {
            judgments.push(await judgeConversationCase(parsePrivateJudgeCase(privateCase), judgeOptions));
          }
        }
      }
    }
    stage = "cleanup";
    await stopProcessGroup(child);
    child = undefined;
    const unchanged = await execute("git", ["-C", project, "status", "--porcelain", "--untracked-files=all"], {
      timeout: 10_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    if (unchanged.stdout.trim()) throw new Error("Disposable fixture project changed.");
    if (!availabilityCheck) throw new Error("Isolated room availability proof is missing.");
    return {
      schemaVersion: 1,
      scenarioId: scenario.scenarioId,
      variant: scenario.variant,
      agentCount: scenario.agentCount,
      energy: scenario.energy,
      preflightMode: scenario.preflightMode,
      triggers: triggerResults,
      judge: judgments,
      ...(options.judgeRubric === "v2" ? { qualityJudge: qualityJudgments } : {}),
      privateReviewRetained: Boolean(privateDirectory),
      availabilityCheck: projectAvailabilityCheck(availabilityCheck),
      ...(scenario.study ? { study: scenario.study } : {}),
    };
  } catch (error) {
    throw error instanceof CaseFailure
      ? error
      : new CaseFailure(
          stage,
          failureCategory(error),
          triggerResults,
          error instanceof JudgeFailure ? error.category : null,
          availabilityCheck,
        );
  } finally {
    await stopProcessGroup(child);
    await rm(root, { recursive: true, force: true });
  }
}

async function loadStudyPlan(argv: readonly string[]): Promise<StudyPlanV1 | undefined> {
  const positions = argv.flatMap((arg, index) => (arg === "--study-plan" ? [index] : []));
  if (!positions.length) return undefined;
  if (positions.length !== 1 || !argv[positions[0]! + 1] || !path.isAbsolute(argv[positions[0]! + 1]!))
    throw new Error("Study plan path must be a single absolute path.");
  const file = argv[positions[0]! + 1]!;
  const info = await stat(file);
  if (!info.isFile() || info.size > 65_536) throw new Error("Study plan exceeds its bounded input size.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("Study plan is not valid JSON.");
  }
  return parseStudyPlan(parsed);
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseLiveCanaryOptions(argv, process.env, await loadStudyPlan(argv));
  const sourceSha256 = await sourceDigest();
  const sourceCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, timeout: 10_000 })
  ).stdout.trim();
  const sourceDirty = Boolean(
    (
      await execute("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repositoryRoot,
        timeout: 10_000,
      })
    ).stdout.trim(),
  );
  if (options.dryRun) {
    const plan = options.studyPlan!;
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        kind: "conversation-routing-study-dry-run",
        planId: plan.planId,
        planSha256: studyPlanDigest(plan),
        orderSeed: plan.orderSeed,
        ...(options.studyBatch ? { studyBatch: options.studyBatch } : {}),
        sourceCommit,
        sourceDirty,
        sourceSha256,
        actorModel: options.model,
        jevModel: options.jevModel,
        maxCases: options.maxCases,
        maxGenerationsPerCase: options.maxGenerations,
        scenarioTimeoutMs: options.timeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        maximumScheduledJudgeCalls: options.maxJudgeCalls,
        judgeRubric: options.judgeRubric,
        planningAllowanceMs: options.planningAllowanceMs,
        watchdogCoversPlanningAllowance: options.totalTimeoutMs >= options.planningAllowanceMs,
        cases: options.cases.map((scenario) => ({
          scenarioId: scenario.scenarioId,
          variant: scenario.variant,
          triggerCount: 1 + (scenario.scriptedFollowups?.length ?? 0),
          study: scenario.study,
        })),
      }),
    );
    return;
  }
  if (options.studyPlan && sourceDirty) throw new Error("Live study requires a clean source tree.");
  if (process.env.AMFAA_CANARY_ALLOW_REAL_PROVIDER !== "true")
    throw new Error("Explicit paid-provider opt-in is required.");
  const credential = process.env.OPENROUTER_API_KEY;
  if (!credential || !KEY.test(credential)) throw new Error("A valid launch-time OpenRouter credential is required.");
  const command = await realpath(options.command);
  options.command = command;
  options.secretLauncher = await realpath(options.secretLauncher);
  const cliVersion = (
    await execute(command, ["--version"], { timeout: 10_000, env: { PATH: process.env.PATH, HOME: os.tmpdir() } })
  ).stdout.trim();
  if (!/^(?:1\.18\.25|1\.18\.25-amfaa\.2)$/.test(cliVersion))
    throw new Error("OpenCode binary is outside the audited versions.");
  const privateDirectory = options.privateReviewDirectory;
  if (privateDirectory) {
    const absolute = path.resolve(privateDirectory);
    const parent = await realpath(path.dirname(absolute));
    if (parent === repositoryRoot || parent.startsWith(`${repositoryRoot}${path.sep}`))
      throw new Error("Private review files must stay outside the repository.");
    // Never chmod or place private output in a pre-existing directory, including /tmp or a symlink.
    await mkdir(absolute, { mode: 0o700 });
    const canonical = await realpath(absolute);
    if (canonical === repositoryRoot || canonical.startsWith(`${repositoryRoot}${path.sep}`))
      throw new Error("Private review files must stay outside the repository.");
    await chmod(canonical, 0o700);
  }
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const totalTimer = setTimeout(() => abort.abort(), options.totalTimeoutMs);
  const results: CaseResult[] = [];
  try {
    for (const scenario of options.cases) {
      abort.signal.throwIfAborted();
      try {
        results.push(await runCase(scenario, options, credential, abort.signal, privateDirectory));
      } catch (error) {
        const failure = error instanceof CaseFailure ? error : new CaseFailure("cleanup", "internal");
        console.log(
          JSON.stringify(
            projectCaseFailedEvent({
              scenarioId: scenario.scenarioId,
              variant: scenario.variant,
              stage: failure.stage,
              category: failure.category,
              completedCases: results.length,
              triggers: failure.triggers,
              judgeCategory: failure.judgeCategory,
              ...(failure.availabilityCheck ? { availabilityCheck: failure.availabilityCheck } : {}),
              ...(scenario.study ? { study: scenario.study } : {}),
            }),
          ),
        );
        throw new Error("Isolated live case did not complete.");
      }
      if (options.studyBatch) {
        const progress = projectPairCompleteProgress(results);
        if (progress) console.log(JSON.stringify(progress));
      } else {
        console.log(JSON.stringify({ event: "case-complete", case: results.at(-1), completedCases: results.length }));
      }
    }
    if ((await sourceDigest()) !== sourceSha256) throw new Error("Canary source changed during the live run.");
    if (
      options.studyPlan &&
      (await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, timeout: 10_000 })).stdout.trim() !==
        sourceCommit
    )
      throw new Error("Canary source commit changed during the live study.");
    if (
      options.studyPlan &&
      (
        await execute("git", ["status", "--porcelain", "--untracked-files=all"], {
          cwd: repositoryRoot,
          timeout: 10_000,
        })
      ).stdout.trim()
    )
      throw new Error("Canary source tree changed during the live study.");
    const manifest = {
      schemaVersion: 1,
      kind: "conversation-routing-live-canary",
      sourceCommit,
      sourceDirty,
      sourceSha256,
      scenarioCatalogSha256: createHash("sha256")
        .update(
          JSON.stringify(
            options.cases.map(
              ({
                scenarioId,
                variant,
                text,
                expectedDirectAgents,
                followup,
                scriptedFollowups,
                rosterOrder,
                study,
              }) => ({
                scenarioId,
                variant,
                text,
                expectedDirectAgents,
                followup,
                scriptedFollowups,
                rosterOrder,
                study,
              }),
            ),
          ),
        )
        .digest("hex"),
      ...(options.studyPlan
        ? {
            studyPlan: {
              schemaVersion: 1,
              planId: options.studyPlan.planId,
              planSha256: studyPlanDigest(options.studyPlan),
              orderSeed: options.studyPlan.orderSeed,
              jevModel: options.jevModel,
            },
          }
        : {}),
      ...(options.studyBatch ? { studyBatch: options.studyBatch } : {}),
      openCodeVersion: cliVersion,
      actorModel: options.model,
      judgeModel: options.judgeModel ?? null,
      concurrency: 1,
      maxCases: options.maxCases,
      maxGenerationsPerCase: options.maxGenerations,
      scenarioTimeoutMs: options.timeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      maximumScheduledJudgeCalls: options.maxJudgeCalls,
      judgeRubric: options.judgeRubric,
      planningAllowanceMs: options.planningAllowanceMs,
      cases: results,
    };
    console.log(JSON.stringify(manifest));
  } finally {
    clearTimeout(totalTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never echo an exception that might contain a private provider response or a credential.
    console.error("Live routing canary failed; private diagnostics were discarded.");
    process.exitCode = 1;
  });
}
