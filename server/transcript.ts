import { visibleAgentChatText, visibleAgentText } from "../shared/message-format.js";
import type { RoomMessage, RoomState } from "./types.js";

export const TRANSCRIPT_CHARACTER_BUDGET = 12_000;

interface TranscriptEntry {
  speaker: RoomMessage["speaker"];
  text: string;
  burstId?: string;
}

function entriesFor(messages: RoomMessage[]) {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    const text = message.speaker === "codex" || message.speaker === "claude"
      ? visibleAgentChatText(message.text)
      : visibleAgentText(message.text);
    if (!text) continue;
    const previous = entries.at(-1);
    if (message.burstId && previous?.speaker === message.speaker && previous.burstId === message.burstId) {
      previous.text += `\n${text}`;
    } else {
      entries.push({ speaker: message.speaker, text, burstId: message.burstId });
    }
  }
  return entries;
}

function formatEntry(entry: TranscriptEntry, text = entry.text) {
  return `[${entry.speaker.toUpperCase()}]\n${text}`;
}

export function transcriptFor(state: RoomState, characterBudget = TRANSCRIPT_CHARACTER_BUDGET) {
  let topicStart = 0;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index].kind === "topic") {
      topicStart = index;
      break;
    }
  }

  const entries = entriesFor(state.messages.slice(topicStart));
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
