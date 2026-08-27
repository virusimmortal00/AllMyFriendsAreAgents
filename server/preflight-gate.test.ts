import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import type { MessageMention } from "../shared/mentions.js";
import type { AgentId, RoomMessage, RoomState } from "./types.js";
import { decidePreflight, routePreflightTurns } from "./preflight-gate.js";

const agents = ["codex-sol", "claude-sonnet", "cursor-grok", "cursor-composer"] as const satisfies readonly AgentId[];

function humanMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return { id: "human-1", speaker: "you", text: "What do you think?", timestamp: "2026-08-27T12:00:00.000Z", kind: "chat", ...overrides };
}

function room(trigger: RoomMessage, earlier: RoomMessage[] = []): RoomState {
  return {
    messages: [...earlier, trigger],
    sessions: {},
    settings: {
      roomName: "Test Room",
      topic: "Testing",
      writableAgent: "nobody",
      conversationEnergy: "balanced",
      projectPath: process.cwd(),
      participantStyles: structuredClone(DEFAULT_PARTICIPANT_STYLES),
    },
    roomConfiguration: { configurationRevision: 1, basePromptRevision: 0, basePromptText: "default", summarizerModel: null, summarizerPromptText: "{{transcript}}", summarizerPromptRevision: 0, featureFlags: {}, preflightMode: "shadow", updatedAt: null },
    status: "idle",
  };
}

function mention(agent: AgentId): MessageMention {
  return { targetKind: "agent", targetId: agent, label: agent, revision: 1, start: 0, end: agent.length + 1 };
}

