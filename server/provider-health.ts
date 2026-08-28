import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validDiscoveryId } from "../shared/model-discovery.js";
import { providerDisplayName } from "../shared/model-presentation.js";
import { isProviderInvocationError } from "./provider-failure.js";

export type ProviderActionRequiredReason = "usage_exhausted" | "usage_not_included";
export type ProviderCooldownReason = "account_rate_limit";
export type ProviderHealthReason = ProviderActionRequiredReason | ProviderCooldownReason;

interface ProviderHealthBase {
  message: string;
  since: string;
}

export type ProviderHealth = ProviderHealthBase & ({
  status: "action_required";
  reason: ProviderActionRequiredReason;
} | {
  status: "cooldown";
  reason: ProviderCooldownReason;
  retryAt: string;
  retrySource: "provider" | "policy";
});

type StoredProviderHealth = {
  status: "action_required";
  reason: ProviderActionRequiredReason;
  since: string;
} | {
  status: "cooldown";
  reason: ProviderCooldownReason;
  since: string;
  retryAt: string;
  retrySource: "provider" | "policy";
};

interface PersistedProviderHealth {
  schemaVersion: 1 | 2;
  providers: Record<string, StoredProviderHealth>;
}

type RecoveryState = "blocked" | "available" | "claimed";
export type ProviderAttempt = "regular" | "recovery" | "blocked";

export function providerActionRequiredReason(error: unknown, providerId: string): ProviderActionRequiredReason | undefined {
  if (!isProviderInvocationError(error)) return undefined;
  if (error.failure.code === "insufficient_quota" || error.failure.code === "free_tier_limit") return "usage_exhausted";
  if (error.failure.code === "usage_not_included") return "usage_not_included";

  // Cursor's observed response has no stable machine code. Keep this fallback
  // literal and structured-error-only so generic quota/rate-limit prose cannot
  // widen an account-scoped outage.
  const message = error.failure.message.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");
  return providerId === "cursor"
    && message.includes("you're out of usage")
    && message.includes("switch to auto")
    && message.includes("increase your limit")
    ? "usage_exhausted"
    : undefined;
}

export type ProviderScopedFailure = {
  status: "action_required";
  reason: ProviderActionRequiredReason;
} | {
  status: "cooldown";
  reason: ProviderCooldownReason;
  retryAt: string;
  retrySource: "provider" | "policy";
};

export function classifyProviderScopedFailure(error: unknown, providerId: string, now = Date.now()): ProviderScopedFailure | undefined {
  const actionRequired = providerActionRequiredReason(error, providerId);
  if (actionRequired) return { status: "action_required", reason: actionRequired };
  if (!isProviderInvocationError(error) || error.failure.code !== "account_rate_limit") return undefined;
  const delay = error.failure.retryAfterMs ?? 60_000;
  return {
    status: "cooldown",
    reason: "account_rate_limit",
    retryAt: new Date(now + delay).toISOString(),
    retrySource: error.failure.retryAfterMs === undefined ? "policy" : "provider",
  };
}

export function isProviderUsageExhaustion(error: unknown, providerId: string) {
  return providerActionRequiredReason(error, providerId) === "usage_exhausted";
}

function sanitizedMessage(providerId: string, reason: ProviderHealthReason) {
  const provider = providerDisplayName(providerId);
  if (reason === "usage_exhausted") {
    return `${provider} usage is exhausted; increase the limit or change provider mode.`;
  }
  return reason === "usage_not_included"
    ? `${provider} usage is not included; change provider mode or update the plan.`
    : `${provider} is temporarily rate limited.`;
}

function isStoredHealth(value: unknown): value is StoredProviderHealth {
  if (!value || typeof value !== "object") return false;
  const health = value as { status?: unknown; reason?: unknown; since?: unknown; retryAt?: unknown; retrySource?: unknown };
  if (typeof health.since !== "string" || !Number.isFinite(Date.parse(health.since))) return false;
  if (health.status === "action_required") return health.reason === "usage_exhausted" || health.reason === "usage_not_included";
  return health.status === "cooldown"
    && health.reason === "account_rate_limit"
    && typeof health.retryAt === "string"
    && Number.isFinite(Date.parse(health.retryAt))
    && (health.retrySource === "provider" || health.retrySource === "policy");
}

