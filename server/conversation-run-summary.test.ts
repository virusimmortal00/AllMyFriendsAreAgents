import { describe, expect, it, vi } from "vitest";
import type { ConversationRunSummary } from "../shared/conversation-observability.js";
import { AGENT_IDS } from "../shared/participants.js";
import { parseAgentTurn, runAgentConversation, runEnergyConversation, type ConversationTurn, type TurnResult } from "./conversation.js";
import { withGenerationDelivery } from "./generation-delivery.js";

const candidates: ConversationTurn[] = AGENT_IDS.map((agent) => ({ agent, instruction: "Consider joining." }));
const parsedResult = (text: string): TurnResult => {
  const parsed = parseAgentTurn(AGENT_IDS[0], text);
  return { ...parsed, interpretation: parsed.diagnostics };
};

describe("additive conversation terminal facts", () => {
  it.each(["yield", "failed", "empty"] as const)("does not turn the existing all-%s settled flag into consensus evidence", async (mode) => {
    const turn = mode === "yield" ? parsedResult('TURN_DISPOSITION: {"action":"yield","reason":"already_covered"}\nCONVERSATION_STATE: SETTLED') : mode === "failed" ? { failed: true } : {};
    const performTurn = vi.fn(async () => turn);
    const random = vi.fn(() => 0);
    const result = await runEnergyConversation(candidates, "low", performTurn, random);
    expect(result.settled).toBe(true);
    expect(result.summary).toMatchObject({ reason: "no-visible-output", engineSettled: true, phase: "opening", counts: {
      attemptedTurns: candidates.length, respondedTurns: 0, effectiveSettledTurns: 0,
      yieldedTurns: mode === "yield" ? candidates.length : 0, failedTurns: mode === "failed" ? candidates.length : 0,
      declaredSettledTurns: mode === "yield" ? candidates.length : 0,
    } });
    expect(performTurn.mock.calls).toHaveLength(candidates.length);
    expect(random).not.toHaveBeenCalled();
  });

  it("preserves the exact convergence schedule and RNG budget while identifying the terminal branch", async () => {
    const script: TurnResult[] = [
      { visibleMessageCount: 1, conversationState: "open" },
      { visibleMessageCount: 1, conversationState: "settled" },
      { visibleMessageCount: 1, conversationState: "open" },
      { visibleMessageCount: 1, conversationState: "open" },
      { visibleMessageCount: 1, conversationState: "settled" },
    ];
    const performed: ConversationTurn[] = [];
    const random = vi.fn(() => 0);
    const result = await runEnergyConversation(candidates, "balanced", async (turn) => {
      performed.push(turn); return script[performed.length - 1] || {};
    }, random, { concurrencyLimit: 2 });
    expect(performed.map(({ agent, visibleMessageLimit, visibleMessageLimitSource }) => [agent, visibleMessageLimit, visibleMessageLimitSource])).toEqual([
      [AGENT_IDS[0], 1, "opening"], [AGENT_IDS[1], 1, "opening"],
      [AGENT_IDS[1], 1, "synthesis"], [AGENT_IDS[0], 1, "objection"], [AGENT_IDS[1], 1, "reconciliation"],
    ]);
    expect(random).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ settled: true, summary: { reason: "reconciliation-settled", phase: "reconciliation", counts: { attemptedTurns: 5, respondedTurns: 5, confirmedDeliveredBursts: 0, turnsWithoutDeliveryEvidence: 5 } } });
  });

  it("does not erase partial delivery when a cancelled turn has no scheduler response count", async () => {
    const result = await runEnergyConversation(candidates, "low", async () => withGenerationDelivery(3, () => {}, async (ledger) => {
      await ledger.write(0, async () => ({ id: "one" }));
      ledger.finish("cancelled", "burst-interrupted"); return { cancelled: true };
    }));
    expect(result.summary).toMatchObject({ reason: "cancelled", engineSettled: false, counts: { attemptedTurns: 1, respondedTurns: 0, cancelledTurns: 1, confirmedDeliveredBursts: 1, confirmedUndeliveredBursts: 2 }, policy: { responseTurns: 0, visibleMessages: 0 } });
  });

  it.each(["energy", "legacy"] as const)("finalizes %s failure after concurrent work drains and preserves thrown delivery evidence", async (engine) => {
    const summaries: ConversationRunSummary[] = [];
    const error = new Error("Fixture write failure");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    const perform = async (turn: ConversationTurn): Promise<TurnResult> => {
      started += 1;
      if (turn.agent === AGENT_IDS[1]) { await blocked; return { visibleMessageCount: 1 }; }
      return withGenerationDelivery(2, (delivery) => { turn.evidence!.delivery = delivery; }, async (ledger) => {
        await ledger.write(0, async () => ({ id: "one" }));
        await ledger.write(1, async () => { throw error; });
        return {};
      });
    };
    const onSummary = (summary: ConversationRunSummary) => { summaries.push(summary); };
    const run = engine === "energy"
      ? runEnergyConversation(candidates, "party", perform, () => 0, { concurrencyLimit: 2, onSummary })
      : runAgentConversation(candidates, 2, perform, 2, onSummary);
    const rejection = expect(run).rejects.toBe(error);
    await vi.waitFor(() => expect(started).toBe(2));
    // Let the first rejection reach the scheduler before releasing its peer.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toBe(2);
    expect(summaries).toHaveLength(0);
    release(); await rejection;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ engine, reason: "run-failed", engineSettled: null, counts: { attemptedTurns: 2, failedTurns: 1, respondedTurns: 1, confirmedDeliveredBursts: 1, unconfirmedBursts: 1 }, pending: { candidates: candidates.length - 2, activeTurns: 0, disposition: "abandoned" } });
  });

  it("records cancellation during objections without silently changing the existing settled flag", async () => {
    const script: TurnResult[] = [{ visibleMessageCount: 1, conversationState: "open" }, { visibleMessageCount: 1 }, { visibleMessageCount: 1, conversationState: "open" }, { cancelled: true }];
    const result = await runEnergyConversation(candidates, "balanced", async () => script.shift() || {}, () => 0, { concurrencyLimit: 2 });
    expect(result).toMatchObject({ settled: true, summary: { reason: "no-material-objection", engineSettled: true, phase: "objection", counts: { cancelledTurns: 1 } } });
  });

  it("distinguishes message and turn ceilings using the engine's original policy counters", async () => {
    const result = await runEnergyConversation(candidates, "low", async (turn) => ({ visibleMessageCount: turn.visibleMessageLimit, conversationState: "open", mentionedAgents: [AGENT_IDS[1]] }), () => 1);
    expect(result.summary.policy).toMatchObject({ messageCeilingReached: true, turnCeilingReached: false, visibleMessages: 3, responseTurns: 1 });
    // The pre-existing single-responder branch precedes the ceiling branch.
    expect(result.summary.reason).toBe("open-without-second-responder");
  });

  it("keeps legacy absence of semantic settlement explicit and preserves its follow-up order", async () => {
    const performed: string[] = [];
    const result = await runAgentConversation(candidates.slice(0, 2), 1, async (turn) => {
      performed.push(turn.agent);
      return { visibleMessageCount: 1, mentionedAgents: [AGENT_IDS[0]] };
    }, 1);
    expect(performed).toEqual([AGENT_IDS[0], AGENT_IDS[1], AGENT_IDS[0]]);
    expect(result.summary).toMatchObject({ engine: "legacy", reason: "follow-up-limit", engineSettled: null, counts: { attemptedTurns: 3 }, policy: { followUps: 1 } });
  });

  it.each(["throw", "reject", "stall"])("does not await or propagate a terminal observer %s", async (mode) => {
    const onSummary = vi.fn(() => {
      if (mode === "throw") throw new Error("Observer");
      if (mode === "reject") return Promise.reject(new Error("Observer"));
      return new Promise<void>(() => {});
    });
    const result = await runEnergyConversation([], "low", async () => ({}), () => 0, { onSummary });
    expect(result.settled).toBe(true); expect(onSummary).toHaveBeenCalledOnce();
  });
});
