import type { AgentId, RoomState } from "./types.js";
import { stripUnsupportedEmoji } from "../shared/aim-smileys.js";
import { extractStyleDirective, type ChatStyle } from "../shared/chat-style.js";
import { CONVERSATION_ENERGY_POLICIES, type ConversationEnergy } from "../shared/conversation-energy.js";
import { isNoResponseNeeded, visibleAgentChatText } from "../shared/message-format.js";
import { AGENT_IDS, AGENT_PROFILES, agentScreenName } from "../shared/participants.js";

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
  cancelled?: boolean;
}

const NEXT_MESSAGE = /^\s*<<<NEXT>>>\s*$/gim;
const CONTINUATION_CUE = /\?|\b(?:actually|but|counterpoint|curious|disagree|however|not sure|on the other hand)\b/i;

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
    if (AGENT_IDS.includes(message.speaker as AgentId)) {
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
      return (agent === continuityAgent ? 12 : 0)
        + Math.min(4, recentEngagement) * 1.25
        + Math.min(6, quietDistance * 0.45)
        + jitter(agent) * 4;
    };
    return score(right) - score(left);
  });
}

export function roomMessageTurns(state: RoomState): ConversationTurn[] {
  return rankRoomAgents(state).map((agent) => ({
    agent,
    instruction: "Read the latest human message and current room discussion. First decide whether the message is actually directed at you or whether a side reaction from you would be natural and useful. Respond only if so; otherwise use NO_RESPONSE_NEEDED.",
  }));
}

export function parseAgentTurn(agent: AgentId, text: string, currentStyle?: ChatStyle, visibleMessageLimit = 3) {
  if (isNoResponseNeeded(text)) return { visibleMessages: [], replyCandidates: [], mentionedAgents: [], visibleMessageCount: 0, continuationWorthy: false };
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
    ...(styleUpdate ? { styleUpdate } : {}),
  };
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

export async function runEnergyConversation(
  candidates: ConversationTurn[],
  energy: ConversationEnergy,
  performTurn: (turn: ConversationTurn) => Promise<TurnResult>,
  random: () => number = Math.random,
) {
  const policy = CONVERSATION_ENERGY_POLICIES[energy];
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

  const record = async (turn: ConversationTurn): Promise<EnergyOutcome> => {
    invited.add(turn.agent);
    const result = await performTurn({
      ...turn,
      visibleMessageLimit: Math.min(3, policy.hardMessageCeiling - visibleMessagesDelivered),
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
    }
    return outcome;
  };

  while (remaining.length > 0 && !lastOutcome && !cancelled) {
    const turn = remaining.shift()!;
    await record(turn);
  }
  if (!lastOutcome || cancelled) return;

  while (responseTurns < policy.hardTurnCeiling
    && visibleMessagesDelivered < policy.hardMessageCeiling
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
    if (secondaryAttempts < policy.participantLimit - 1 && energySpent < policy.softMessageBudget) {
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
    if (lastOutcome.result.continuationWorthy
      && !usedContinuationSources.has(lastOutcome.key)
      && energySpent + projectedGenericCost <= policy.softMessageBudget) {
      usedContinuationSources.add(lastOutcome.key);
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
    break;
  }
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
) {
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

  for (const turn of initialTurns) startTurn(turn);

  while (pending.size > 0) {
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
      startTurn({
        agent: completed.turn.agent,
        instruction: followUpInstruction(deferredMention.agent, true),
        includeDiff: deferredMention.includeDiff,
      });
      followUps += 1;
    }

    const mentionedAgents = completed.result?.mentionedAgents || [];
    for (const mentionedAgent of mentionedAgents) {
      if (followUps >= maxFollowUps) break;
      const alreadyPending = [...pending.values()].some(({ turn }) => turn.agent === mentionedAgent);
      if (alreadyPending) {
        deferredMentions.set(mentionedAgent, completed.turn);
        continue;
      }
      startTurn({
        agent: mentionedAgent,
        instruction: followUpInstruction(completed.turn.agent, true),
        includeDiff: completed.turn.includeDiff,
      });
      followUps += 1;
    }
    if (mentionedAgents.length > 0 || followUps >= maxFollowUps) continue;

    const replyCandidate = (completed.result?.replyCandidates || [])
      .filter((candidate) => ![...pending.values()].some(({ turn }) => turn.agent === candidate))
      .filter((candidate) => completedOrder.has(candidate))
      .sort((left, right) => completedOrder.get(left)! - completedOrder.get(right)!)[0];
    if (!replyCandidate) continue;
    startTurn({
      agent: replyCandidate,
      instruction: followUpInstruction(completed.turn.agent, false),
      includeDiff: completed.turn.includeDiff,
    });
    followUps += 1;
  }
}
