import type { AgentId } from "./types.js";
import { isNoResponseNeeded, visibleAgentText } from "../shared/message-format.js";

export interface ConversationTurn {
  agent: AgentId;
  instruction: string;
  includeDiff?: boolean;
}

export interface TurnResult {
  mentionedAgent?: AgentId;
}

export function parseAgentTurn(agent: AgentId, text: string) {
  if (isNoResponseNeeded(text)) return { visibleText: "", mentionedAgent: undefined };
  const visibleText = visibleAgentText(text);
  const otherAgent: AgentId = agent === "codex" ? "claude" : "codex";
  const mentionPattern = otherAgent === "claude" ? /\bClaude(?: Code)?\b/i : /\bCodex\b/i;
  return {
    visibleText,
    mentionedAgent: mentionPattern.test(visibleText) ? otherAgent : undefined,
  };
}

function followUpInstruction(sourceAgent: AgentId) {
  const sourceName = sourceAgent === "codex" ? "Codex" : "Claude";
  return `${sourceName} mentioned you in their latest message. Respond conversationally if you can add something useful, answer a question, resolve a disagreement, or move the work forward. If a response would only repeat agreement or add noise, reply exactly NO_RESPONSE_NEEDED.`;
}

export async function runMentionConversation(
  initialTurns: ConversationTurn[],
  maxFollowUps: number,
  performTurn: (turn: ConversationTurn) => Promise<TurnResult>,
) {
  const queue = [...initialTurns];
  let followUps = 0;

  for (let index = 0; index < queue.length; index += 1) {
    const turn = queue[index];
    const result = await performTurn(turn);
    if (!result.mentionedAgent || followUps >= maxFollowUps) continue;

    const alreadyPending = queue.slice(index + 1).some((pending) => pending.agent === result.mentionedAgent);
    if (alreadyPending) continue;

    queue.push({
      agent: result.mentionedAgent,
      instruction: followUpInstruction(turn.agent),
      includeDiff: turn.includeDiff,
    });
    followUps += 1;
  }
}
