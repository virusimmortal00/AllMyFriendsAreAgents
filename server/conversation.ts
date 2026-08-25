import type { AgentId, RoomState } from "./types.js";
import { stripUnsupportedEmoji } from "../shared/aim-smileys.js";
import { extractStyleDirective, type ChatStyle } from "../shared/chat-style.js";
import { CONVERSATION_ENERGY_POLICIES, type ConversationEnergy } from "../shared/conversation-energy.js";
import { isNoResponseNeeded, visibleAgentChatText } from "../shared/message-format.js";
import { AGENT_IDS, AGENT_PROFILES, agentScreenName, isActiveAgentId } from "../shared/participants.js";

export interface ConversationTurn {
  agent: AgentId;
  instruction: string;
  includeDiff?: boolean;
  visibleMessageLimit?: number;
}

export interface TurnResult {
  replyCandidates?: AgentId[];
  mentionedAgents?: AgentId[];
  visibleMessageCount?: number;
  continuationWorthy?: boolean;
  conversationState?: ConversationState;
  cancelled?: boolean;
  failed?: boolean;
  investigationRequest?: InvestigationRequest;
}

export interface InvestigationRequest { objective: string; trigger: string; evidenceRefs: Array<{ kind: "project_artifact" | "observability"; ref: string; label?: string }> }

export type ConversationState = "settled" | "open" | "blocked";

export interface ConversationRunResult {
  pauseReason?: string;
  settled: boolean;
}

const NEXT_MESSAGE = /^\s*<<<NEXT>>>\s*$/gim;
const CONTINUATION_CUE = /\?|\b(?:actually|but|counterpoint|curious|disagree|however|not sure|on the other hand)\b/i;
const CONVERSATION_STATE = /^\s*CONVERSATION_STATE:\s*(SETTLED|OPEN|BLOCKED)\s*$/im;
const INVESTIGATION_REQUEST = /^\s*INVESTIGATION_REQUEST:\s*(\{[^\n]*\})\s*$/im;
const WHOLE_ROOM_INVITATION = /\b(?:everyone|everybody|all of you|you all|you guys|whole room|entire room|hi all|hey all)\b|\by[’']?all\b/i;
const WHOLE_ROOM_EXCLUSION = /\b(?:not everyone|not everybody|no need for (?:everyone|everybody|all of you)|(?:everyone|everybody) (?:doesn['’]?t|does not|needn['’]?t|need not) need to)\b/i;

function hashUnit(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

export function conversationRandom(state: RoomState) {
  const seed = state.messages.findLast(({ speaker }) => speaker === "you")?.id || state.settings.topic;
  let value = Math.max(1, Math.floor(hashUnit(seed) * 0xffffffff));
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 4294967296;
  };
}

export function rankRoomAgents(state: RoomState, jitter: (agent: AgentId) => number = (agent) => {
  const seed = state.messages.findLast(({ speaker }) => speaker === "you")?.id || state.settings.topic;
  return hashUnit(`${seed}:${agent}`);
}) {
  const topicStart = state.messages.findLastIndex(({ kind }) => kind === "topic");
  const messages = state.messages.slice(Math.max(0, topicStart));
  const latestHumanIndex = messages.findLastIndex(({ speaker }) => speaker === "you");
  let continuityAgent: AgentId | undefined;
  for (let index = latestHumanIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind === "topic") break;
    if (isActiveAgentId(message.speaker)) {
      continuityAgent = message.speaker as AgentId;
      break;
    }
  }
  const recent = messages.slice(Math.max(0, messages.length - 24));

  return [...AGENT_IDS].sort((left, right) => {
    const score = (agent: AgentId) => {
      const lastSpoke = messages.findLastIndex(({ speaker }) => speaker === agent);
      const quietDistance = lastSpoke < 0 ? 12 : Math.max(0, messages.length - 1 - lastSpoke);
      const recentEngagement = recent.filter(({ speaker }) => speaker === agent).length;
      const latestHuman = messages[latestHumanIndex];
      const directlyMentioned = latestHuman?.mentions?.some(
        (mention) => mention.targetKind === "agent" && mention.targetId === agent
      );
      return (directlyMentioned ? 100 : 0)
        + (agent === continuityAgent ? 12 : 0)
        + Math.min(4, recentEngagement) * 1.25
        + Math.min(6, quietDistance * 0.45)
        + jitter(agent) * 4;
    };
    return score(right) - score(left);
  });
}