describe("pre-flight responder selection", () => {
  it("returns the original turn list by identity in off mode", () => {
    const turns = agents.map((agent) => ({ agent, instruction: `original:${agent}` }));
    expect(routePreflightTurns(turns, "off")).toBe(turns);
    expect(routePreflightTurns(turns, "off")).toEqual(turns);
  });

  it("never passes an enforced suppression to the invocation callback", async () => {
    const turns = agents.map((agent) => ({ agent, instruction: `original:${agent}` }));
    const decision = {
      qualifyingForStarvation: true,
      decisions: agents.map((agent, index) => index === 0
        ? { agent, outcome: "invoke" as const, reason: "fallback" as const }
        : { agent, outcome: "suppress" as const, reason: "no_routing_signal" as const }),
    };
    const runAgent = vi.fn(async (_turn: (typeof turns)[number]) => undefined);
    for (const turn of routePreflightTurns(turns, "enforce", decision, "decision-1")) await runAgent(turn);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenCalledWith({
      ...turns[0],
      preflight: { decisionId: "decision-1", shadowSuppressed: false },
    });
    expect(routePreflightTurns(turns, "enforce", decision, "decision-1")[0].preflight).toEqual({ decisionId: "decision-1", shadowSuppressed: false });
  });

  it("records shadow annotations without changing the invoked roster", () => {
    const turns = agents.map((agent) => ({ agent, instruction: `original:${agent}` }));
    const decision = {
      qualifyingForStarvation: true,
      decisions: agents.map((agent, index) => index === 0
        ? { agent, outcome: "invoke" as const, reason: "fallback" as const }
        : { agent, outcome: "suppress" as const, reason: "no_routing_signal" as const }),
    };
    const routed = routePreflightTurns(turns, "shadow", decision, "decision-1");
    expect(routed.map(({ agent }) => agent)).toEqual(agents);
    expect(routed[1].preflight).toEqual({ decisionId: "decision-1", shadowSuppressed: true });
  });

  it("always invokes a healthy mentioned agent while retaining one balanced ambient seat", () => {
    const trigger = humanMessage({ mentions: [mention("claude-sonnet")] });
    const decision = decidePreflight({
      trigger,
      room: room(trigger),
      rankedAgents: agents,
      health: {}, routing: {}, energy: "balanced", wholeRoomInvitation: false,
    });
    expect(decision.decisions).toEqual([
      { agent: "codex-sol", outcome: "invoke", reason: "ambient_selection" },
      { agent: "claude-sonnet", outcome: "invoke", reason: "required_mention" },
      { agent: "cursor-grok", outcome: "suppress", reason: "no_routing_signal" },
      { agent: "cursor-composer", outcome: "suppress", reason: "no_routing_signal" },
    ]);
  });

  it("selects a trusted structured task target without inferring one from prose", () => {
    const trigger = humanMessage({
      text: "Please continue this bounded task.",
      continuationRequest: { taskId: "task-1", taskRevision: 2, assignmentReferenceId: "assignment-ref", objective: "Continue the check" },
    });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "low", wholeRoomInvitation: false,
      structuredTargets: ["cursor-grok"],
    });
    expect(decision.decisions.filter(({ outcome }) => outcome === "invoke")).toEqual([
      { agent: "cursor-grok", outcome: "invoke", reason: "structured_task_context" },
    ]);
    expect(decision.qualifyingForStarvation).toBe(false);
  });

  it("selects the entire healthy roster for an explicit whole-room invitation", () => {
    const trigger = humanMessage({ text: "What do you all think?" });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents,
      health: { "cursor-grok": { status: "cooldown", reason: "rate_limit", message: "Cooling down", since: trigger.timestamp } },
      routing: {}, energy: "low", wholeRoomInvitation: true,
    });
    expect(decision.decisions.filter(({ outcome }) => outcome === "invoke").map(({ agent }) => agent)).toEqual(["codex-sol", "claude-sonnet", "cursor-composer"]);
    expect(decision.decisions.find(({ agent }) => agent === "cursor-grok")).toEqual({ agent: "cursor-grok", outcome: "unavailable", reason: "unavailable" });
  });

  it("reports an explicitly mentioned unhealthy agent as unavailable instead of suppressing it", () => {
    const trigger = humanMessage({ mentions: [mention("cursor-grok")] });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents,
      health: { "cursor-grok": { status: "unavailable", reason: "authentication", message: "Login required", since: trigger.timestamp } },
      routing: {}, energy: "low", wholeRoomInvitation: false,
    });
    expect(decision.decisions.find(({ agent }) => agent === "cursor-grok")).toEqual({
      agent: "cursor-grok", outcome: "unavailable", reason: "unavailable",
    });
  });

  it("chooses exactly one deterministic fallback at low energy", () => {
    const trigger = humanMessage();
    const decision = decidePreflight({ trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "low", wholeRoomInvitation: false });
    expect(decision.decisions.filter(({ outcome }) => outcome === "invoke")).toEqual([
      { agent: "codex-sol", outcome: "invoke", reason: "fallback" },
    ]);
  });

  it("prioritizes recent thread participants within the ambient limit", () => {
    const trigger = humanMessage();
    const earlier = [{ id: "agent-1", speaker: "cursor-composer" as const, text: "Earlier thought", timestamp: "2026-08-27T11:59:00.000Z", kind: "chat" as const }];
    const decision = decidePreflight({ trigger, room: room(trigger, earlier), rankedAgents: agents, health: {}, routing: {}, energy: "balanced", wholeRoomInvitation: false });
    expect(decision.decisions.find(({ outcome }) => outcome === "invoke")).toEqual({ agent: "cursor-composer", outcome: "invoke", reason: "recent_thread_affinity" });
  });

  it("selects at most one starvation probe with deterministic ranked tie-breaking", () => {
    const trigger = humanMessage();
    const routing = Object.fromEntries(agents.map((agent) => [agent, { consecutiveQualifyingSuppressions: 25 }]));
    const decision = decidePreflight({ trigger, room: room(trigger), rankedAgents: agents, health: {}, routing, energy: "balanced", wholeRoomInvitation: false });
    expect(decision.decisions.filter(({ reason }) => reason === "anti_starvation_probe")).toEqual([
      { agent: "codex-sol", outcome: "invoke", reason: "anti_starvation_probe" },
    ]);
  });

  it("boosts a long-suppressed ambient agent before the forced-probe threshold", () => {
    const trigger = humanMessage();
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, energy: "balanced", wholeRoomInvitation: false,
      routing: { "cursor-composer": { consecutiveQualifyingSuppressions: 24 } },
    });
    expect(decision.decisions.find(({ outcome }) => outcome === "invoke")).toEqual({
      agent: "cursor-composer", outcome: "invoke", reason: "ambient_selection",
    });
  });

  it("allows every socially eligible healthy agent at party energy", () => {
    const trigger = humanMessage();
    const decision = decidePreflight({ trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "party", wholeRoomInvitation: false });
    expect(decision.decisions.every(({ outcome }) => outcome === "invoke")).toBe(true);
  });
});