export class ProviderHealthRegistry {
  private readonly states = new Map<string, StoredProviderHealth>();
  private readonly recovery = new Map<string, RecoveryState>();
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly statePath?: string) {}

  static async open(dataDirectory?: string) {
    const registry = new ProviderHealthRegistry(dataDirectory ? path.join(dataDirectory, "provider-health.json") : undefined);
    if (!registry.statePath) return registry;
    await mkdir(dataDirectory!, { recursive: true, mode: 0o700 });
    let serialized: string;
    try {
      serialized = await readFile(registry.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return registry;
    }
    let stored: Partial<PersistedProviderHealth>;
    try {
      stored = JSON.parse(serialized) as Partial<PersistedProviderHealth>;
    } catch (error) {
      if (error instanceof SyntaxError) return registry;
      throw error;
    }
    if ((stored.schemaVersion === 1 || stored.schemaVersion === 2) && stored.providers && typeof stored.providers === "object") {
      for (const [providerId, health] of Object.entries(stored.providers)) {
        if (!validDiscoveryId(providerId) || !isStoredHealth(health)) continue;
        registry.states.set(providerId, health);
        if (health.status === "action_required") registry.recovery.set(providerId, "blocked");
      }
    }
    try {
      await chmod(registry.statePath, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EROFS") throw error;
      registry.states.clear();
      registry.recovery.clear();
    }
    return registry;
  }

  static memory() {
    return new ProviderHealthRegistry();
  }

  canAttempt(providerId: string, now = Date.now()) {
    const health = this.states.get(providerId);
    if (!health || (health.status === "cooldown" && Date.parse(health.retryAt) <= now)) return true;
    return health.status === "action_required" && this.recovery.get(providerId) === "available";
  }

  claimAttempt(providerId: string, now = Date.now()): ProviderAttempt {
    const health = this.states.get(providerId);
    if (!health || (health.status === "cooldown" && Date.parse(health.retryAt) <= now)) return "regular";
    if (health.status === "cooldown") return "blocked";
    if (this.recovery.get(providerId) !== "available") return "blocked";
    this.recovery.set(providerId, "claimed");
    return "recovery";
  }

  async requestRecovery(providerId: string) {
    if (this.states.get(providerId)?.status !== "action_required") return false;
    if (this.recovery.get(providerId) === "claimed") return false;
    this.recovery.set(providerId, "available");
    return true;
  }

  async recordActionRequired(providerId: string, reason: ProviderActionRequiredReason, now = Date.now()) {
    const previous = this.states.get(providerId);
    this.states.set(providerId, {
      status: "action_required",
      reason,
      since: previous?.status === "action_required" && previous.reason === reason ? previous.since : new Date(now).toISOString(),
    });
    this.recovery.set(providerId, "blocked");
    await this.save();
    return this.publicHealth(providerId, this.states.get(providerId)!);
  }

  async recordCooldown(providerId: string, failure: Extract<ProviderScopedFailure, { status: "cooldown" }>, now = Date.now()) {
    const previous = this.states.get(providerId);
    this.states.set(providerId, {
      ...failure,
      since: previous?.status === "cooldown" && previous.reason === failure.reason ? previous.since : new Date(now).toISOString(),
    });
    this.recovery.delete(providerId);
    await this.save();
    return this.publicHealth(providerId, this.states.get(providerId)!);
  }

  recordRecoveryFailure(providerId: string) {
    if (this.states.get(providerId)?.status === "action_required") this.recovery.set(providerId, "blocked");
  }

  async recordSuccess(providerId: string) {
    const recovered = this.states.delete(providerId);
    this.recovery.delete(providerId);
    if (recovered) await this.save();
    return recovered;
  }

  hasActionRequired(providerId: string) {
    return this.states.get(providerId)?.status === "action_required";
  }

  nextRetryAt(now = Date.now()) {
    const retryTimes = [...this.states.values()].flatMap((health) => {
      if (health.status !== "cooldown") return [];
      const retryAt = Date.parse(health.retryAt);
      return retryAt > now ? [retryAt] : [];
    });
    return retryTimes.length ? Math.min(...retryTimes) : undefined;
  }

  async expire(now = Date.now()) {
    let changed = false;
    for (const [providerId, health] of this.states) {
      if (health.status === "cooldown" && Date.parse(health.retryAt) <= now) {
        this.states.delete(providerId);
        changed = true;
      }
    }
    if (changed) await this.save();
    return changed;
  }

  snapshot(now = Date.now()) {
    return Object.fromEntries([...this.states]
      .filter(([, health]) => health.status !== "cooldown" || Date.parse(health.retryAt) > now)
      .map(([providerId, health]) => [providerId, this.publicHealth(providerId, health)])) as Record<string, ProviderHealth>;
  }

  private publicHealth(providerId: string, health: StoredProviderHealth): ProviderHealth {
    return { ...health, message: sanitizedMessage(providerId, health.reason) };
  }

  private async save() {
    if (!this.statePath) return;
    const operation = this.saveQueue.then(async () => {
      const temporaryPath = `${this.statePath}.tmp`;
      const persisted: PersistedProviderHealth = { schemaVersion: 2, providers: Object.fromEntries(this.states) };
      await writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.statePath!);
      await chmod(this.statePath!, 0o600);
    });
    this.saveQueue = operation.catch(() => undefined);
    await operation;
  }
}
