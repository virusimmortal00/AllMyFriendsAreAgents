import { randomUUID } from "node:crypto";
import { DEFAULT_PARTICIPANT_STYLES, sanitizeChatStyle, type ChatStyle } from "../shared/chat-style.js";
import type { HumanPresence } from "./types.js";
import { validHumanAvatarDataUrl } from "../shared/human-avatar.js";

const HUMAN_NAME_LIMIT = 32;
export const HUMAN_DEPARTURE_GRACE_MS = 7_000;
export type HumanPresenceEvent = "joined" | "left";

type PresenceHuman = Pick<HumanPresence, "id" | "name">;

export class HumanPresenceAnnouncements {
  private readonly pendingDepartures = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly announce: (human: PresenceHuman, event: HumanPresenceEvent) => Promise<void>,
    private readonly graceMs = HUMAN_DEPARTURE_GRACE_MS,
    private readonly onError: (error: unknown, event: HumanPresenceEvent) => void = (error, event) => {
      console.error(`Failed to announce room ${event === "joined" ? "arrival" : "departure"}`, error);
    },
  ) {}

  arrival(human: PresenceHuman, becamePresent: boolean) {
    if (!becamePresent || this.closed) return false;
    const departure = this.pendingDepartures.get(human.id);
    if (departure) {
      clearTimeout(departure);
      this.pendingDepartures.delete(human.id);
      return true;
    }
    this.deliver(human, "joined");
    return false;
  }

  departure(human: PresenceHuman, becameAbsent: boolean) {
    if (!becameAbsent || this.closed || this.pendingDepartures.has(human.id)) return;
    const timer = setTimeout(() => {
      this.pendingDepartures.delete(human.id);
      if (!this.closed) this.deliver(human, "left");
    }, this.graceMs);
    timer.unref();
    this.pendingDepartures.set(human.id, timer);
  }

  shutdown() {
    this.closed = true;
    for (const timer of this.pendingDepartures.values()) clearTimeout(timer);
    const cancelled = this.pendingDepartures.size;
    this.pendingDepartures.clear();
    return cancelled;
  }

  private deliver(human: PresenceHuman, event: HumanPresenceEvent) {
    void this.announce(human, event).catch((error) => this.onError(error, event));
  }
}

export function humanPresenceAnnouncement(name: string, event: HumanPresenceEvent) {
  return `${name} has ${event} the chat`;
}

export function humanPresenceInstruction(name: string, event: HumanPresenceEvent) {
  return event === "joined"
    ? `The system just announced that ${name} joined the chat. This is an optional chance to greet them naturally. Respond only if you genuinely want to add a brief welcome; otherwise yield with the appropriate TURN_DISPOSITION reason.`
    : `The system just announced that ${name} left the chat. This is an optional chance for a brief natural reaction. Do not address them as if they are still present. Respond only if it adds something; otherwise yield with the appropriate TURN_DISPOSITION reason.`;
}

function cleanName(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, HUMAN_NAME_LIMIT) : "";
}

export class HumanPresenceRegistry {
  private readonly humans = new Map<string, HumanPresence>();
  private readonly connectionCounts = new Map<string, number>();

  join(input: { name?: unknown; style?: unknown; avatarUrl?: unknown }, resumeId?: unknown) {
    const name = cleanName(input.name);
    if (!name) throw new Error("Your name is required.");
    const requestedId = typeof resumeId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(resumeId) ? resumeId : undefined;
    const id = requestedId || randomUUID();
    const existing = this.humans.get(id);
    const avatarUrl = validHumanAvatarDataUrl(input.avatarUrl) ? input.avatarUrl : undefined;
    const removeAvatar = input.avatarUrl === null || input.avatarUrl === "";
    const human: HumanPresence = {
      id,
      name,
      style: sanitizeChatStyle(input.style, existing?.style || DEFAULT_PARTICIPANT_STYLES.you),
      ...(avatarUrl ? { avatarUrl } : !removeAvatar && existing?.avatarUrl ? { avatarUrl: existing.avatarUrl } : {}),
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

  updateAvatar(id: unknown, avatarUrl: string | undefined) {
    if (typeof id !== "string") return undefined;
    const human = this.humans.get(id);
    if (!human) return undefined;
    if (avatarUrl) human.avatarUrl = avatarUrl;
    else delete human.avatarUrl;
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
