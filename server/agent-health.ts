import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isActiveAgentId, type ActiveAgentId } from "../shared/participants.js";

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

function retryDelayMs(text: string, now: number) {
  const absoluteReset = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (absoluteReset) {
    const target = new Date(now);
    let hour = Number(absoluteReset[1]) % 12;
    if (absoluteReset[3].toLowerCase() === "pm") hour += 12;
    target.setHours(hour, Number(absoluteReset[2] || 0), 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now;
  }
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
    const delay = retryDelayMs(text, now);
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
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly statePath?: string) {}

  static async open(dataDirectory?: string) {
    const registry = new AgentHealthRegistry(dataDirectory ? path.join(dataDirectory, "agent-health.json") : undefined);
    if (!registry.statePath) return registry;
    await mkdir(dataDirectory!, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await readFile(registry.statePath, "utf8")) as Record<string, StoredAgentHealth>;
      for (const [agent, health] of Object.entries(stored)) {
        if (!isActiveAgentId(agent) || !health?.status || !health.reason || !health.since) continue;
        registry.states.set(agent, {
          ...health,
          ...(health.retryAt ? { retryAtMs: new Date(health.retryAt).getTime() } : {}),
        });
      }
      await chmod(registry.statePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return registry;
  }

  static memory() {
    return new AgentHealthRegistry();
  }

  private isCurrent(health: StoredAgentHealth, now: number) {
    return health.status !== "cooldown" || (health.retryAtMs || 0) > now;
  }

  canAttempt(agent: ActiveAgentId, now = Date.now()) {
    const health = this.states.get(agent);
    return !health || !this.isCurrent(health, now);
  }

  async recordFailure(agent: ActiveAgentId, error: unknown, now = Date.now()) {
    const stored = this.states.get(agent);
    const previous = stored && this.isCurrent(stored, now) ? stored : undefined;
    const classified = classifyAgentFailure(error, now);
    const health: StoredAgentHealth = { ...classified, since: previous?.since || new Date(now).toISOString() };
    this.states.set(agent, health);
    await this.save(now);
    return this.publicHealth(health);
  }

  async recordSuccess(agent: ActiveAgentId) {
    const recovered = this.states.delete(agent);
    if (recovered) await this.save();
    return recovered;
  }

  snapshot(now = Date.now()) {
    return Object.fromEntries([...this.states]
      .filter(([, health]) => this.isCurrent(health, now))
      .map(([agent, health]) => [agent, this.publicHealth(health)])) as Partial<Record<ActiveAgentId, AgentHealth>>;
  }

  private publicHealth({ retryAtMs: _retryAtMs, ...health }: StoredAgentHealth): AgentHealth {
    return health;
  }

  private async save(now = Date.now()) {
    if (!this.statePath) return;
    const operation = this.saveQueue.then(async () => {
      const temporaryPath = `${this.statePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.snapshot(now), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.statePath!);
      await chmod(this.statePath!, 0o600);
    });
    this.saveQueue = operation.catch(() => undefined);
    await operation;
  }
}
