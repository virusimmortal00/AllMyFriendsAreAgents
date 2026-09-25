import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style.js";
import type { MessageMention } from "../shared/mentions.js";
import type { AgentId, RoomMessage, RoomState } from "./types.js";
import { decidePreflight, routePreflightTurns } from "./preflight-gate.js";
import { replayJevThresholds } from "./jev-profile-replay.js";
import { requiredAt } from "./test-invariants.js";

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
    roomConfiguration: { configurationRevision: 1, basePromptRevision: 0, basePromptText: "default", summarizerModel: null, summarizerPromptText: "{{transcript}}", summarizerPromptRevision: 0, featureFlags: {}, preflightMode: "shadow", intentClassifierEnabled: true, updatedAt: null },
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
      ...requiredAt(turns,0,"first preflight turn"),
      preflight: { decisionId: "decision-1", shadowSuppressed: false, required: false },
    });
    expect(requiredAt(routePreflightTurns(turns, "enforce", decision, "decision-1"),0,"enforced preflight turn").preflight).toEqual({ decisionId: "decision-1", shadowSuppressed: false, required: false });
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
    expect(requiredAt(routed,1,"second shadow preflight turn").preflight).toEqual({ decisionId: "decision-1", shadowSuppressed: true });
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

  it("requires clear plain-name addresses despite low classifier probabilities and retains ambient selection", () => {
    const trigger = humanMessage({ text: "Claude and Grok, can you compare your answers?" });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "balanced", wholeRoomInvitation: false,
      classification: { agents: { "claude-sonnet": 0.01, "cursor-grok": 0.01, "codex-sol": 0.01 }, wholeRoom: 0 },
    });
    expect(decision.decisions).toEqual([
      { agent: "codex-sol", outcome: "invoke", reason: "ambient_selection" },
      { agent: "claude-sonnet", outcome: "invoke", reason: "required_plain_address" },
      { agent: "cursor-grok", outcome: "invoke", reason: "required_plain_address" },
      { agent: "cursor-composer", outcome: "suppress", reason: "no_routing_signal" },
    ]);
    const turns = agents.map((agent) => ({ agent, instruction: `original:${agent}` }));
    expect(routePreflightTurns(turns, "enforce", decision, "decision-plain").map(({ agent, preflight }) => [agent, preflight?.required])).toEqual([
      ["codex-sol", false], ["claude-sonnet", true], ["cursor-grok", true],
    ]);
  });

  it("reports an unavailable plain-name addressee and does not require ambiguous human names", () => {
    const trigger = humanMessage({ text: "Grok, can you check this?" });
    const unavailable = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents,
      health: { "cursor-grok": { status: "cooldown", reason: "rate_limit", message: "Cooling down", since: trigger.timestamp } },
      routing: {}, energy: "low", wholeRoomInvitation: false,
    });
    expect(unavailable.decisions.find(({ agent }) => agent === "cursor-grok")).toEqual({ agent: "cursor-grok", outcome: "unavailable", reason: "unavailable" });
    const ambiguous = decidePreflight({
      trigger, room: { ...room(trigger), humans: [{ id: "human-grok", name: "Grok", style: DEFAULT_PARTICIPANT_STYLES.you }] },
      rankedAgents: agents, health: {}, routing: {}, energy: "low", wholeRoomInvitation: false,
    });
    expect(ambiguous.decisions.find(({ agent }) => agent === "cursor-grok")?.reason).toBe("no_routing_signal");
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

