import { randomUUID } from "node:crypto";
import { DEFAULT_PARTICIPANT_STYLES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style.js";
import type { HumanPresence } from "./types.js";

const HUMAN_NAME_LIMIT = 32;
export type HumanPresenceEvent = "joined" | "left";

export function humanPresenceAnnouncement(name: string, event: HumanPresenceEvent) {
  return `${name} has ${event} the chat`;
}

export function humanPresenceInstruction(name: string, event: HumanPresenceEvent) {
  return event === "joined"
    ? `The system just announced that ${name} joined the chat. This is an optional chance to greet them naturally. Respond only if you genuinely want to add a brief welcome; otherwise reply exactly NO_RESPONSE_NEEDED.`
    : `The system just announced that ${name} left the chat. This is an optional chance for a brief natural reaction. Do not address them as if they are still present. Respond only if it adds something; otherwise reply exactly NO_RESPONSE_NEEDED.`;
}

function cleanName(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, HUMAN_NAME_LIMIT) : "";
}

export class HumanPresenceRegistry {
  private readonly humans = new Map<string, HumanPresence>();
  private readonly connectionCounts = new Map<string, number>();

  join(input: { name?: unknown; style?: unknown }, resumeId?: unknown) {
    const name = cleanName(input.name);
    if (!name) throw new Error("Your name is required.");
    const requestedId = typeof resumeId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(resumeId) ? resumeId : undefined;
    const id = requestedId || randomUUID();
    const existing = this.humans.get(id);
    const human: HumanPresence = {
      id,
      name,
      style: sanitizeChatStyle(input.style, existing?.style || DEFAULT_PARTICIPANT_STYLES.you),
    };
    this.humans.set(id, human);
    return structuredClone(human);
  }

  get(id: unknown) {
    if (typeof id !== "string") return undefined;
    const human = this.humans.get(id);
    return human ? structuredClone(human) : undefined;
  }

  updateStyle(id: unknown, style: unknown) {
    if (typeof id !== "string") return undefined;
    const human = this.humans.get(id);
    if (!human) return undefined;
    human.style = sanitizeChatStyle(style, human.style);
    return structuredClone(human);
  }

  connect(id: unknown) {
    if (typeof id !== "string") return undefined;
    const human = this.humans.get(id);
    if (!human) return undefined;
    const previousCount = this.connectionCounts.get(id) || 0;
    this.connectionCounts.set(id, previousCount + 1);
    return { human: structuredClone(human), becamePresent: previousCount === 0 };
  }

  disconnect(id: unknown) {
    if (typeof id !== "string") return undefined;
    const human = this.humans.get(id);
    const previousCount = this.connectionCounts.get(id) || 0;
    if (!human || previousCount === 0) return undefined;
    const next = previousCount - 1;
    if (next === 0) this.connectionCounts.delete(id);
    else this.connectionCounts.set(id, next);
    return { human: structuredClone(human), becameAbsent: next === 0 };
  }

  list() {
    return [...this.humans.values()]
      .filter(({ id }) => (this.connectionCounts.get(id) || 0) > 0)
      .map((human) => structuredClone(human));
  }
}
