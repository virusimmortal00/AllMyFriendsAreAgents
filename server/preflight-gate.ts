import type { ConversationEnergy } from "../shared/conversation-energy.js";
import type { PreflightMode } from "../shared/preflight.js";
import type { AgentId, RoomMessage, RoomState } from "./types.js";
import type { AgentHealth } from "./agent-health.js";

export const PREFLIGHT_REASONS = [
  "required_mention",
  "explicit_broadcast",
  "structured_task_context",
  "recent_thread_affinity",
  "ambient_selection",
  "fallback",
  "anti_starvation_probe",
  "no_routing_signal",
  "unavailable",
] as const;

export type PreflightReason = (typeof PREFLIGHT_REASONS)[number];

export interface AgentRoutingDecision {
  agent: AgentId;
  outcome: "invoke" | "suppress" | "unavailable";
  reason: PreflightReason;
}

export interface PreflightRoutingAgentState {
  consecutiveQualifyingSuppressions: number;
}

export type PreflightRoutingState = Partial<Record<AgentId, PreflightRoutingAgentState>>;

export interface PreflightConfig {
  recentMessageWindow: number;
  starvationThreshold: number;
}

export const DEFAULT_PREFLIGHT_CONFIG: Readonly<PreflightConfig> = {
  recentMessageWindow: 8,
  starvationThreshold: 25,
};

export interface PreflightInput {
  trigger: RoomMessage;
  room: RoomState;
  rankedAgents: readonly AgentId[];
  health: Partial<Record<AgentId, AgentHealth>>;
  routing: PreflightRoutingState;
  energy: ConversationEnergy;
  wholeRoomInvitation: boolean;
  structuredTargets?: readonly AgentId[];
  config?: Partial<PreflightConfig>;
}

export interface PreflightDecision {
  decisions: AgentRoutingDecision[];
  qualifyingForStarvation: boolean;
}

export interface PreflightRoutableTurn {
  agent: AgentId;
  preflight?: { decisionId: string; shadowSuppressed: boolean };
}

/** Applies an already-recorded decision without ever inventing a generation ID. */
export function routePreflightTurns<T extends PreflightRoutableTurn>(
  turns: T[],
  mode: PreflightMode,
  decision?: PreflightDecision,
  decisionId?: string,
): Array<T & PreflightRoutableTurn> {
  if (mode === "off") return turns;
  if (!decision || !decisionId) throw new Error("A recorded pre-flight decision is required outside off mode.");
  const byAgent = new Map(decision.decisions.map((entry) => [entry.agent, entry]));
  if (mode === "shadow") {
    return turns.map((turn) => ({
      ...turn,
      preflight: { decisionId, shadowSuppressed: byAgent.get(turn.agent)?.outcome === "suppress" },
    }));
  }
  return turns.filter(({ agent }) => byAgent.get(agent)?.outcome === "invoke").map((turn) => ({
    ...turn,
    preflight: { decisionId, shadowSuppressed: false },
  }));
}

const AMBIENT_SEATS: Record<ConversationEnergy, number | "all"> = {
  low: 0,
  balanced: 1,
  lively: 3,
  party: "all",
};

function recentParticipants(room: RoomState, trigger: RoomMessage, window: number) {
  const triggerIndex = room.messages.findIndex(({ id }) => id === trigger.id);
  const beforeTrigger = triggerIndex < 0 ? room.messages : room.messages.slice(0, triggerIndex);
  return new Set(beforeTrigger.slice(-window).map(({ speaker }) => speaker));
}

/**
 * Pure, deterministic responder selection. Identity, timestamps, persistence, and
 * counter mutation belong to the caller/store and are intentionally absent here.
 */
export function decidePreflight(input: PreflightInput): PreflightDecision {
  const config = { ...DEFAULT_PREFLIGHT_CONFIG, ...input.config };
  const enabled = new Set(input.rankedAgents);
  const unavailable = new Set(input.rankedAgents.filter((agent) => Boolean(input.health[agent])));
  const healthy = input.rankedAgents.filter((agent) => !unavailable.has(agent));
  const mentioned = new Set((input.trigger.mentions || [])
    .filter((mention) => mention.targetKind === "agent" && enabled.has(mention.targetId as AgentId))
    .map((mention) => mention.targetId as AgentId));
  // Continuation metadata currently identifies the canonical task/assignment but
  // does not carry an agent identity. The caller may add a trusted assignee once
  // that projection is available; prose is never used to infer one here.
  const structuredTargets = new Set((input.structuredTargets || []).filter((agent) => enabled.has(agent)));
  const required = new Set<AgentId>([...mentioned, ...structuredTargets]);
  const qualifyingForStarvation = required.size === 0 && !input.wholeRoomInvitation && !input.trigger.continuationRequest;

  const selected = new Map<AgentId, PreflightReason>();
  if (input.wholeRoomInvitation) {
    for (const agent of healthy) selected.set(agent, "explicit_broadcast");
  } else {
    for (const agent of input.rankedAgents) {
      if (!required.has(agent) || unavailable.has(agent)) continue;
      selected.set(agent, mentioned.has(agent) ? "required_mention" : "structured_task_context");
    }

    const recent = recentParticipants(input.room, input.trigger, Math.max(0, config.recentMessageWindow));
    const ambient = healthy.filter((agent) => !required.has(agent));
    const starved = qualifyingForStarvation
      ? ambient.filter((agent) => (input.routing[agent]?.consecutiveQualifyingSuppressions || 0) >= config.starvationThreshold)
      : [];
    const probe = starved[0];
    const rankedIndex = new Map(ambient.map((agent, index) => [agent, index]));
    const boostedAmbient = ambient.filter((agent) => agent !== probe).sort((left, right) => {
      const score = (agent: AgentId) => (input.routing[agent]?.consecutiveQualifyingSuppressions || 0) + (recent.has(agent) ? 8 : 0);
      return score(right) - score(left) || (rankedIndex.get(left) || 0) - (rankedIndex.get(right) || 0);
    });
    const orderedAmbient = [
      ...(probe ? [probe] : []),
      ...boostedAmbient,
    ];
    const seatLimit = AMBIENT_SEATS[input.energy];
    const ambientSelection = seatLimit === "all" ? orderedAmbient : orderedAmbient.slice(0, seatLimit);
    for (const agent of ambientSelection) {
      selected.set(agent, probe === agent
        ? "anti_starvation_probe"
        : recent.has(agent) ? "recent_thread_affinity" : "ambient_selection");
    }

    if (selected.size === 0) {
      const fallback = healthy[0];
      if (fallback) selected.set(fallback, "fallback");
    }
  }

  return {
    qualifyingForStarvation,
    decisions: input.rankedAgents.map((agent) => {
      if (unavailable.has(agent)) return { agent, outcome: "unavailable", reason: "unavailable" };
      const reason = selected.get(agent);
      return reason
        ? { agent, outcome: "invoke", reason }
        : { agent, outcome: "suppress", reason: "no_routing_signal" };
    }),
  };
}
