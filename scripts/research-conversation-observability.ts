/**
 * Provider-free research probes for issue #150. Reports current behavior rather
 * than requiring known defects to remain present. No live server or credentials.
 * Run: pnpm exec tsx scripts/research-conversation-observability.ts
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoalescingJobQueue } from "../server/job-queue.js";
import { currentLogContext, withLogContext } from "../server/structured-logger.js";
import { parseAgentTurn, runAgentConversation, runEnergyConversation, type ConversationTurn } from "../server/conversation.js";
import { RoomActivity } from "../server/room-activity.js";
import { deliverBurst } from "../server/burst-delivery.js";
import { AuthoritativeLogging, type AuthoritativeStream } from "../server/authoritative-logging.js";
import { GenerationJournal } from "../server/generation-journal.js";
import { LocalFileDiagnosticsQueryService, type DiagnosticQuery } from "../server/diagnostics-query.js";
import { AGENT_IDS } from "../shared/participants.js";
import { CONVERSATION_ENERGY_LEVELS, CONVERSATION_ENERGY_POLICIES } from "../shared/conversation-energy.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function deadline<T>(operation: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Research fixture exceeded its deadline")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

function candidates(count: number): ConversationTurn[] {
  return AGENT_IDS.slice(0, count).map((agent) => ({ agent, instruction: "Fixture only." }));
}

async function queueProbe(bind: boolean) {
  const queue = new CoalescingJobQueue();
  const activity = new RoomActivity();
  const gate = deferred();
  const done = deferred();
  const observed: unknown[] = [];
  const admission: unknown[] = [];
  let duplicateExecuted = false;
  function enqueue(key: string, run: () => Promise<void>) {
    const context = currentLogContext();
    const queuedRevision = activity.current();
    const accepted = queue.enqueue(key, bind ? AsyncLocalStorage.bind(run) : run);
    admission.push({ key, requestId: context?.requestId ?? null, queuedRevision, accepted });
  }
  function observe(job: string) {
    const context = currentLogContext();
    observed.push({ job, requestId: context?.requestId ?? null, traceId: context?.traceId ?? null, consumedRevision: activity.current() });
  }
  withLogContext({ requestId: "fixture-a", traceId: "a".repeat(32) }, () => enqueue("active", async () => { await gate.promise; observe("a"); }));
  withLogContext({ requestId: "fixture-b", traceId: "b".repeat(32) }, () => enqueue("pending", async () => { observe("b"); }));
  withLogContext({ requestId: "fixture-c", traceId: "c".repeat(32) }, () => enqueue("pending", async () => { duplicateExecuted = true; }));
  enqueue("background", async () => { observe("background"); done.resolve(); });
  activity.interrupt();
  gate.resolve();
  await deadline(done.promise);
  assert.equal(duplicateExecuted, false);
  return { admission, observed, duplicateExecuted };
}

async function ceilingProbe() {
  let scenarios = 0;
  let overlappingTurns = 0;
  const violations: unknown[] = [];
  for (const energy of CONVERSATION_ENERGY_LEVELS) {
    for (const count of [1, 2, 3, 5]) for (const concurrencyLimit of [1, 2, 3, 5]) {
      for (const inviteAll of [false, true]) for (const draw of [0, 0.99]) {
        for (const behavior of ["plain", "open-mentions", "yield"] as const) for (const reverse of [false, true]) {
          scenarios++;
          let active = 0;
          let delivered = 0;
          const limits: number[] = [];
          const turns = candidates(count);
          const policy = CONVERSATION_ENERGY_POLICIES[energy];
          const participants = policy.participantLimit === "all" ? turns.length : policy.participantLimit;
          const ceiling = inviteAll || policy.participantLimit === "all"
            ? Math.max(policy.hardMessageCeiling, turns.length + 2 + Math.min(4, Math.max(0, participants - 1)))
            : policy.hardMessageCeiling;
          await runEnergyConversation(turns, energy, async (turn) => {
            active++;
            if (active > 1) overlappingTurns++;
            limits.push(turn.visibleMessageLimit!);
            const index = turns.findIndex(({ agent }) => agent === turn.agent);
            for (let step = 0; step < (reverse ? turns.length - index : index + 1); step++) await Promise.resolve();
            const parsed = parseAgentTurn(turn.agent,
              behavior === "yield" ? 'TURN_DISPOSITION: {"action":"yield","reason":"already_covered"}' : "First.\n<<<NEXT>>>\nSecond.\n<<<NEXT>>>\nThird.\n<<<NEXT>>>\nFourth.",
              undefined, turn.visibleMessageLimit, turns.map(({ agent }) => agent));
            delivered += parsed.visibleMessageCount;
            active--;
            const target = turns[(index + 1) % turns.length].agent;
            return { ...parsed, ...(behavior === "open-mentions" ? { conversationState: "open" as const, mentionedAgents: target !== turn.agent ? [target] : [] } : {}) };
          }, () => draw, { inviteAll, concurrencyLimit });
          if (delivered > ceiling) violations.push({ energy, count, concurrencyLimit, inviteAll, draw, behavior, reverse, delivered, ceiling, limits });
        }
      }
    }
  }
  return { scenarios, overlappingTurns, violationCount: violations.length, examples: violations.slice(0, 3) };
}

async function terminalProbe() {
  const turns = candidates(2);
  const allYielded = await runEnergyConversation(turns, "balanced", async (turn) =>
    parseAgentTurn(turn.agent, 'TURN_DISPOSITION: {"action":"yield","reason":"already_covered"}'), () => 0);
  const allFailed = await runEnergyConversation(turns, "balanced", async () => ({ failed: true }), () => 0);
  const cancelled = await runEnergyConversation(turns, "balanced", async () => ({ cancelled: true }), () => 0);
  const open = await runEnergyConversation(turns.slice(0, 1), "low", async () => ({ visibleMessageCount: 1, conversationState: "open" }), () => 0);
  const legacy = await runAgentConversation(turns, 0, async () => ({ visibleMessageCount: 1 }));
  return { allYielded, allFailed, cancelled, open, legacy: legacy ?? null };
}

async function deliveryProbe() {
  const outcomes: unknown[] = [];
  for (const mode of ["cancel-after-first", "throw-before-second", "throw-after-second-commit"] as const) {
    const activity = new RoomActivity();
    // No pacing delay in this controlled fixture; revision checks remain real.
    activity.wait = async (_delay, revision) => activity.isCurrent(revision);
    const persisted: string[] = [];
    let acknowledged = 0;
    let cancelCalls = 0;
    let returned: boolean | null = null;
    let threw = false;
    try {
      returned = await deliverBurst({ messages: ["first", "second", "third"], activity, revision: activity.current(), firstDelayMs: 0,
        deliver: async (message, sequence) => {
          if (sequence === 1 && mode === "throw-before-second") throw new Error("Fixture before commit");
          persisted.push(message);
          if (sequence === 1 && mode === "throw-after-second-commit") throw new Error("Fixture acknowledgement failure");
          acknowledged++;
          if (mode === "cancel-after-first") activity.interrupt();
        }, cancel: async () => { cancelCalls++; },
      });
    } catch { threw = true; }
    outcomes.push({ mode, retained: 3, persisted: persisted.length, acknowledged, returned, threw, cancelCalls });
  }
  return outcomes;
}

class MemorySink extends EventEmitter {
  readonly records: Record<string, unknown>[] = [];
  blocked = false;
  write(line: string) { this.records.push(JSON.parse(line)); return !this.blocked; }
  flush(callback?: () => void) { callback?.(); }
  end() {}
}

async function loggingProbe(root: string) {
  const sinks = new Map<AuthoritativeStream, MemorySink>();
  const logging = await AuthoritativeLogging.open({ dataDirectory: path.join(root, "memory"), projectId: "fixture-project", projectPath: root,
    maxBufferedBytes: 64 * 1024, maxIdentical: 1,
    sinkFactory: async (stream) => { const sink = new MemorySink(); sinks.set(stream, sink); return sink; },
  });
  const generations = sinks.get("generations")!;
  try {
    generations.blocked = true;
    logging.log("generations", "info", "fixture.blocked", {});
    await Promise.resolve();
    await deadline(runEnergyConversation(candidates(3), "lively", async () => {
      logging.log("generations", "info", "fixture.turn", { sequence: generations.records.length });
      return { visibleMessageCount: 1 };
    }, () => 0, { concurrencyLimit: 3 }));
    const completedWhileSinkBlocked = generations.listenerCount("drain") > 0;
    await Promise.resolve();
    const transportDrops = logging.metrics().generations.dropped;
    generations.blocked = false; generations.emit("drain"); await logging.flush();

    for (const id of ["a", "b"]) withLogContext({ traceId: id.repeat(32), generationId: id }, () => logging.log("generations", "info", "fixture.identical", { answer: 1 }));
    for (const sequence of [1, 2]) logging.log("generations", "info", "fixture.distinct-decisions", { runId: "fixture-run", sequence });
    await logging.flush();
    const identicalEnvelopeOnlyRecords = generations.records.filter(({ event }) => event === "fixture.identical").length;
    const distinctDecisionRecords = generations.records.filter(({ event }) => event === "fixture.distinct-decisions").length;

    const journal = await GenerationJournal.open(root, path.join(root, "unused"), undefined, logging);
    await withLogContext({ traceId: "e".repeat(32), requestId: "fixture-retry-request" }, async () => {
      await journal.append({ type: "generation.retry", generationId: "fixture-retry-generation", agent: AGENT_IDS[0], cliStdout: "attempt one", cliStderr: "", runId: "fixture-run", turnId: "fixture-turn" });
      await journal.append({ type: "generation.completed", generationId: "fixture-retry-generation", agent: AGENT_IDS[0], cliStdout: "attempt two", cliStderr: " ", providerUsage: { input: 12 }, runId: "fixture-run", turnId: "fixture-turn" });
    });
    await logging.flush();
    const retry = [...sinks.values()].flatMap(({ records }) => records).filter(({ generationId }) => generationId === "fixture-retry-generation");
    return { completedWhileSinkBlocked, transportDrops, identicalEnvelopeOnlyRecords, distinctDecisionRecords,
      retryEvidence: retry.map(({ event, requestId, traceId, correlationId, runId, turnId, severity }) => ({ event, requestId, traceId, correlationId, runId: runId ?? null, turnId: turnId ?? null, severity })),
    };
  } finally { generations.blocked = false; generations.emit("drain"); await logging.close(); }
}

async function visibilityProbe(root: string) {
  const dataDirectory = path.join(root, "query");
  const logging = await AuthoritativeLogging.open({ dataDirectory, projectId: "fixture-project", projectPath: root, now: () => Date.parse("2026-08-31T12:00:00Z") });
  try {
    const context = { traceId: "a".repeat(32), generationId: "fixture-generation", roomId: "fixture-room" };
    logging.log("generations", "info", "fixture.decision", { runId: "fixture-run" }, { ...context, visibility: "operator" });
    logging.log("opencode-harness", "info", "fixture.raw", { output: "preserve diagnostic evidence", authorization: "Bearer fixture-sensitive-value" }, { ...context, visibility: "project" });
    logging.log("opencode-harness", "info", "fixture.orphan", { output: "preserve unpaired evidence" }, { ...context, generationId: "fixture-orphan", visibility: "project" });
    await logging.flush();
    const query: DiagnosticQuery = { from: "2026-08-31T00:00:00Z", to: "2026-09-01T00:00:00Z", scope: "operator", correlation: { traceId: context.traceId } };
    const service = new LocalFileDiagnosticsQueryService(dataDirectory, "fixture-project");
    const caller = { principalId: "fixture-owner", roomIds: [], projectIds: [], operator: true };
    const owner = await service.query(caller, query);
    const member = await service.query({ ...caller, operator: false, projectIds: ["fixture-project"] }, { ...query, scope: "project" });
    assert.equal(owner.records.length, 3);
    assert.equal(member.records.length, 2);
    assert.equal(JSON.stringify(owner).includes("fixture-sensitive-value"), false);
    assert.equal(JSON.stringify(owner).includes("preserve diagnostic evidence"), true);
    return { ownerEvents: owner.records.map(({ event }) => event), projectEvents: member.records.map(({ event }) => event), ownerNeedsMembershipOrBypass: false, orphanPreserved: owner.records.some(({ event }) => event === "fixture.orphan") };
  } finally { await logging.close(); }
}

const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-observability-research-"));
try {
  const baselineQueue = await queueProbe(false);
  const boundQueue = await queueProbe(true);
  assert.deepEqual(boundQueue.observed, [
    { job: "a", requestId: "fixture-a", traceId: "a".repeat(32), consumedRevision: 1 },
    { job: "b", requestId: "fixture-b", traceId: "b".repeat(32), consumedRevision: 1 },
    { job: "background", requestId: null, traceId: null, consumedRevision: 1 },
  ]);
  const results = { baselineQueue, boundQueue, ceilings: await ceilingProbe(), terminals: await terminalProbe(), delivery: await deliveryProbe(), logging: await loggingProbe(root), visibility: await visibilityProbe(root) };
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  // Only the freshly created fixture directory is removed; no live state is read.
  await rm(root, { recursive: true, force: true });
}
