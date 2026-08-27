import { visibleAgentChatText, visibleAgentText } from "../shared/message-format.js";
import { AGENT_PROFILES, isAgentId } from "../shared/participants.js";
import type { RoomMessage, RoomState } from "./types.js";
import { isVisibleRoomMessage } from "./message-visibility.js";
import { normalizeAgentContextConfig } from "./agent-context-config.js";
import { agentContextConfigFor, normalizeRoomConfiguration } from "./room-configuration.js";
import { normalizeRoomAgentRoster } from "../shared/roster.js";
import type { AgentId } from "./types.js";

export const TRANSCRIPT_CHARACTER_BUDGET = 12_000;
export const SUMMARY_FOREGROUND_WAIT_MS = 750;
export const MAX_VERBATIM_SUMMARY_FALLBACK_CHARACTERS = 48_000;

interface TranscriptEntry {
  id?: string;
  speaker: RoomMessage["speaker"];
  speakerName?: string;
  text: string;
  burstId?: string;
}

function entriesFor(messages: RoomMessage[], includeIds = false) {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (!isVisibleRoomMessage(message)) continue;
    const text = isAgentId(message.speaker)
      ? visibleAgentChatText(message.text)
      : visibleAgentText(message.text);
    if (!text) continue;
    const previous = entries.at(-1);
    if (!includeIds && message.burstId && previous?.speaker === message.speaker && previous.burstId === message.burstId) {
      previous.text += `\n${text}`;
    } else {
      entries.push({ ...(includeIds ? { id: message.id } : {}), speaker: message.speaker, speakerName: message.speakerName, text, burstId: message.burstId });
    }
  }
  return entries;
}

function formatEntry(entry: TranscriptEntry, text = entry.text) {
  const speaker = isAgentId(entry.speaker)
    ? (entry.speakerName || AGENT_PROFILES[entry.speaker]?.conversationalName || entry.speaker).toUpperCase()
    : (entry.speakerName || entry.speaker).toUpperCase();
  return `[${speaker}${entry.id ? ` | ${entry.id}` : ""}]\n${text}`;
}

export interface AgentContextSummaryKey {
  readonly agentId: AgentId;
  readonly spanStartId: string;
  readonly spanEndId: string;
  readonly configRevision: number;
}

export interface AgentContextSummaryStore {
  getAgentContextSummary(key: AgentContextSummaryKey): Promise<string | undefined>;
  putAgentContextSummary(key: AgentContextSummaryKey, summary: string): Promise<void>;
}

export interface AgentContextSummarizer {
  summarize(input: { readonly transcript: string; readonly tokenTarget: number; readonly promptTemplate: string; readonly projectPath: string; readonly models: ReturnType<typeof normalizeAgentContextConfig>["summarizerModels"]; readonly configRevision?: number }): Promise<string>;
}

export interface AgentScopedTranscriptOptions {
  readonly agentId: AgentId;
  readonly summaryStore?: AgentContextSummaryStore;
  readonly summarizer?: AgentContextSummarizer;
  readonly activeAssignment?: string;
}

export interface AgentScopedTranscript {
  readonly text: string;
  readonly cursorMessageId?: string;
  readonly mode: "delta" | "summary" | "verbatim-fallback";
}

function visibleMessages(messages: RoomMessage[]) {
  return messages.filter((message) => !message.recipientHumanId && entriesFor([message], true).length > 0);
}

function transcriptMessages(messages: RoomMessage[]) {
  return entriesFor(messages.filter((message) => !message.recipientHumanId), true).map((entry) => formatEntry(entry)).join("\n\n");
}