export function latestHumanInvitesWholeRoom(state: RoomState) {
  const latestHumanMessage = state.messages.findLast(({ speaker }) => speaker === "you");
  return Boolean(latestHumanMessage
    && WHOLE_ROOM_INVITATION.test(latestHumanMessage.text)
    && !WHOLE_ROOM_EXCLUSION.test(latestHumanMessage.text));
}

export function roomMessageTurns(state: RoomState): ConversationTurn[] {
  const latestHumanMessage = state.messages.findLast(({ speaker }) => speaker === "you");
  const wholeRoomInvitation = latestHumanInvitesWholeRoom(state);
  return rankRoomAgents(state).map((agent) => {
    const isDirectlyMentioned = latestHumanMessage?.mentions?.some(
      (mention) => mention.targetKind === "agent" && mention.targetId === agent
    );
    return {
      agent,
      instruction: isDirectlyMentioned
        ? "You were explicitly mentioned in the latest human message. Read the current room discussion and give your own concise, natural answer if you have one. Do not merely echo another participant; use NO_RESPONSE_NEEDED if silence is still more natural."
        : wholeRoomInvitation
        ? "The latest human message explicitly invites the whole room, including you. Give your own concise, natural answer if you have one. Do not merely echo another participant; use NO_RESPONSE_NEEDED if silence is still more natural."
        : "Read the latest human message and current room discussion. First decide whether the message is actually directed at you or whether a side reaction from you would be natural and useful. Respond only if so; otherwise use NO_RESPONSE_NEEDED.",
    };
  });
}

export function parseAgentTurn(agent: AgentId, text: string, currentStyle?: ChatStyle, visibleMessageLimit = 3) {
  const declaredState = CONVERSATION_STATE.exec(text)?.[1]?.toLowerCase() as ConversationState | undefined;
  const investigationRequest = parseInvestigationRequest(text);
  if (isNoResponseNeeded(text)) return { visibleMessages: [], replyCandidates: [], mentionedAgents: [], visibleMessageCount: 0, continuationWorthy: false, ...(investigationRequest ? { investigationRequest } : {}) };
  const visibleMessages = visibleAgentChatText(text)
    .split(NEXT_MESSAGE)
    .map(stripUnsupportedEmoji)
    .filter((message) => message && message !== "NO_RESPONSE_NEEDED")
    .slice(0, Math.max(0, Math.min(3, visibleMessageLimit)));
  const combinedText = visibleMessages.join("\n");
  const otherAgents = AGENT_IDS.filter((candidate) => candidate !== agent);
  const mentionedAgents = otherAgents.filter((candidate) => {
    const profile = AGENT_PROFILES[candidate];
    const namePattern = new RegExp(`\\b${profile.conversationalName}\\b`, "i");
    return namePattern.test(combinedText);
  });
  const styleUpdate = currentStyle ? extractStyleDirective(text, currentStyle) : undefined;
  return {
    visibleMessages,
    replyCandidates: visibleMessages.length > 0 ? otherAgents : [],
    mentionedAgents,
    visibleMessageCount: visibleMessages.length,
    continuationWorthy: visibleMessages.length > 0 && (mentionedAgents.length > 0 || CONTINUATION_CUE.test(combinedText)),
    ...(declaredState ? { conversationState: declaredState } : {}),
    ...(styleUpdate ? { styleUpdate } : {}),
    ...(investigationRequest ? { investigationRequest } : {}),
  };
}

function parseInvestigationRequest(text: string): InvestigationRequest | undefined {
  const raw = INVESTIGATION_REQUEST.exec(text)?.[1]; if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<InvestigationRequest>;
    if (typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 4_000 || typeof value.trigger !== "string" || !value.trigger.trim() || value.trigger.length > 1_000) return undefined;
    const evidenceRefs = Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((item): item is InvestigationRequest["evidenceRefs"][number] => Boolean(item && (item.kind === "project_artifact" || item.kind === "observability") && typeof item.ref === "string" && item.ref.length <= 1_000 && (item.label === undefined || typeof item.label === "string" && item.label.length <= 500))).slice(0, 16) : [];
    return { objective: value.objective.trim(), trigger: value.trigger.trim(), evidenceRefs };
  } catch { return undefined; }
}