describe("pre-flight advisory classification", () => {
  it("uses distinct optional-worth predictions only for optional seats", () => {
    const trigger = humanMessage({ text: "Sol, describe one sign idea." });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "balanced",
      wholeRoomInvitation: false, gateProfileId: "relevance-v1",
      classification: {
        agents: { "codex-sol": 0.01, "claude-sonnet": 0.99 }, wholeRoom: 0,
        optionalWorth: { "codex-sol": 0.01, "claude-sonnet": 0.01, "cursor-grok": 0.8 },
      },
    });
    expect(decision.decisions.find(({ agent }) => agent === "codex-sol")).toEqual({
      agent: "codex-sol", outcome: "invoke", reason: "required_plain_address",
    });
    // A high direct-address score makes Claude required; optional-worth cannot veto it.
    expect(decision.decisions.find(({ agent }) => agent === "claude-sonnet")?.outcome).toBe("invoke");
    expect(decision.decisions.find(({ agent }) => agent === "cursor-grok")?.outcome).toBe("invoke");
    expect(decision.decisions.find(({ agent }) => agent === "cursor-composer")?.outcome).toBe("suppress");
  });

  it("does not treat a low direct-address score as low optional worth or a missing score as a veto", () => {
    const trigger = humanMessage();
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "balanced",
      wholeRoomInvitation: false, gateProfileId: "relevance-v1",
      classification: { agents: { "codex-sol": 0.01 }, wholeRoom: 0, optionalWorth: {} },
    });
    expect(decision.decisions.find(({ agent }) => agent === "codex-sol")).toEqual({
      agent: "codex-sol", outcome: "invoke", reason: "ambient_selection",
    });
  });

  it("uses optional-worth predictions to choose an available optional seat", () => {
    const trigger = humanMessage();
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "balanced",
      wholeRoomInvitation: false, gateProfileId: "relevance-v1",
      classification: {
        agents: {}, wholeRoom: 0,
        optionalWorth: { "codex-sol": 0.01, "claude-sonnet": 0.8, "cursor-grok": 0.01, "cursor-composer": 0.01 },
      },
    });
    expect(decision.decisions.filter(({ outcome }) => outcome === "invoke")).toEqual([
      { agent: "claude-sonnet", outcome: "invoke", reason: "ambient_selection" },
    ]);
  });

  it("keeps a fallback but may suppress an extra optional seat, without implying saved calls", () => {
    const trigger = humanMessage();
    const input = {
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "balanced" as const,
      wholeRoomInvitation: false, classification: {
        agents: {}, wholeRoom: 0, optionalWorth: Object.fromEntries(agents.map((agent) => [agent, 0.01])),
      },
    };
    const current = decidePreflight(input);
    const relevance = decidePreflight({ ...input, gateProfileId: "relevance-v1" });
    expect(current.decisions.filter(({ outcome }) => outcome === "invoke")).toHaveLength(1);
    expect(relevance.decisions.filter(({ outcome }) => outcome === "invoke")).toEqual([
      { agent: "codex-sol", outcome: "invoke", reason: "fallback" },
    ]);
    const requiredTrigger = humanMessage({ text: "Sol, give one sign idea." });
    const requiredInput = { ...input, trigger: requiredTrigger, room: room(requiredTrigger) };
    expect(decidePreflight(requiredInput).decisions.filter(({ outcome }) => outcome === "invoke")).toHaveLength(2);
    expect(decidePreflight({ ...requiredInput, gateProfileId: "relevance-v1" }).decisions.filter(({ outcome }) => outcome === "invoke")).toEqual([
      { agent: "codex-sol", outcome: "invoke", reason: "required_plain_address" },
    ]);
  });

  it("reports an unavailable addressed target even with low optional worth", () => {
    const trigger = humanMessage({ text: "Sol, please review this." });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents,
      health: { "codex-sol": { status: "unavailable", reason: "authentication", message: "Login required", since: trigger.timestamp } },
      routing: {}, energy: "balanced", wholeRoomInvitation: false, gateProfileId: "relevance-v1",
      classification: { agents: { "codex-sol": 0.01 }, wholeRoom: 0, optionalWorth: { "codex-sol": 0.01 } },
    });
    expect(decision.decisions.find(({ agent }) => agent === "codex-sol")).toEqual({
      agent: "codex-sol", outcome: "unavailable", reason: "unavailable",
    });
  });

  it("replays bounded threshold grids as routing counts, not hypothetical replies", () => {
    const trigger = humanMessage({ text: "Sol, give one idea." });
    const input = {
      trigger, room: room(trigger), rankedAgents: agents,
      health: { "cursor-grok": { status: "unavailable" as const, reason: "authentication" as const, message: "Login required", since: trigger.timestamp } },
      routing: {}, energy: "low" as const, wholeRoomInvitation: false,
      classification: { agents: { "claude-sonnet": 0.7 }, wholeRoom: 0.1 },
    };
    expect(replayJevThresholds(input, [
      { address: 0.6, wholeRoom: 0.7 }, { address: 0.75, wholeRoom: 0.7 },
    ])).toEqual([
      { addressThreshold: 0.6, wholeRoomThreshold: 0.7, requiredCount: 2, optionalCount: 0, unavailableCount: 1 },
      { addressThreshold: 0.75, wholeRoomThreshold: 0.7, requiredCount: 1, optionalCount: 0, unavailableCount: 1 },
    ]);
    expect(() => replayJevThresholds(input, [{ address: -0.1, wholeRoom: 0.7 }])).toThrow();
  });

  it("makes a confidently addressed agent a required participant without a mention", () => {
    const trigger = humanMessage({ text: "Sol, can you take a look at this?" });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "low", wholeRoomInvitation: false,
      classification: { agents: { "codex-sol": 0.93 }, wholeRoom: 0.02 },
    });
    expect(decision.decisions.find(({ agent }) => agent === "codex-sol")).toEqual({
      agent: "codex-sol", outcome: "invoke", reason: "required_plain_address",
    });
    expect(decision.qualifyingForStarvation).toBe(false);
  });

  it("keeps a canonical mention ahead of a low classified address probability", () => {
    const trigger = humanMessage({ mentions: [mention("claude-sonnet")], text: "@Claude what changed?" });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "low", wholeRoomInvitation: false,
      classification: { agents: { "claude-sonnet": 0.01 }, wholeRoom: 0.0 },
    });
    expect(decision.decisions.find(({ agent }) => agent === "claude-sonnet")).toEqual({
      agent: "claude-sonnet", outcome: "invoke", reason: "required_mention",
    });
  });

  it("keeps a low scored agent eligible for a distinct ambient contribution", () => {
    const trigger = humanMessage();
    const earlier = [{ id: "agent-1", speaker: "cursor-composer" as const, text: "Earlier thought", timestamp: "2026-08-27T11:59:00.000Z", kind: "chat" as const }];
    const decision = decidePreflight({
      trigger, room: room(trigger, earlier), rankedAgents: agents, health: {}, routing: {}, energy: "balanced", wholeRoomInvitation: false,
      classification: { agents: { "cursor-composer": 0.02, "codex-sol": 0.5, "cursor-grok": 0.5 }, wholeRoom: 0.0 },
    });
    expect(decision.decisions.find(({ agent }) => agent === "cursor-composer")).toEqual({
      agent: "cursor-composer", outcome: "invoke", reason: "recent_thread_affinity",
    });
    expect(decision.decisions.find(({ agent }) => agent === "codex-sol")).toEqual({
      agent: "codex-sol", outcome: "suppress", reason: "no_routing_signal",
    });
  });

  it("still selects a fallback agent when every healthy agent is classified irrelevant", () => {
    const trigger = humanMessage();
    const classification = { agents: Object.fromEntries(agents.map((agent) => [agent, 0.01])), wholeRoom: 0.0 };
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "low", wholeRoomInvitation: false,
      classification,
    });
    expect(decision.decisions.filter(({ outcome }) => outcome === "invoke")).toEqual([
      { agent: "codex-sol", outcome: "invoke", reason: "fallback" },
    ]);
  });

  it("selects the whole roster when classified whole-room probability crosses the threshold", () => {
    const trigger = humanMessage({ text: "Thoughts from the group?" });
    const decision = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "low", wholeRoomInvitation: false,
      classification: { agents: {}, wholeRoom: 0.88 },
    });
    expect(decision.decisions.every(({ outcome }) => outcome === "invoke")).toBe(true);
    expect(decision.decisions.filter(({ reason }) => reason === "explicit_broadcast")).toHaveLength(agents.length);
  });

  it("treats an unclassified agent exactly as the deterministic gate would", () => {
    const trigger = humanMessage();
    const baseline = decidePreflight({ trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "balanced", wholeRoomInvitation: false });
    const withPartialClassification = decidePreflight({
      trigger, room: room(trigger), rankedAgents: agents, health: {}, routing: {}, energy: "balanced", wholeRoomInvitation: false,
      classification: { agents: { "claude-sonnet": 0.5 }, wholeRoom: 0.3 },
    });
    expect(withPartialClassification.decisions).toEqual(baseline.decisions);
  });
});