function pinnedState(state: RoomState, options: AgentScopedTranscriptOptions) {
  const roster = normalizeRoomAgentRoster(state.roster);
  const roomConfiguration = normalizeRoomConfiguration(state.roomConfiguration);
  const roomFlags = Object.entries(roomConfiguration.featureFlags).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(", ");
  const rosterLine = roster.entries.map((entry) => `${entry.conversationalName || entry.agentId}=${entry.enabled ? "enabled" : "disabled"}`).join(", ") || "(empty)";
  return `PINNED ROOM STATE
Room: ${state.settings.roomName}
Topic: ${state.settings.topic}
Room status: ${state.status}${state.activeAgent ? `; active=${state.activeAgent}` : ""}
Roster revision: ${roster.revision}
Roster: ${rosterLine}
Active task/assignment: ${options.activeAssignment || "none"}
Round-robin cursor: ${state.activeAgent || "none"}
Conversation energy: ${state.settings.conversationEnergy}
Pre-flight routing: ${roomConfiguration.preflightMode}
Project writes: ${state.settings.writableAgent === "nobody" ? "governed-only" : state.settings.writableAgent}
Config flags: ${roomFlags || "none"}; deployment=${state.deployment ? "available" : "unavailable"}; context=per-agent-delta`;
}

async function agentScopedTranscriptFor(state: RoomState, options: AgentScopedTranscriptOptions): Promise<AgentScopedTranscript> {
  const config = state.roomConfiguration ? agentContextConfigFor(state.roomConfiguration) : normalizeAgentContextConfig(undefined);
  const configRevision = normalizeRoomConfiguration(state.roomConfiguration).configurationRevision;
  const roster = normalizeRoomAgentRoster(state.roster);
  const cursor = roster.entries.find((entry) => entry.agentId === options.agentId)?.lastSeenMessageId ?? null;
  // Cursors normally sit near the tail, so reverse lookup keeps steady-state work proportional to the delta.
  const cursorIndex = cursor ? state.messages.findLastIndex((message) => message.id === cursor) : -1;
  const coldStart = !cursor || cursorIndex < 0;
  const candidateStart = coldStart ? Math.max(0, state.messages.findLastIndex((message) => message.kind === "topic")) : cursorIndex + 1;
  const candidate = visibleMessages(state.messages.slice(candidateStart));
  const latestMessageId = state.messages.at(-1)?.id;
  const pinned = pinnedState(state, options);
  const historyNote = "Older verbatim room history is available with the room_history tool using a message ID and limit.";
  if (!coldStart && candidate.length <= config.maxDeltaMessages) {
    const delta = transcriptMessages(candidate) || "(No new visible room messages.)";
    return { text: `${pinned}\n\nROOM MESSAGE DELTA\n${delta}\n\n${historyNote}`, cursorMessageId: latestMessageId || cursor, mode: "delta" };
  }

  const recent = candidate.slice(-config.recentMessageCount);
  const older = candidate.slice(0, -config.recentMessageCount);
  if (!older.length) {
    return { text: `${pinned}\n\nRECENT ROOM MESSAGES (VERBATIM)\n${transcriptMessages(recent) || "(No visible room messages.)"}\n\n${historyNote}`, cursorMessageId: latestMessageId, mode: "summary" };
  }

  const candidateTranscript = transcriptMessages(candidate);
  const fullFallback = () => ({
    text: `${pinned}\n\nROOM MESSAGES (VERBATIM SUMMARY FALLBACK)\n${candidateTranscript}\n\n${historyNote}`,
    cursorMessageId: latestMessageId,
    mode: "verbatim-fallback" as const,
  });
  const boundedFallback = (status: "pending" | "unavailable") => ({
    text: `${pinned}\n\nSUMMARY ${status.toUpperCase()} (${older[0].id} through ${older.at(-1)!.id}; ${older.length} older messages)\nThe configured navigational summary is ${status === "pending" ? "still being prepared without blocking this turn" : "temporarily unavailable"}. Retrieve exact older text with room_history.\n\nRECENT ROOM MESSAGES (VERBATIM)\n${transcriptMessages(recent)}\n\n${historyNote}`,
    cursorMessageId: latestMessageId,
    mode: "summary" as const,
  });
  if (!options.summarizer || !options.summaryStore) return candidateTranscript.length <= MAX_VERBATIM_SUMMARY_FALLBACK_CHARACTERS ? fullFallback() : boundedFallback("unavailable");
  const key = { agentId: options.agentId, spanStartId: older[0].id, spanEndId: older.at(-1)!.id, configRevision };
  try {
    let summary = await options.summaryStore.getAgentContextSummary(key);
    if (!summary) {
      const pending = options.summarizer.summarize({
        transcript: transcriptMessages(older),
        tokenTarget: config.summaryTokenTarget,
        promptTemplate: config.summaryPromptTemplate,
        projectPath: state.settings.projectPath,
        models: config.summarizerModels,
        configRevision,
      });
      const outcome = await foregroundSummary(pending);
      if (outcome.kind === "pending") {
        void pending.then(async (generated) => {
          const bounded = generated.trim().slice(0, config.summaryTokenTarget * 5);
          if (bounded) await options.summaryStore!.putAgentContextSummary(key, bounded);
        }).catch(async () => {
          await options.summaryStore!.putAgentContextSummary(key, unavailableSummary(key, older.length)).catch(() => undefined);
        });
        return boundedFallback("pending");
      }
      if (outcome.kind === "failed") {
        if (candidateTranscript.length <= MAX_VERBATIM_SUMMARY_FALLBACK_CHARACTERS) return fullFallback();
        summary = unavailableSummary(key, older.length);
      } else {
        summary = outcome.summary.trim().slice(0, config.summaryTokenTarget * 5);
        if (!summary) return candidateTranscript.length <= MAX_VERBATIM_SUMMARY_FALLBACK_CHARACTERS ? fullFallback() : boundedFallback("unavailable");
      }
      await options.summaryStore.putAgentContextSummary(key, summary);
    }
    return {
      text: `${pinned}\n\nCACHED SUMMARY (${key.spanStartId} through ${key.spanEndId}; cache only, not source of truth)\n${summary}\n\nRECENT ROOM MESSAGES (VERBATIM)\n${transcriptMessages(recent)}\n\n${historyNote}`,
      cursorMessageId: latestMessageId,
      mode: "summary",
    };
  } catch {
    return candidateTranscript.length <= MAX_VERBATIM_SUMMARY_FALLBACK_CHARACTERS ? fullFallback() : boundedFallback("unavailable");
  }
}