function followUpInstruction(sourceAgent: AgentId, directlyMentioned: boolean) {
  const sourceName = agentScreenName(sourceAgent);
  const mentionContext = directlyMentioned ? " They addressed you directly." : "";
  return `${sourceName} just added a message to the room.${mentionContext} This is an optional chance to join after seeing the updated transcript. Respond only if you have a distinct, natural contribution, a real answer, or a useful disagreement. Do not echo reactions already given or ask a question merely to keep the room moving. Otherwise reply exactly NO_RESPONSE_NEEDED.`;
}

interface EnergyOutcome {
  turn: ConversationTurn;
  result: TurnResult;
  responded: boolean;
  key: number;
}

const MAX_OBJECTION_TURNS = 4;

function synthesisInstruction() {
  return "Act as the discussion synthesizer. Summarize the positions that are actually present, identify any material disagreement, and propose the smallest concrete resolution. Do not invent consensus. If this is casual conversation or there is nothing meaningful to resolve, use NO_RESPONSE_NEEDED. End a visible response with CONVERSATION_STATE: SETTLED when the room has a usable conclusion, OPEN when a specific unresolved point still merits agent discussion, or BLOCKED when human input is required.";
}

function objectionInstruction(synthesizer: AgentId) {
  return `${agentScreenName(synthesizer)} just synthesized the discussion. Reply only if there is a material omission, factual error, or unresolved objection that would change the conclusion; otherwise use NO_RESPONSE_NEEDED. Be concise and propose a correction. End a visible response with CONVERSATION_STATE: OPEN if another reconciliation turn is needed or BLOCKED if human input is required.`;
}

function reconciliationInstruction() {
  return "Reconcile the material objections to your synthesis. State the final shared conclusion and preserve any genuine dissent. Do not prolong the discussion merely to sound complete. End with CONVERSATION_STATE: SETTLED if the group now has a usable conclusion, OPEN only if one specific agent-level disagreement remains, or BLOCKED if human input is required.";
}

