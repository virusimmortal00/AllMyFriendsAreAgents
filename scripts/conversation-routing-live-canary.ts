import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PreflightStore } from "../server/preflight-store.js";
import { RoomStore } from "../server/room-store.js";
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
  buildLiveScenario,
  FIXTURE_AGENTS,
  type LiveScenario,
  pilotScenarios,
  ROUTING_DYNAMICS,
  ROUTING_ENERGIES,
  ROUTING_MODES,
  type RoutingDynamic,
} from "./conversation-routing-live-scenarios.js";
import { createLiveOpenCodeWrapper } from "./conversation-routing-live-wrapper.js";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = /^[A-Za-z0-9._-]{10,300}$/;
const MODEL = /^openrouter\/[a-z0-9][a-z0-9._/-]{1,150}$/i;
const MAX_PILOT_CASES = 12;
const MAX_WIDE_CASES = 36;
const SOURCE_FILES = [
  "scripts/conversation-routing-live-canary.ts",
  "scripts/conversation-routing-live-evidence.ts",
  "scripts/conversation-routing-live-scenarios.ts",
  "scripts/conversation-routing-live-wrapper.ts",
  "scripts/conversation-routing-live-judge.ts",
  "scripts/conversation-routing-live-annotations.ts",
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
}

function positiveInteger(raw: string | undefined, label: string, maximum: number, fallback: number) {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} is out of range.`);
  return parsed;
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
export function parseLiveCanaryOptions(argv: readonly string[], env: NodeJS.ProcessEnv): CanaryOptions {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const valueless = new Set(["--pilot", "--allow-wide-matrix", "--require-visible"]);
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
  if (flags.has("--pilot") === values.has("--case"))
    throw new Error("Choose either --pilot or one or more --case values.");
  const allowWideMatrix = flags.has("--allow-wide-matrix");
  const cases = flags.has("--pilot") ? pilotScenarios() : (values.get("--case") ?? []).map(customScenario);
  if (!allowWideMatrix && cases.some(({ agentCount }) => agentCount > 3))
    throw new Error("Four-agent cases require --allow-wide-matrix.");
  const upperLimit = allowWideMatrix ? MAX_WIDE_CASES : MAX_PILOT_CASES;
  const maxCases = positiveInteger(values.get("--max-cases")?.[0], "Maximum cases", upperLimit, MAX_PILOT_CASES);
  if (cases.length > maxCases) throw new Error("Selected cases exceed the case limit.");
  if (new Set(cases.map(({ scenarioId, variant }) => `${scenarioId}:${variant}`)).size !== cases.length)
    throw new Error("Duplicate scenario variants are not allowed.");
  const model = values.get("--model")?.[0] ?? env.AMFAA_ROUTING_ROOM_MODEL ?? "";
  const command = values.get("--opencode")?.[0] ?? env.ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND ?? "";
  const secretLauncher = values.get("--secret-launcher")?.[0] ?? env.AMFAA_ROUTING_SECRET_LAUNCHER ?? "";
  if (!MODEL.test(model) || model.endsWith("/auto") || !path.isAbsolute(command))
    throw new Error("A concrete OpenRouter model and absolute audited OpenCode command are required.");
  if (!path.isAbsolute(secretLauncher)) throw new Error("An absolute secret launcher is required.");
  const judgeModel = values.get("--judge-model")?.[0];
  if (judgeModel && (!MODEL.test(judgeModel) || judgeModel.endsWith("/auto") || judgeModel === model))
    throw new Error("Judge model must be a different pinned OpenRouter model.");
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
    maxGenerations: positiveInteger(values.get("--max-generations")?.[0], "Maximum generations", 12, 8),
    timeoutMs: positiveInteger(values.get("--timeout-ms")?.[0], "Scenario timeout", 180_000, 120_000),
    totalTimeoutMs: positiveInteger(values.get("--total-timeout-ms")?.[0], "Total timeout", 3_600_000, 2_400_000),
    allowWideMatrix,
    requireVisible: flags.has("--require-visible"),
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
): Promise<{ status: number; json: Record<string, unknown>; cookie?: string }> {
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    json,
    ...(response.headers.get("set-cookie") ? { cookie: response.headers.get("set-cookie")!.split(";")[0] } : {}),
  };
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
  privateReviewRetained: boolean;
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
type FailureCategory = "timeout" | "unavailable" | "limit" | "missing-proof" | "fixture-changed" | "internal";
class CaseFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly category: FailureCategory,
    readonly triggers: readonly LiveScenarioResult[] = [],
    readonly judgeCategory: JudgeFailureCategory | null = null,
  ) {
    super("Isolated live case failed.");
  }
}

/** Preserve only the collector's closed scalar fields when a case stops after routing. */
export function projectFailedCaseEvidence(result: LiveScenarioResult): LiveScenarioResult {
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
  return "internal";
}

function privateKind(dynamic: LiveScenario["dynamic"], followup: boolean) {
  if (followup) return "resolved" as const;
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
) {
  const payload = parsePrivateJudgeCase({
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
  const file = path.join(
    directory,
    `${scenario.scenarioId}-${scenario.variant}-${followup ? "resolution" : "opening"}-${result.runId}.json`,
  );
  await writeFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
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
      },
      "fixture-owner",
    );
    const roster = FIXTURE_AGENTS.slice(0, scenario.agentCount).map(({ agentId, name }) => ({
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
    const rosterResponse = await requestJson(base, "/api/roster", cookie);
    if (rosterResponse.status !== 200) throw new Error("Isolated room roster check failed.");
    const availability = rosterResponse.json.participantAvailability as
      | Record<string, { available?: boolean }>
      | undefined;
    if (roster.some(({ agentId }) => availability?.[agentId]?.available !== true))
      throw new Error("Selected OpenCode participant is unavailable.");
    const judgments: JudgeScalarResult[] = [];
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
      });
      stage = "classifier";
      if (scenario.classifierEnabled && result.classifier.outcome !== "completed")
        throw new Error("Jev completion proof is missing.");
      if (result.attemptedTurns > options.maxGenerations || result.generationStarts > options.maxGenerations)
        throw new Error("Observed turn cap exceeded.");
      stage = "delivery";
      triggerResults.push(result);
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
        );
        if (options.judgeModel) {
          judgments.push(
            await judgeConversationCase(privateCase, {
              model: options.judgeModel.slice("openrouter/".length),
              actorModel: options.model,
              apiKey: credential,
              signal: abort,
              timeoutMs: 30_000,
            }),
          );
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
    return {
      schemaVersion: 1,
      scenarioId: scenario.scenarioId,
      variant: scenario.variant,
      agentCount: scenario.agentCount,
      energy: scenario.energy,
      preflightMode: scenario.preflightMode,
      triggers: triggerResults,
      judge: judgments,
      privateReviewRetained: Boolean(privateDirectory),
    };
  } catch (error) {
    throw error instanceof CaseFailure
      ? error
      : new CaseFailure(
          stage,
          failureCategory(error),
          triggerResults,
          error instanceof JudgeFailure ? error.category : null,
        );
  } finally {
    await stopProcessGroup(child);
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseLiveCanaryOptions(process.argv.slice(2), process.env);
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
  const sourceSha256 = await sourceDigest();
  const sourceCommit = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, timeout: 10_000 })
  ).stdout.trim();
  const sourceDirty = Boolean(
    (
      await execute("git", ["status", "--porcelain", "--untracked-files=all", "--", ...SOURCE_FILES], {
        cwd: repositoryRoot,
        timeout: 10_000,
      })
    ).stdout.trim(),
  );
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
            }),
          ),
        );
        throw new Error("Isolated live case did not complete.");
      }
      console.log(JSON.stringify({ event: "case-complete", case: results.at(-1), completedCases: results.length }));
    }
    if ((await sourceDigest()) !== sourceSha256) throw new Error("Canary source changed during the live run.");
    const manifest = {
      schemaVersion: 1,
      kind: "conversation-routing-live-canary",
      sourceCommit,
      sourceDirty,
      sourceSha256,
      scenarioCatalogSha256: createHash("sha256")
        .update(
          JSON.stringify(
            options.cases.map(({ scenarioId, variant, text, followup }) => ({ scenarioId, variant, text, followup })),
          ),
        )
        .digest("hex"),
      openCodeVersion: cliVersion,
      actorModel: options.model,
      judgeModel: options.judgeModel ?? null,
      concurrency: 1,
      maxCases: options.maxCases,
      maxGenerationsPerCase: options.maxGenerations,
      scenarioTimeoutMs: options.timeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
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
