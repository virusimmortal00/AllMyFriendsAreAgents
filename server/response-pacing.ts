import type { AgentId, RoomMessage } from "./types.js";

const READING_WORDS_PER_MINUTE = 475;
const TYPING_WORDS_PER_MINUTE = 80;
const MINIMUM_RESPONSE_TIME_MS = 800;
const MAXIMUM_RESPONSE_TIME_MS = 12_000;

function wordCount(text: string) {
  return text.trim().match(/\S+/g)?.length ?? 0;
}

export function messagesSinceAgentSpoke(messages: RoomMessage[], agent: AgentId) {
  let lastAgentMessage = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].speaker === agent) {
      lastAgentMessage = index;
      break;
    }
  }
  return messages
    .slice(lastAgentMessage + 1)
    .filter((message) => message.speaker !== "system" && (message.kind === "chat" || message.kind === "review" || !message.kind));
}

export function responseDelayMs(
  messages: RoomMessage[],
  agent: AgentId,
  responseText: string,
  elapsedMs: number,
) {
  const unreadWords = messagesSinceAgentSpoke(messages, agent)
    .reduce((total, message) => total + wordCount(message.text), 0);
  const readingTime = unreadWords / READING_WORDS_PER_MINUTE * 60_000;
  const typingTime = wordCount(responseText) / TYPING_WORDS_PER_MINUTE * 60_000;
  const targetTime = Math.min(
    MAXIMUM_RESPONSE_TIME_MS,
    Math.max(MINIMUM_RESPONSE_TIME_MS, readingTime + typingTime),
  );
  return Math.max(0, Math.round(targetTime - Math.max(0, elapsedMs)));
}

export function pacingStartTime(messages: RoomMessage[], agent: AgentId, fallback: number) {
  const latest = messagesSinceAgentSpoke(messages, agent).at(-1);
  if (!latest) return fallback;
  const timestamp = Date.parse(latest.timestamp);
  return Number.isFinite(timestamp) ? Math.min(timestamp, fallback) : fallback;
}

export async function paceAgentResponse(
  messages: RoomMessage[],
  agent: AgentId,
  responseText: string,
  startedAt: number,
  now = Date.now(),
) {
  const delay = responseDelayMs(messages, agent, responseText, now - startedAt);
  if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
}