function unavailableSummary(key: AgentContextSummaryKey, messageCount: number) {
  return `Summary generation was unavailable for ${messageCount} older messages (${key.spanStartId} through ${key.spanEndId}). Use room_history for exact text.`;
}

async function foregroundSummary(pending: Promise<string>): Promise<{ kind: "completed"; summary: string } | { kind: "failed" } | { kind: "pending" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "pending" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "pending" }), SUMMARY_FOREGROUND_WAIT_MS); });
  const result = await Promise.race([
    pending.then((summary) => ({ kind: "completed" as const, summary }), () => ({ kind: "failed" as const })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

export function transcriptFor(state: RoomState, characterBudget?: number): string;
export function transcriptFor(state: RoomState, options: AgentScopedTranscriptOptions): Promise<AgentScopedTranscript>;
export function transcriptFor(state: RoomState, input: number | AgentScopedTranscriptOptions = TRANSCRIPT_CHARACTER_BUDGET): string | Promise<AgentScopedTranscript> {
  if (typeof input === "object") return agentScopedTranscriptFor(state, input);
  const characterBudget = input;
  let topicStart = 0;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index].kind === "topic") {
      topicStart = index;
      break;
    }
  }

  const entries = entriesFor(state.messages.slice(topicStart).filter((message) => !message.recipientHumanId));
  const selected: string[] = [];
  let remaining = Math.max(0, characterBudget);
  for (let index = entries.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const entry = entries[index];
    const block = formatEntry(entry);
    const separatorLength = selected.length > 0 ? 2 : 0;
    if (block.length + separatorLength <= remaining) {
      selected.unshift(block);
      remaining -= block.length + separatorLength;
      continue;
    }
    if (selected.length > 0) break;
    const prefix = formatEntry(entry, "");
    if (remaining <= prefix.length + 1) {
      selected.unshift(prefix.slice(0, remaining));
    } else {
      const availableText = remaining - prefix.length - 1;
      selected.unshift(formatEntry(entry, `…${entry.text.slice(-availableText)}`));
    }
    remaining = 0;
  }
  return selected.join("\n\n");
}
