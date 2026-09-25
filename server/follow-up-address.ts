import { directAddressTargets, directHumanAddressNames, visibleAddressProse, type AddressableAgent } from "../shared/direct-address.js";
import { AGENT_PROFILES, type AgentId } from "../shared/participants.js";

export interface FollowUpAddressContext {
  agents?: readonly AddressableAgent[];
  humanNames?: readonly string[];
}

const WHOLE_ROOM_REQUEST = /^(?:(?:hey|hi)\s+)?(?:everyone|everybody|all of you|each of you|you each|whole room)\s*[,—:]?\s*(?:can|could|would|will|please|what|how|share|give|tell|respond|answer|reply|weigh)\b/i;
const MATERIAL_DISAGREEMENT = /\b(?:disagree(?:ment)?|counterpoint|objection|conflict|contradict(?:ion|ory)?|unresolved|inconsisten(?:t|cy)|trade-?off|contested|dispute(?:d)?)\b/i;
const NEGATED_DISAGREEMENT = /\b(?:no|not|without)\s+(?:material\s+)?(?:disagreement|objection|conflict|contradiction|unresolved|inconsistency|dispute)\b/i;

/** Conservative cues from visible output. These are routing hints, not proof of semantics. */
export function followUpAddress(text: string, source: AgentId, roomAgents: readonly AgentId[], context: FollowUpAddressContext = {}) {
  const agents = context.agents ?? roomAgents.map((agentId) =>
    ({ agentId, name: AGENT_PROFILES[agentId]?.conversationalName || agentId }));
  const prose = visibleAddressProse(text);
  const input = { text: prose, agents, ...(context.humanNames ? { humanNames: context.humanNames } : {}), speaker: "agent" as const };
  const direct = new Set(directAddressTargets(input).filter((agentId) => agentId !== source && roomAgents.includes(agentId)));
  // Generated @ text has no trusted metadata; it follows the same request rule.
  if (WHOLE_ROOM_REQUEST.test(prose.trim())) for (const agentId of roomAgents) if (agentId !== source) direct.add(agentId);
  return {
    directAgents: [...direct],
    humanHandoff: directHumanAddressNames(input).length > 0,
    materialDisagreement: prose.split(/\n|(?<=[.!?])\s+/).some((sentence) =>
      MATERIAL_DISAGREEMENT.test(sentence) && !NEGATED_DISAGREEMENT.test(sentence)),
  };
}
