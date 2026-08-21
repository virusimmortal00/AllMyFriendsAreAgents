import { agentScreenName, type ActiveAgentId } from "../shared/participants.js";

export type AgentFailureReason = "rate_limit" | "authentication" | "timeout" | "configuration" | "provider_error";
export type AgentHealthStatus = "cooldown" | "unavailable";

export interface AgentHealth {
  status: AgentHealthStatus;
  reason: AgentFailureReason;
  message: string;
  since: string;
  retryAt?: string;
}

interface StoredAgentHealth extends AgentHealth {
  retryAtMs?: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayMs(text: string) {
  const retryAfter = text.match(/retry[- ]after[^\d]*(\d+)\s*(seconds?|minutes?)/i);
  if (retryAfter) return Number(retryAfter[1]) * (/minute/i.test(retryAfter[2]) ? MINUTE : SECOND);
  const tryAgain = text.match(/(?:try again|resets?)[^\d]*(\d+)\s*(seconds?|minutes?)/i);
  if (tryAgain) return Number(tryAgain[1]) * (/minute/i.test(tryAgain[2]) ? MINUTE : SECOND);
  return 15 * MINUTE;
}

export function classifyAgentFailure(error: unknown, now = Date.now()): Omit<StoredAgentHealth, "since"> {
  const text = errorText(error);
  if (/not logged in|not authenticated|authentication expired|failed to authenticate|oauth session expired|unauthorized/i.test(text)) {
    return { status: "unavailable", reason: "authentication", message: "Provider login is required." };
  }
  if (/unknown model|model .*not (?:found|available)|invalid (?:model|configuration)|command not found|enoent/i.test(text)) {
    return { status: "unavailable", reason: "configuration", message: "Provider configuration needs attention." };
  }
  if (/\b429\b|rate.?limit|quota|usage limit|too many requests|capacity/i.test(text)) {
    const delay = retryDelayMs(text);
    return {
      status: "cooldown",
      reason: "rate_limit",
      message: "Provider usage limit reached.",
      retryAt: new Date(now + delay).toISOString(),
      retryAtMs: now + delay,
    };
  }
  if (/timed out|timeout|temporarily unavailable|\b502\b|\b503\b|\b504\b|connection (?:reset|refused)/i.test(text)) {
    return {
      status: "cooldown",
      reason: "timeout",
      message: "Provider request failed temporarily.",
      retryAt: new Date(now + 30 * SECOND).toISOString(),
      retryAtMs: now + 30 * SECOND,
    };
  }
  return {
    status: "cooldown",
    reason: "provider_error",
    message: "Provider request failed.",
    retryAt: new Date(now + 5 * MINUTE).toISOString(),
    retryAtMs: now + 5 * MINUTE,
  };
}

export class AgentHealthRegistry {
  private readonly states = new Map<ActiveAgentId, StoredAgentHealth>();

  canAttempt(agent: ActiveAgentId, now = Date.now()) {
    const health = this.states.get(agent);
    return !health || (health.status === "cooldown" && (health.retryAtMs || 0) <= now);
  }

  recordFailure(agent: ActiveAgentId, error: unknown, now = Date.now()) {
    const previous = this.states.get(agent);
    const classified = classifyAgentFailure(error, now);
    const health: StoredAgentHealth = { ...classified, since: previous?.since || new Date(now).toISOString() };
    this.states.set(agent, health);
    return { health: this.publicHealth(health), announce: !previous || previous.reason !== health.reason };
  }

  recordSuccess(agent: ActiveAgentId) {
    const recovered = this.states.delete(agent);
    return recovered;
  }

  snapshot() {
    return Object.fromEntries([...this.states].map(([agent, health]) => [agent, this.publicHealth(health)])) as Partial<Record<ActiveAgentId, AgentHealth>>;
  }

  failureNotice(agent: ActiveAgentId, health: AgentHealth) {
    const retry = health.retryAt
      ? ` It can be tried again after ${new Date(health.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
      : "";
    return `${agentScreenName(agent)} is unavailable: ${health.message}${retry} Other agents will keep going.`;
  }

  recoveryNotice(agent: ActiveAgentId) {
    return `${agentScreenName(agent)} is available again.`;
  }

  private publicHealth({ retryAtMs: _retryAtMs, ...health }: StoredAgentHealth): AgentHealth {
    return health;
  }
}
