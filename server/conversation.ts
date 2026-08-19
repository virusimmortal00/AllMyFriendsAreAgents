import type { AgentId } from "./types.js";
import { stripUnsupportedEmoji } from "../shared/aim-smileys.js";
import { extractStyleDirective, type ChatStyle } from "../shared/chat-style.js";
import { isNoResponseNeeded, visibleAgentChatText } from "../shared/message-format.js";
import { AGENT_IDS, AGENT_PROFILES, agentScreenName } from "../shared/participants.js";

export interface ConversationTurn {
  agent: AgentId;
  instruction: string;
  includeDiff?: boolean;
}

export interface TurnResult {
  replyCandidates?: AgentId[];
  mentionedAgents?: AgentId[];
}

const NEXT_MESSAGE = /^\s*<<<NEXT>>>\s*$/gim;

export function roomMessageTurns(): ConversationTurn[] {
  return AGENT_IDS.map((agent) => ({
    agent,
    instruction: "Read the latest human message and current room discussion. First decide whether the message is actually directed at you or whether a side reaction from you would be natural and useful. Respond only if so; otherwise use NO_RESPONSE_NEEDED.",
  }));
}

export function parseAgentTurn(agent: AgentId, text: string, currentStyle?: ChatStyle) {
  if (isNoResponseNeeded(text)) return { visibleMessages: [], replyCandidates: [], mentionedAgents: [] };
  const visibleMessages = visibleAgentChatText(text)
    .split(NEXT_MESSAGE)
    .map(stripUnsupportedEmoji)
    .filter((message) => message && message !== "NO_RESPONSE_NEEDED")
    .slice(0, 3);
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
    ...(styleUpdate ? { styleUpdate } : {}),
  };
}

function followUpInstruction(sourceAgent: AgentId, directlyMentioned: boolean) {
  const sourceName = agentScreenName(sourceAgent);
  const mentionContext = directlyMentioned ? " They addressed you directly." : "";
  return `${sourceName} just added a message to the room.${mentionContext} Read it in the latest transcript and respond conversationally if you can add something useful, answer a question, react naturally, resolve a disagreement, or move the discussion forward. A brief reaction is welcome. If a response would only repeat agreement or add noise, reply exactly NO_RESPONSE_NEEDED.`;
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
