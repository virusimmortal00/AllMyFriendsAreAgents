import { CONVERSATION_OPTIONAL_SEATS, type ConversationEnergy } from "../shared/conversation-energy.js";
import type { PreflightMode } from "../shared/preflight.js";
import type { AgentId, RoomMessage, RoomState } from "./types.js";
import type { AgentHealth } from "./agent-health.js";
import { directAddressTargets } from "../shared/direct-address.js";
import { normalizeRoomAgentRoster } from "../shared/roster.js";
import { jevGateProfile, type JevGateProfileId } from "./jev-experiment-profiles.js";

export const PREFLIGHT_REASONS = [
  "required_mention",
  "required_plain_address",
  "explicit_broadcast",
  "structured_task_context",
  "classified_addressed",
  "recent_thread_affinity",
  "ambient_selection",
  "fallback",
  "anti_starvation_probe",
  // Retained for historical decision records; new low address scores do not suppress ambient candidates.
  "classified_irrelevant",
  "no_routing_signal",
  "unavailable",
] as const;

export type PreflightReason = (typeof PREFLIGHT_REASONS)[number];

/**
 * Advisory address classification consumed by the pure gate. Only probabilities
 * enter routing; model identity, usage, and cost ride along in the audit store.
 * An agent absent from `agents` is treated as unclassified, never as irrelevant.
 */
export interface PreflightClassificationSignal {
  agents: Partial<Record<AgentId, number>>;
  wholeRoom: number;
  /** Distinct Jev question about optional contribution, not direct address. */
  optionalWorth?: Partial<Record<AgentId, number>>;
}


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
  /** Minimum classified address probability that makes an agent a required participant. */
  classifiedAddressThreshold: number;
  /** Minimum classified whole-room probability that selects every healthy agent. */
  classifiedWholeRoomThreshold: number;
}

export const DEFAULT_PREFLIGHT_CONFIG: Readonly<PreflightConfig> = {
  recentMessageWindow: 8,
  starvationThreshold: 25,
  classifiedAddressThreshold: 0.75,
  classifiedWholeRoomThreshold: 0.7,
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
  classification?: PreflightClassificationSignal;
  gateProfileId?: JevGateProfileId;
  config?: Partial<PreflightConfig>;
}

export interface PreflightDecision {
  decisions: AgentRoutingDecision[];
  qualifyingForStarvation: boolean;
}

export interface PreflightRoutableTurn {
  agent: AgentId;
  instruction: string;
  preflight?: { decisionId: string; shadowSuppressed: boolean; required?: boolean };
}

const REQUIRED_REASONS = new Set<PreflightReason>([
  "required_mention", "required_plain_address", "structured_task_context", "classified_addressed", "explicit_broadcast",
]);
const INFERRED_ADDRESS_REASONS = new Set<PreflightReason>(["required_plain_address", "classified_addressed"]);
const INFERRED_ADDRESS_INSTRUCTION =
  "The latest human message appears to address you. Reply by default with a concise, natural answer or acknowledgment. Silence is exceptional: yield with the appropriate TURN_DISPOSITION reason only when replying would be inappropriate, unsafe, impossible, or genuinely add nothing.";

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
  return turns.filter(({ agent }) => byAgent.get(agent)?.outcome === "invoke").map((turn) => {
    const reason = byAgent.get(turn.agent)?.reason ?? "no_routing_signal";
    return {
      ...turn,
      ...(INFERRED_ADDRESS_REASONS.has(reason) ? { instruction: INFERRED_ADDRESS_INSTRUCTION } : {}),
      preflight: { decisionId, shadowSuppressed: false, required: REQUIRED_REASONS.has(reason) },
    };
  });
}

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
  const roster = normalizeRoomAgentRoster(input.room.roster);
  const plainAddressed = new Set(directAddressTargets({
    text: input.trigger.text,
    agents: roster.entries.map(({ agentId, conversationalName }) => ({ agentId, name: conversationalName ?? agentId })),
    ...(input.room.humans ? { humanNames: input.room.humans.map(({ name }) => name) } : {}),
    speaker: "human",
  }).filter((agent) => enabled.has(agent)));
  // Continuation metadata currently identifies the canonical task/assignment but
  // does not carry an agent identity. The caller may add a trusted assignee once
  // that projection is available; prose is never used to infer one here.
  const structuredTargets = new Set((input.structuredTargets || []).filter((agent) => enabled.has(agent)));
  // The classifier is advisory: a high probability adds a required participant,
  // and an absent or low probability changes nothing. Deterministic signals
  // always outrank it.
  const classifiedAddressed = new Set(input.rankedAgents.filter((agent) => {
    const probability = input.classification?.agents[agent];
    return probability !== undefined && probability >= config.classifiedAddressThreshold;
  }));
  const wholeRoomInvitation = input.wholeRoomInvitation
    || (input.classification?.wholeRoom ?? 0) >= config.classifiedWholeRoomThreshold;
  const required = new Set<AgentId>([...mentioned, ...plainAddressed, ...structuredTargets, ...classifiedAddressed]);
  const qualifyingForStarvation = required.size === 0 && !wholeRoomInvitation && !input.trigger.continuationRequest;

  const selected = new Map<AgentId, PreflightReason>();
  if (wholeRoomInvitation) {
    for (const agent of healthy) selected.set(agent, "explicit_broadcast");
  } else {
    for (const agent of input.rankedAgents) {
      if (!required.has(agent) || unavailable.has(agent)) continue;
      selected.set(agent, mentioned.has(agent)
        ? "required_mention"
        : plainAddressed.has(agent) ? "required_plain_address"
        : structuredTargets.has(agent) ? "structured_task_context" : "classified_addressed");
    }

    const recent = recentParticipants(input.room, input.trigger, Math.max(0, config.recentMessageWindow));
    const ambient = healthy.filter((agent) => !required.has(agent));
    const starved = qualifyingForStarvation
      ? ambient.filter((agent) => (input.routing[agent]?.consecutiveQualifyingSuppressions || 0) >= config.starvationThreshold)
      : [];
    const probe = starved[0];
    const optionalWorthThreshold = jevGateProfile(input.gateProfileId ?? "current-v1").optionalWorthThreshold;
    const eligibleAmbient = ambient.filter((agent) => {
      if (agent === probe) return true;
      if (optionalWorthThreshold === null) return true;
      const score = input.classification?.optionalWorth?.[agent];
      return score === undefined || score >= optionalWorthThreshold;
    });
    const rankedIndex = new Map(eligibleAmbient.map((agent, index) => [agent, index]));
    const boostedAmbient = eligibleAmbient.filter((agent) => agent !== probe).sort((left, right) => {
      const score = (agent: AgentId) => (input.routing[agent]?.consecutiveQualifyingSuppressions || 0) + (recent.has(agent) ? 8 : 0);
      return score(right) - score(left) || (rankedIndex.get(left) || 0) - (rankedIndex.get(right) || 0);
    });
    const orderedAmbient = [
      ...(probe ? [probe] : []),
      ...boostedAmbient,
    ];
    const seatLimit = CONVERSATION_OPTIONAL_SEATS[input.energy];
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