export async function runEnergyConversation(
  candidates: ConversationTurn[],
  energy: ConversationEnergy,
  performTurn: (turn: ConversationTurn) => Promise<TurnResult>,
  random: () => number = Math.random,
  options: { inviteAll?: boolean } = {},
): Promise<ConversationRunResult> {
  const policy = CONVERSATION_ENERGY_POLICIES[energy];
  const participantLimit = policy.participantLimit === "all" ? candidates.length : policy.participantLimit;
  const convergenceReserve = 2 + Math.min(MAX_OBJECTION_TURNS, Math.max(0, participantLimit - 1));
  const scalesToWholeRoom = options.inviteAll || policy.participantLimit === "all";
  const hardMessageCeiling = scalesToWholeRoom
    ? Math.max(policy.hardMessageCeiling, candidates.length + convergenceReserve)
    : policy.hardMessageCeiling;
  const hardTurnCeiling = scalesToWholeRoom
    ? Math.max(policy.hardTurnCeiling, candidates.length + convergenceReserve)
    : policy.hardTurnCeiling;
  const remaining = [...candidates];
  const invited = new Set<AgentId>();
  const pendingMentions: Array<{ source: AgentId; target: AgentId; includeDiff?: boolean }> = [];
  const pairReplies = new Map<string, number>();
  const usedContinuationSources = new Set<number>();
  let lastOutcome: EnergyOutcome | undefined;
  let responseTurns = 0;
  let visibleMessagesDelivered = 0;
  let energySpent = 0;
  let secondaryAttempts = 0;
  let nextOutcomeKey = 0;
  let cancelled = false;
  const visibleOutcomes: EnergyOutcome[] = [];

  const record = async (turn: ConversationTurn, messageLimit = 3): Promise<EnergyOutcome> => {
    invited.add(turn.agent);
    const result = await performTurn({
      ...turn,
      visibleMessageLimit: Math.min(messageLimit, hardMessageCeiling - visibleMessagesDelivered),
    });
    if (result.cancelled) cancelled = true;
    const visibleMessageCount = Math.max(0, result.visibleMessageCount || 0);
    const responded = visibleMessageCount > 0;
    const outcome = { turn, result, responded, key: nextOutcomeKey };
    nextOutcomeKey += 1;
    if (responded) {
      responseTurns += 1;
      visibleMessagesDelivered += visibleMessageCount;
      energySpent += visibleMessageCount + Math.floor((responseTurns - 1) / 2);
      for (const target of result.mentionedAgents || []) {
        if (target !== turn.agent) pendingMentions.push({ source: turn.agent, target, includeDiff: turn.includeDiff });
      }
      lastOutcome = outcome;
      visibleOutcomes.push(outcome);
    }
    return outcome;
  };

  if (options.inviteAll) {
    while (remaining.length > 0 && !cancelled && visibleMessagesDelivered < hardMessageCeiling) {
      await record(remaining.shift()!, 1);
    }
  } else {
    while (remaining.length > 0 && !lastOutcome && !cancelled) {
      await record(remaining.shift()!);
    }
  }
  if (!lastOutcome || cancelled) return { settled: !cancelled };

  while (responseTurns < hardTurnCeiling
    && visibleMessagesDelivered < hardMessageCeiling
    && !cancelled) {
    const mention = pendingMentions.shift();
    if (mention) {
      const pair = [mention.source, mention.target].sort().join(":");
      const replyCount = pairReplies.get(pair) || 0;
      if (replyCount >= 2 || lastOutcome?.turn.agent === mention.target) continue;
      pairReplies.set(pair, replyCount + 1);
      await record({
        agent: mention.target,
        instruction: followUpInstruction(mention.source, true),
        includeDiff: mention.includeDiff,
      });
      continue;
    }

    const nextFreshCandidate = () => remaining.findIndex(({ agent }) => !invited.has(agent));
    if (secondaryAttempts < participantLimit - 1
      && (policy.participantLimit === "all" || energySpent < policy.softMessageBudget)) {
      secondaryAttempts += 1;
      if (random() <= policy.secondaryChance) {
        const index = nextFreshCandidate();
        if (index >= 0) {
          const [candidate] = remaining.splice(index, 1);
          await record({
            ...candidate,
            instruction: followUpInstruction(lastOutcome.turn.agent, false),
          });
          continue;
        }
      }
    }

    const projectedGenericCost = 1 + Math.floor(responseTurns / 2);
    const explicitlyOpen = lastOutcome.result.conversationState === "open" && visibleOutcomes.length < 2;
    if ((explicitlyOpen || (lastOutcome.result.continuationWorthy
      && energySpent + projectedGenericCost <= policy.softMessageBudget))
      && !usedContinuationSources.has(lastOutcome.key)) {
      usedContinuationSources.add(lastOutcome.key);
      const index = nextFreshCandidate();
      if (index >= 0) {
        const [candidate] = remaining.splice(index, 1);
        const continuation = await record({
          ...candidate,
          instruction: followUpInstruction(lastOutcome.turn.agent, false),
        });
        if (explicitlyOpen && !continuation.responded) usedContinuationSources.delete(lastOutcome.key);
        continue;
      }
    }
    break;
  }

  if (cancelled) return { settled: false };

  const explicitlyUnresolved = visibleOutcomes.some(({ result }) => result.conversationState === "open" || result.conversationState === "blocked");
  if (!explicitlyUnresolved) return { settled: true };
  if (visibleOutcomes.length < 2) {
    return { settled: false, pauseReason: "The discussion remains open, but no second agent took up the unresolved point in this bounded round." };
  }
  if (visibleMessagesDelivered >= hardMessageCeiling || responseTurns >= hardTurnCeiling) {
    return { settled: false, pauseReason: "The discussion reached its safety limit before the agents could synthesize an unresolved point." };
  }

  const synthesizer = lastOutcome.turn.agent;
  const synthesis = await record({
    agent: synthesizer,
    instruction: synthesisInstruction(),
    includeDiff: lastOutcome.turn.includeDiff,
  }, 1);
  if (cancelled) return { settled: false };
  if (!synthesis.responded || synthesis.result.conversationState === "settled") return { settled: true };
  if (synthesis.result.conversationState === "blocked") {
    return { settled: false, pauseReason: "The agents need human input to resolve the remaining decision." };
  }
  if (visibleMessagesDelivered >= hardMessageCeiling || responseTurns >= hardTurnCeiling) {
    return { settled: false, pauseReason: "The discussion reached its safety limit with the synthesis still open." };
  }

  const objectors = [...new Set(visibleOutcomes.map(({ turn }) => turn.agent))]
    .filter((agent) => agent !== synthesizer)
    .slice(0, MAX_OBJECTION_TURNS);
  let materialObjection = false;
  for (const agent of objectors) {
    if (cancelled || visibleMessagesDelivered >= hardMessageCeiling || responseTurns >= hardTurnCeiling) break;
    const objection = await record({ agent, instruction: objectionInstruction(synthesizer) }, 1);
    if (objection.result.conversationState === "blocked") {
      return { settled: false, pauseReason: "The agents need human input to resolve the remaining decision." };
    }
    materialObjection ||= objection.responded && objection.result.conversationState === "open";
  }
  if (!materialObjection) return { settled: true };
  if (visibleMessagesDelivered >= hardMessageCeiling || responseTurns >= hardTurnCeiling) {
    return { settled: false, pauseReason: "The discussion reached its safety limit with a material objection still open." };
  }

  const reconciliation = await record({ agent: synthesizer, instruction: reconciliationInstruction() }, 1);
  if (cancelled) return { settled: false };
  if (reconciliation.result.conversationState === "settled" || !reconciliation.responded) return { settled: true };
  return {
    settled: false,
    pauseReason: reconciliation.result.conversationState === "blocked"
      ? "The agents need human input to resolve the remaining decision."
      : "The agents still have a material disagreement after a bounded synthesis round.",
  };
}

