import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONVERSATION_EVENT_MAX_BYTES } from "../shared/conversation-observability.js";
import { AGENT_IDS } from "../shared/participants.js";
import { AuthoritativeLogging, type AuthoritativeStream } from "./authoritative-logging.js";
import { observeConversationRun } from "./conversation-run-observer.js";
import { withConversationRun, withConversationTurn } from "./conversation-context.js";
import { parseAgentTurn, runAgentConversation, runEnergyConversation } from "./conversation.js";
import { GenerationJournal } from "./generation-journal.js";
import { withGenerationDelivery } from "./generation-delivery.js";
import { currentLogContext, withLogContext } from "./structured-logger.js";
import { LocalFileDiagnosticsQueryService, type DiagnosticCaller, type DiagnosticQuery, type DiagnosticRecord } from "./diagnostics-query.js";

class Sink extends EventEmitter {
  records: Record<string, any>[] = [];
  blocked = false;
  write(line: string) { this.records.push(JSON.parse(line)); return !this.blocked; }
  flush(callback?: () => void) { callback?.(); }
  end() {}
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(files = false, maxBufferedBytes?: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-run-events-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sinks = new Map<AuthoritativeStream, Sink>();
  const logging = await AuthoritativeLogging.open({ dataDirectory: root, projectId: "project-fixture", projectPath: "/projects/fixture", roomId: "room-fixture", maxIdentical: 1, maxBufferedBytes,
    ...(files ? {} : { sinkFactory: async (stream: AuthoritativeStream) => { const sink = new Sink(); sinks.set(stream, sink); return sink; } }),
  });
  cleanup.push(async () => { for (const sink of sinks.values()) { sink.blocked = false; sink.emit("drain"); } await logging.close(); });
  return { root, logging, sinks, records: () => sinks.get("generations")!.records };
}

describe("conversation run event adapter", () => {
  it("exposes transport loss through sequence gaps and the final attempted-event count", async () => {
    const { logging, sinks, records } = await fixture(false, 1_024);
    const sink = sinks.get("generations")!; sink.blocked = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = withConversationRun(() => observeConversationRun(logging, "energy", (observer) => runEnergyConversation(
      [{ agent: AGENT_IDS[0], instruction: "fixture" }], "low", async () => { await gate; return {}; }, () => 0, { observer },
    )));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logging.metrics().generations.dropped).toBeGreaterThan(0);
    sink.blocked = false; sink.emit("drain"); await logging.flush();
    release(); await run; await logging.flush();
    expect(records().at(-1)?.event).toBe("conversation.run.completed");
    expect(records().at(-1)?.attemptedEventCount).toBeGreaterThan(records().length);
    expect(records().map(({ runEventSequence }) => runEventSequence)).not.toEqual(records().map((_record, index) => index + 1));
  });
  it("carries confirmed and uncertain delivery into failed turn and run records", async () => {
    const { logging, records } = await fixture();
    const error = new Error("Fixture ambiguous write");
    await expect(withConversationRun(() => observeConversationRun(logging, "energy", (observer) => runEnergyConversation(
      [{ agent: AGENT_IDS[0], instruction: "fixture" }], "low", async (turn) => {
        turn.evidence!.generationId = "generation-fixture";
        return withGenerationDelivery(3, (delivery) => { turn.evidence!.delivery = delivery; }, async (ledger) => {
          await ledger.write(0, async () => ({ id: "acknowledged" }));
          await ledger.write(1, async () => { throw error; });
          return {};
        });
      }, () => 0, { observer },
    )))).rejects.toBe(error);
    await logging.flush();
    expect(records().find(({ event }) => event === "conversation.turn.finished")).toMatchObject({ severity: "error", outcome: "failed", generationId: "generation-fixture",
      delivery: { confirmedDeliveredBurstCount: 1, confirmedUndeliveredBurstCount: 1, unconfirmedBurstCount: 1 } });
    expect(records().at(-1)).toMatchObject({ severity: "error", outcome: "failed", summary: { counts: { confirmedDeliveredBursts: 1, unconfirmedBursts: 1 } } });
  });

  it.each([
    ["malformed", "warn"], ["cancelled", "info"], ["gate", "info"], ["provider", "error"],
  ] as const)("classifies %s turn evidence without changing the engine result", async (mode, severity) => {
    const { logging, records } = await fixture();
    await withConversationRun(() => observeConversationRun(logging, "energy", (observer) => runEnergyConversation(
      [{ agent: AGENT_IDS[0], instruction: "fixture" }], "low", async () => {
        if (mode === "gate") return { failed: true, outcomeReason: "agent-health-unavailable" as const };
        if (mode === "provider") return { failed: true, outcomeReason: "provider-failed" as const };
        if (mode === "cancelled") return { cancelled: true };
        const parsed = parseAgentTurn(AGENT_IDS[0], "TURN_DISPOSITION: {malformed}");
        return { ...parsed, interpretation: parsed.diagnostics };
      }, () => 0, { observer },
    )));
    await logging.flush();
    expect(records().find(({ event }) => event === "conversation.turn.finished")?.severity).toBe(severity);
  });
  it.each(["energy", "legacy"] as const)("emits one %s empty-run start and completion with contiguous sequence numbers", async (engine) => {
    const { logging, records } = await fixture();
    await withConversationRun(() => observeConversationRun(logging, engine, (observer) => engine === "energy"
      ? runEnergyConversation([], "low", async () => ({}), () => 0, { observer })
      : runAgentConversation([], 0, async () => ({}), 1, undefined, observer)));
    await logging.flush();
    expect(records().map(({ event }) => event)).toEqual(["conversation.run.started", "conversation.run.completed"]);
    expect(records().map(({ runEventSequence }) => runEventSequence)).toEqual([1, 2]);
    expect(records()[1]).toMatchObject({ attemptedEventCount: 2, summary: { engine, engineSettled: engine === "energy" ? true : null } });
    expect(records().every(({ visibility, correlationId, runId }) => visibility === "operator" && correlationId === runId)).toBe(true);
  });

  it("records preparation failure without inventing engine policy or turn evidence", async () => {
    const { logging, records } = await fixture();
    const error = new Error("Private preparation error sentinel");
    await expect(withConversationRun(() => observeConversationRun(logging, "energy", async () => { throw error; }))).rejects.toBe(error);
    await logging.flush();
    expect(records()).toHaveLength(2);
    expect(records()[0]).toMatchObject({ configuration: null });
    expect(records()[1]).toMatchObject({ severity: "error", outcome: "failed", summary: null, errorCategory: "preparation-error", attemptedEventCount: 2 });
    expect(JSON.stringify(records())).not.toContain(error.message);
  });

  it("does not await a persistently backpressured destination", async () => {
    const { logging, sinks, records } = await fixture();
    sinks.get("generations")!.blocked = true;
    const result = await withConversationRun(() => observeConversationRun(logging, "energy", (observer) => runEnergyConversation(
      AGENT_IDS.map((agent) => ({ agent, instruction: "fixture" })), "party", async () => ({ visibleMessageCount: 1 }), () => 0, { observer, concurrencyLimit: 2 },
    )));
    expect(result.summary.counts.attemptedTurns).toBe(AGENT_IDS.length);
    expect(records()).toHaveLength(1);
    sinks.get("generations")!.blocked = false; sinks.get("generations")!.emit("drain");
    await logging.flush();
    expect(records().at(-1)?.event).toBe("conversation.run.completed");
    expect(records().map(({ runEventSequence }) => runEventSequence)).toEqual(records().map((_entry, index) => index + 1));
  });

  it.each(["throw", "reject", "stall"])("preserves the original orchestration failure when enqueueing logs can %s", async (mode) => {
    const error = new Error("Original failure");
    const logger = { log: () => {
      if (mode === "throw") throw new Error("sink");
      if (mode === "reject") return Promise.reject(new Error("sink"));
      return new Promise<void>(() => {});
    } };
    await expect(withConversationRun(() => observeConversationRun(logger, "energy", (observer) => runEnergyConversation(
      [{ agent: AGENT_IDS[0], instruction: "fixture" }], "low", async () => { throw error; }, () => 0, { observer },
    )))).rejects.toBe(error);
  });

  it("keeps maximum-roster structured records within the serialized budget, including escaped IDs", async () => {
    const { logging, records } = await fixture();
    const turns = Array.from({ length: 32 }, (_, index) => ({ agent: `${index}-${"\u0001".repeat(38)}` as typeof AGENT_IDS[number], instruction: "never retained" }));
    await withConversationRun(() => observeConversationRun(logging, "energy", (observer) => runEnergyConversation(turns, "party", async () => ({}), () => 0, { observer, inviteAll: true, concurrencyLimit: 2 })));
    await logging.flush();
    expect(records().every((record) => Buffer.byteLength(JSON.stringify(record)) <= CONVERSATION_EVENT_MAX_BYTES)).toBe(true);
    expect(records()[0].omittedDetailCount).toBeGreaterThan(0);
    expect(records()[0].configuration.candidateCount).toBe(32);
    expect(records().at(-1)?.summary.counts.attemptedTurns).toBe(32);
    expect(JSON.stringify(records())).not.toContain("never retained");
  });

  it("reconstructs yield, truncation, a pair-cap drop, and completion through the real OWNER query after reopening files", async () => {
    const { root, logging } = await fixture(true);
    const journal = await GenerationJournal.open("/projects/fixture", root, undefined, logging);
    const texts = [
      'TURN_DISPOSITION: {"action":"yield","reason":"already_covered"}',
      "Sol, what do you think?\n<<<NEXT>>>\nSecond unit\n<<<NEXT>>>\nThird unit\n<<<NEXT>>>\nTruncated unit",
      "Claude, a concise answer.", "Sol, noted.",
    ];
    let generation = 0;
    const traceId = "a".repeat(32);
    const transcript: string[] = [];
    await withLogContext({ traceId, requestId: "fixture-request", jobId: "fixture-job" }, () => withConversationRun(() => observeConversationRun(logging, "energy", (observer) =>
      runEnergyConversation(AGENT_IDS.slice(0, 2).map((agent) => ({ agent, instruction: "Do not copy this instruction into decision events" })), "balanced", (turn) => withConversationTurn(turn.agent, async () => {
        const generationId = `fixture-generation-${++generation}`;
        turn.evidence!.generationId = generationId; turn.evidence!.attemptOrdinal = 1;
        return withLogContext({ generationId, attemptOrdinal: 1 }, async () => {
          const text = texts[generation - 1] || "No follow-up.";
          await journal.append({ type: "generation.started", generationId, agent: turn.agent, prompt: "Useful assembled prompt sentinel", authorization: "Bearer fixture-secret" });
          await journal.append({ type: "generation.completed", generationId, agent: turn.agent, rawResponse: text, cliStdout: text, cliStderr: "", providerUsage: { totalTokens: 12 } });
          const parsed = parseAgentTurn(turn.agent, text, undefined, turn.visibleMessageLimit);
          turn.evidence!.interpretation = parsed.diagnostics;
          await journal.append({ type: "generation.interpreted", generationId, agent: turn.agent, interpretation: parsed.diagnostics, visibleMessages: parsed.visibleMessages });
          return withGenerationDelivery(parsed.visibleMessages.length, (delivery) => {
            turn.evidence!.delivery = delivery;
            return journal.append({ type: "generation.delivery", generationId, agent: turn.agent, ...delivery });
          }, async (ledger) => {
            for (const [sequence, text] of parsed.visibleMessages.entries()) await ledger.write(sequence, async () => { transcript.push(text); return { id: `message-${transcript.length}` }; });
            ledger.finish(parsed.visibleMessages.length ? "delivered" : "no_response", parsed.visibleMessages.length ? "burst-delivered" : "no-visible-output");
            return { ...parsed, interpretation: parsed.diagnostics };
          });
        });
      }, turn.observation?.turnId), () => 1, { observer }),
    )));
    await logging.flush();
    const service = new LocalFileDiagnosticsQueryService(root, "project-fixture");
    const owner: DiagnosticCaller = { principalId: "owner", roomIds: [], projectIds: [], operator: true };
    const query: DiagnosticQuery = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 1_000).toISOString(), scope: "operator", correlation: { traceId }, limit: 7 };
    const found: DiagnosticRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.query(owner, { ...query, cursor }); found.push(...page.records); cursor = page.nextCursor || undefined;
      expect(page.chunks).toHaveLength(0);
    } while (cursor);
    const structured = found.filter(({ event }) => event.startsWith("conversation.")).sort((a, b) => Number(a.content.runEventSequence) - Number(b.content.runEventSequence));
    const turnFinished = structured.filter(({ event }) => event === "conversation.turn.finished");
    expect(turnFinished).toHaveLength(4);
    expect(turnFinished[0].content).toMatchObject({ outcome: "yielded", interpretation: { dispositionAction: "yield", yieldReason: "already_covered" } });
    expect(turnFinished[1].content).toMatchObject({ interpretation: { parsedBurstCount: 4, retainedBurstCount: 3, truncatedBurstCount: 1 }, delivery: { confirmedDeliveredBurstCount: 3 } });
    expect(structured.find(({ content }) => content.reason === "pair-cap-reached")?.content).toMatchObject({ action: "dropped", selectionFamily: "legacy-name-match", sourceGenerationId: "fixture-generation-4" });
    expect(structured.at(-1)?.content).toMatchObject({ reason: "no-explicit-unresolved-state", summary: { counts: { yieldedTurns: 1, confirmedDeliveredBursts: 5 } }, attemptedEventCount: structured.length });
    expect(structured.map(({ content }) => content.runEventSequence)).toEqual(structured.map((_record, index) => index + 1));
    expect(JSON.stringify(structured)).not.toMatch(/Useful assembled prompt sentinel|Second unit|Do not copy/);
    expect(JSON.stringify(found)).toContain("Useful assembled prompt sentinel");
    expect(JSON.stringify(found)).not.toContain("fixture-secret");
    for (const record of turnFinished) {
      const evidence = found.filter(({ generationId }) => generationId === record.generationId);
      expect(evidence.some(({ stream }) => stream === "openrouter-provider")).toBe(true);
      expect(evidence.some(({ stream }) => stream === "opencode-harness")).toBe(true);
      expect(evidence.every(({ content }) => content.turnId === record.content.turnId)).toBe(true);
    }
    const project = { ...owner, operator: false, projectIds: ["project-fixture"] };
    await expect(service.query(project, query)).rejects.toMatchObject({ code: "forbidden" });
    const restricted = await service.query(project, { ...query, scope: "project", limit: 200 });
    expect(restricted.records.every(({ event }) => !event.startsWith("conversation."))).toBe(true);
    expect(currentLogContext()).toBeUndefined();
  });
});
