import type { AgentId } from "./types.js";
import { stripUnsupportedEmoji } from "../shared/aim-smileys.js";
import { extractStyleDirective, type ChatStyle } from "../shared/chat-style.js";
import { isNoResponseNeeded, visibleAgentText } from "../shared/message-format.js";

export interface ConversationTurn {
  agent: AgentId;
  instruction: string;
  includeDiff?: boolean;
}

export interface TurnResult {
  replyCandidate?: AgentId;
  mentionedAgent?: AgentId;
}

const NEXT_MESSAGE = /^\s*<<<NEXT>>>\s*$/gim;

export function roomMessageTurns(): ConversationTurn[] {
  return (["codex", "claude"] as const).map((agent) => ({
    agent,
    instruction: "Respond to the latest human message and the current room discussion.",
  }));
}

export function parseAgentTurn(agent: AgentId, text: string, currentStyle?: ChatStyle) {
  if (isNoResponseNeeded(text)) return { visibleMessages: [], replyCandidate: undefined, mentionedAgent: undefined };
  const visibleMessages = visibleAgentText(text)
    .split(NEXT_MESSAGE)
    .map(stripUnsupportedEmoji)
    .filter((message) => message && message !== "NO_RESPONSE_NEEDED")
    .slice(0, 3);
  const combinedText = visibleMessages.join("\n");
  const otherAgent: AgentId = agent === "codex" ? "claude" : "codex";
  const mentionPattern = otherAgent === "claude" ? /\bClaude(?: Code)?\b/i : /\bCodex\b/i;
  const styleUpdate = currentStyle ? extractStyleDirective(text, currentStyle) : undefined;
  return {
    visibleMessages,
    replyCandidate: visibleMessages.length > 0 ? otherAgent : undefined,
    mentionedAgent: mentionPattern.test(combinedText) ? otherAgent : undefined,
    ...(styleUpdate ? { styleUpdate } : {}),
  };
}

function followUpInstruction(sourceAgent: AgentId, directlyMentioned: boolean) {
  const sourceName = sourceAgent === "codex" ? "Codex" : "Claude";
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
  let followUps = 0;
  let nextId = 0;

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

    const replyCandidate = completed.result?.replyCandidate || completed.result?.mentionedAgent;
    if (!replyCandidate || followUps >= maxFollowUps) continue;

    const alreadyPending = [...pending.values()].some(({ turn }) => turn.agent === replyCandidate);
    if (alreadyPending) {
      if (completed.result?.mentionedAgent === replyCandidate) deferredMentions.set(replyCandidate, completed.turn);
      continue;
    }

    startTurn({
      agent: replyCandidate,
      instruction: followUpInstruction(completed.turn.agent, completed.result?.mentionedAgent === replyCandidate),
      includeDiff: completed.turn.includeDiff,
    });
    followUps += 1;
  }
}