interface CompletedTurn {
  id: number;
  turn: ConversationTurn;
  result?: TurnResult;
  error?: unknown;
}

export async function runAgentConversation(
  initialTurns: ConversationTurn[],
  maxFollowUps: number,
  performTurn: (turn: ConversationTurn) => Promise<TurnResult>,
  concurrencyLimit = 3,
) {
  const queued: ConversationTurn[] = [...initialTurns];
  const pending = new Map<number, { turn: ConversationTurn; completion: Promise<CompletedTurn> }>();
  const deferredMentions = new Map<AgentId, ConversationTurn>();
  const completedOrder = new Map<AgentId, number>();
  let followUps = 0;
  let nextId = 0;
  let completionSequence = 0;

  const startTurn = (turn: ConversationTurn) => {
    const id = nextId;
    nextId += 1;
    const completion = performTurn(turn).then(
      (result) => ({ id, turn, result }),
      (error: unknown) => ({ id, turn, error }),
    );
    pending.set(id, { turn, completion });
  };

  const fillAvailableSlots = () => {
    const limit = Math.max(1, Math.floor(concurrencyLimit));
    while (queued.length > 0 && pending.size < limit) startTurn(queued.shift()!);
  };
  const agentIsScheduled = (agent: AgentId) => queued.some((turn) => turn.agent === agent)
    || [...pending.values()].some(({ turn }) => turn.agent === agent);

  fillAvailableSlots();

  while (pending.size > 0 || queued.length > 0) {
    fillAvailableSlots();
    const completed = await Promise.race([...pending.values()].map(({ completion }) => completion));
    pending.delete(completed.id);

    if (completed.error) {
      await Promise.allSettled([...pending.values()].map(({ completion }) => completion));
      throw completed.error;
    }
    completedOrder.set(completed.turn.agent, completionSequence);
    completionSequence += 1;

    const deferredMention = deferredMentions.get(completed.turn.agent);
    if (deferredMention && followUps < maxFollowUps) {
      deferredMentions.delete(completed.turn.agent);
      queued.unshift({
        agent: completed.turn.agent,
        instruction: followUpInstruction(deferredMention.agent, true),
        includeDiff: deferredMention.includeDiff,
      });
      followUps += 1;
    }

    const mentionedAgents = completed.result?.mentionedAgents || [];
    for (const mentionedAgent of mentionedAgents) {
      if (followUps >= maxFollowUps) break;
      if (agentIsScheduled(mentionedAgent)) {
        deferredMentions.set(mentionedAgent, completed.turn);
        continue;
      }
      queued.push({
        agent: mentionedAgent,
        instruction: followUpInstruction(completed.turn.agent, true),
        includeDiff: completed.turn.includeDiff,
      });
      followUps += 1;
    }
    if (mentionedAgents.length > 0 || followUps >= maxFollowUps) continue;

    const replyCandidate = (completed.result?.replyCandidates || [])
      .filter((candidate) => !agentIsScheduled(candidate))
      .filter((candidate) => completedOrder.has(candidate))
      .sort((left, right) => completedOrder.get(left)! - completedOrder.get(right)!)[0];
    if (!replyCandidate) continue;
    queued.push({
      agent: replyCandidate,
      instruction: followUpInstruction(completed.turn.agent, false),
      includeDiff: completed.turn.includeDiff,
    });
    followUps += 1;
    fillAvailableSlots();
  }
}
