import { describe, expect, it, vi } from "vitest";
import type { ConversationFact, ConversationObserver } from "../shared/conversation-observability.js";
import { AGENT_IDS } from "../shared/participants.js";
import { CONVERSATION_ENERGY_LEVELS } from "../shared/conversation-energy.js";
import { parseAgentTurn, runAgentConversation, runEnergyConversation, type ConversationTurn, type TurnResult } from "./conversation.js";

const candidates = AGENT_IDS.slice(0, 3).map((agent) => ({ agent, instruction: "Instruction preservation sentinel" }));
type Decision = Extract<ConversationFact, { kind: "decision" }>;
const decisions = (facts: ConversationFact[]) => facts.filter((fact): fact is Decision => fact.kind === "decision");
const finished = (facts: ConversationFact[]) => facts.filter((fact) => fact.kind === "turn-finished");

describe("branch-owned conversation observations", () => {
  it("drains a legacy peer when a turn callback throws synchronously", async () => {
    const facts: ConversationFact[] = [];
    const error = new Error("Synchronous callback failure");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = runAgentConversation(candidates, 0, (turn) => {
      if (turn.agent === AGENT_IDS[1]) throw error;
      return gate.then(() => ({ visibleMessageCount: 1 }));
    }, 2, undefined, (fact) => { facts.push(fact); });
    const rejection = expect(run).rejects.toBe(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(facts.some(({ kind }) => kind === "summary")).toBe(false);
    release(); await rejection;
    expect(facts.at(-1)).toMatchObject({ kind: "summary", summary: { pending: { activeTurns: 0 }, counts: { attemptedTurns: 2, failedTurns: 1, respondedTurns: 1 } } });
  });

  it("uses finish order rather than launch order to link concurrently produced mentions", async () => {
    const facts: ConversationFact[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = runEnergyConversation(candidates, "party", async (turn) => {
      if (turn.agent === AGENT_IDS[0]) await gate;
      return { visibleMessageCount: 1 };
    }, () => 0, { concurrencyLimit: 3, observer: (fact) => { facts.push(fact); } });
    await vi.waitFor(() => expect(finished(facts)).toHaveLength(2));
    expect(finished(facts).map((fact) => fact.agentId)).toEqual([AGENT_IDS[1], AGENT_IDS[2]]);
    release(); await run;
    const starts = decisions(facts).filter(({ action }) => action === "started");
    for (const end of finished(facts)) expect(starts.find(({ turnId }) => turnId === end.turnId)?.targetAgentId).toBe(end.agentId);
  });
  it("links actual legacy mentions to the producing turn and records the existing pair-cap drop", async () => {
    const facts: ConversationFact[] = [];
    const called: ConversationTurn[] = [];
    await runEnergyConversation(candidates.slice(0, 2), "balanced", async (turn) => {
      called.push(turn); turn.evidence!.generationId = `generation-${called.length}`;
      return { visibleMessageCount: 1, mentionedAgents: [turn.agent === AGENT_IDS[0] ? AGENT_IDS[1] : AGENT_IDS[0]] };
    }, () => 1, { observer: (fact) => { facts.push(fact); } });
    expect(called.map(({ agent }) => agent)).toEqual([AGENT_IDS[0], AGENT_IDS[1], AGENT_IDS[0]]);
    const drop = decisions(facts).find(({ reason }) => reason === "pair-cap-reached")!;
    expect(drop).toMatchObject({ action: "dropped", selectionFamily: "legacy-name-match", pairCount: 2, pairLimit: 2,
      sourceAgentId: AGENT_IDS[0], targetAgentId: AGENT_IDS[1], sourceTurnId: called[2].observation!.turnId, sourceGenerationId: "generation-3" });
    expect(finished(facts)).toHaveLength(3);
    expect(JSON.stringify(facts)).not.toContain("Instruction preservation sentinel");
    expect(decisions(facts).every(({ selectionFamily }) => !["structured-mention", "direct-vocative"].includes(selectionFamily))).toBe(true);
  });

  it("links replacement, eventual consumption, and terminal drop of legacy deferred entries", async () => {
    const facts: ConversationFact[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let invocations = 0;
    const run = runAgentConversation(candidates, 1, async (turn) => {
      invocations++;
      if (turn.agent === AGENT_IDS[0]) await gate;
      return { visibleMessageCount: 1, mentionedAgents: [AGENT_IDS[0]] };
    }, 3, undefined, (fact) => { facts.push(fact); });
    await vi.waitFor(() => expect(decisions(facts).filter(({ action }) => action === "deferred")).toHaveLength(2));
    const deferred = decisions(facts).filter(({ action }) => action === "deferred");
    const replaced = decisions(facts).find(({ reason }) => reason === "deferred-replaced")!;
    expect(replaced).toMatchObject({ pendingDecisionId: deferred[0].pendingDecisionId, relatedDecisionId: deferred[1].pendingDecisionId, action: "dropped" });
    release(); await run;
    expect(invocations).toBe(4);
    expect(decisions(facts).find(({ action, pendingDecisionId }) => action === "started" && pendingDecisionId === deferred[1].pendingDecisionId)).toBeDefined();
    expect(decisions(facts).some(({ reason }) => reason === "follow-up-allowance-exhausted")).toBe(true);
  });

  it("records a deferred entry left behind when the follow-up allowance is consumed elsewhere", async () => {
    const facts: ConversationFact[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = runAgentConversation(candidates.slice(0, 2), 1, async (turn) => {
      if (turn.agent === AGENT_IDS[0]) await gate;
      return { visibleMessageCount: 1, mentionedAgents: turn.agent === AGENT_IDS[1] ? [AGENT_IDS[0], AGENT_IDS[2]] : [] };
    }, 2, undefined, (fact) => { facts.push(fact); });
    await vi.waitFor(() => expect(decisions(facts).some(({ action }) => action === "deferred")).toBe(true));
    release(); await run;
    const deferred = decisions(facts).find(({ action }) => action === "deferred")!;
    expect(decisions(facts).find(({ action, pendingDecisionId }) => action === "dropped" && pendingDecisionId === deferred.pendingDecisionId)).toMatchObject({ reason: "follow-up-allowance-exhausted" });
  });

  it.each(CONVERSATION_ENERGY_LEVELS)("preserves %s routing, limits, output and RNG calls with adversarial observers", async (energy) => {
    async function scenario(observer?: ConversationObserver) {
      const calls: Array<{ agent: string; instruction: string; limit?: number }> = [];
      const transcript: string[] = [];
      const random = vi.fn(() => 0.6);
      const result = await runEnergyConversation(candidates, energy, async (turn) => {
        calls.push({ agent: turn.agent, instruction: turn.instruction, limit: turn.visibleMessageLimit });
        const parsed = parseAgentTurn(turn.agent, `Message ${calls.length}\n<<<NEXT>>>\nSecond unit\nCONVERSATION_STATE: OPEN`, undefined, turn.visibleMessageLimit);
        transcript.push(...parsed.visibleMessages);
        return { ...parsed, interpretation: parsed.diagnostics };
      }, random, { concurrencyLimit: 2, observer });
      return { calls, transcript, draws: random.mock.calls.length, result };
    }
    const baseline = await scenario();
    for (const observer of [
      () => { throw new Error("Observer failure"); },
      () => Promise.reject(new Error("Observer rejection")),
      () => new Promise<void>(() => {}),
      (fact: ConversationFact) => { if (fact.kind === "summary") fact.summary.engineSettled = false; if (fact.kind === "configuration") fact.configuration.candidateIds.length = 0; },
    ]) expect(await scenario(observer)).toEqual(baseline);
  });

  it.each(["agent-health-unavailable", "generation-capacity-unavailable", "provider-health-unavailable"] as const)("does not call %s a provider invocation failure", async (outcomeReason) => {
    const facts: ConversationFact[] = [];
    await runEnergyConversation(candidates.slice(0, 1), "low", async () => ({ failed: true, outcomeReason }), () => 0, { observer: (fact) => { facts.push(fact); } });
    expect(finished(facts)).toEqual([expect.objectContaining({ outcome: "blocked", reason: outcomeReason, generationId: null, attemptOrdinal: null, interpretation: null, delivery: null, engineFailed: true })]);
  });

  it.each(["energy", "legacy"] as const)("drains %s active turns before publishing its failure summary", async (engine) => {
    const facts: ConversationFact[] = [];
    const error = new Error("Original turn error");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const perform = async (turn: ConversationTurn): Promise<TurnResult> => {
      if (turn.agent === AGENT_IDS[0]) throw error;
      await gate; return { visibleMessageCount: 1 };
    };
    const observer = (fact: ConversationFact) => { facts.push(fact); };
    const run = engine === "energy" ? runEnergyConversation(candidates, "party", perform, () => 0, { concurrencyLimit: 2, observer })
      : runAgentConversation(candidates, 3, perform, 2, undefined, observer);
    const rejection = expect(run).rejects.toBe(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(facts.some(({ kind }) => kind === "summary")).toBe(false);
    release(); await rejection;
    expect(facts.at(-1)).toMatchObject({ kind: "summary", summary: { reason: "run-failed", pending: { activeTurns: 0 } } });
    expect(finished(facts)).toHaveLength(2);
    const unstarted = decisions(facts).filter(({ action }) => action === "dropped");
    expect(unstarted).toHaveLength(1); expect(unstarted[0].reason).toBe("run-failed");
  });
});
