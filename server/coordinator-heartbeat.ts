import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  evaluateActionPolicy,
  type AutonomousAction,
  type EvidenceReference,
  type Improvement,
} from "../shared/improvement-domain.js";
import type { RoomRepository } from "./storage/room-repository.js";

export const COORDINATOR_DATABASE_FILE = "coordinator-heartbeat.sqlite";

export interface CoordinatorDispatch {
  readonly improvement: Improvement;
  readonly action: AutonomousAction;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
}

export interface CoordinatorDispatchResult {
  readonly evidence: readonly Pick<EvidenceReference, "id" | "uri" | "description">[];
}

export interface CoordinatorExecutor {
  dispatch(input: CoordinatorDispatch): Promise<CoordinatorDispatchResult>;
}

export interface CoordinatorHeartbeatOptions {
  readonly enabled?: boolean;
  readonly ownerId?: string;
  readonly workerMemberId: string;
  readonly intervalMs?: number;
  readonly leaseMs?: number;
  readonly retryAfterMs?: number;
  readonly maxSelectedPerTick?: number;
  readonly maxDispatchedPerTick?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onError?: (error: unknown) => void;
}

export interface CoordinatorTickResult {
  readonly acquiredLease: boolean;
  readonly stopped: boolean;
  readonly selected: number;
  readonly dispatched: number;
}

interface StoredDispatch {
  readonly idempotencyKey: string;
  readonly improvementId: string;
  readonly improvementRevision: number;
  readonly action: AutonomousAction;
  readonly status: "RESERVED" | "DISPATCHING" | "SUCCEEDED" | "FAILED";
  readonly attempts: number;
  readonly lastAttemptAt: string | null;
}

export interface CoordinatorStateStore {
  tryAcquireLease(ownerId: string, now: string, expiresAt: string): boolean;
  renewLease(ownerId: string, now: string, expiresAt: string): boolean;
  releaseLease(ownerId: string): void;
  reserveDispatch(input: Omit<StoredDispatch, "status" | "attempts" | "lastAttemptAt">, now: string): StoredDispatch;
  beginDispatch(idempotencyKey: string, ownerId: string, now: string, retryBefore: string, maxAttempts: number): StoredDispatch | null;
  recordSuccess(idempotencyKey: string, now: string, evidence: CoordinatorDispatchResult["evidence"]): void;
  recordFailure(idempotencyKey: string, now: string, error: unknown): void;
  close(): void;
}

export class SqliteCoordinatorStateStore implements CoordinatorStateStore {
  private constructor(private readonly database: DatabaseSync, readonly databasePath: string) {}

  static async open(dataDirectory: string, databasePath = path.join(dataDirectory, COORDINATOR_DATABASE_FILE)) {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS coordinator_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coordinator_dispatches (
        idempotency_key TEXT PRIMARY KEY,
        improvement_id TEXT NOT NULL,
        improvement_revision INTEGER NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        reserved_at TEXT NOT NULL,
        last_attempt_at TEXT,
        completed_at TEXT,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        error TEXT
      );
    `);
    await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((file) => chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    })));
    return new SqliteCoordinatorStateStore(database, databasePath);
  }

  tryAcquireLease(ownerId: string, now: string, expiresAt: string) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT owner_id, expires_at FROM coordinator_lease WHERE singleton = 1")
        .get() as { owner_id: string; expires_at: string } | undefined;
      if (current && current.owner_id !== ownerId && current.expires_at > now) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.database.prepare(`
        INSERT INTO coordinator_lease(singleton, owner_id, expires_at, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at
      `).run(ownerId, expiresAt, now);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(ownerId: string, now: string, expiresAt: string) {
    return this.database.prepare("UPDATE coordinator_lease SET expires_at = ?, updated_at = ? WHERE singleton = 1 AND owner_id = ? AND expires_at > ?")
      .run(expiresAt, now, ownerId, now).changes === 1;
  }

  releaseLease(ownerId: string) {
    this.database.prepare("DELETE FROM coordinator_lease WHERE singleton = 1 AND owner_id = ?").run(ownerId);
  }

  reserveDispatch(input: Omit<StoredDispatch, "status" | "attempts" | "lastAttemptAt">, now: string) {
    this.database.prepare(`
      INSERT INTO coordinator_dispatches(idempotency_key, improvement_id, improvement_revision, action, status, reserved_at)
      VALUES (?, ?, ?, ?, 'RESERVED', ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(input.idempotencyKey, input.improvementId, input.improvementRevision, input.action, now);
    return this.readDispatch(input.idempotencyKey)!;
  }

  beginDispatch(idempotencyKey: string, ownerId: string, now: string, retryBefore: string, maxAttempts: number) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.database.prepare("SELECT owner_id, expires_at FROM coordinator_lease WHERE singleton = 1")
        .get() as { owner_id: string; expires_at: string } | undefined;
      if (!lease || lease.owner_id !== ownerId || lease.expires_at <= now) {
        this.database.exec("ROLLBACK");
        return null;
      }
      const dispatch = this.readDispatch(idempotencyKey);
      const retryable = dispatch && dispatch.status !== "SUCCEEDED" && dispatch.attempts < maxAttempts
        && (dispatch.status !== "DISPATCHING" || (dispatch.lastAttemptAt !== null && dispatch.lastAttemptAt <= retryBefore));
      if (!retryable) {
        this.database.exec("ROLLBACK");
        return null;
      }
      this.database.prepare("UPDATE coordinator_dispatches SET status = 'DISPATCHING', attempts = attempts + 1, last_attempt_at = ?, error = NULL WHERE idempotency_key = ?")
        .run(now, idempotencyKey);
      const updated = this.readDispatch(idempotencyKey)!;
      this.database.exec("COMMIT");
      return updated;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordSuccess(idempotencyKey: string, now: string, evidence: CoordinatorDispatchResult["evidence"]) {
    this.database.prepare("UPDATE coordinator_dispatches SET status = 'SUCCEEDED', completed_at = ?, evidence_json = ?, error = NULL WHERE idempotency_key = ?")
      .run(now, JSON.stringify(evidence), idempotencyKey);
  }

  recordFailure(idempotencyKey: string, now: string, error: unknown) {
    this.database.prepare("UPDATE coordinator_dispatches SET status = 'FAILED', completed_at = ?, error = ? WHERE idempotency_key = ?")
      .run(now, error instanceof Error ? error.message : String(error), idempotencyKey);
  }

  close() {
    this.database.close();
  }

  private readDispatch(idempotencyKey: string): StoredDispatch | null {
    const row = this.database.prepare(`
      SELECT idempotency_key, improvement_id, improvement_revision, action, status, attempts, last_attempt_at
      FROM coordinator_dispatches WHERE idempotency_key = ?
    `).get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      idempotencyKey: String(row.idempotency_key),
      improvementId: String(row.improvement_id),
      improvementRevision: Number(row.improvement_revision),
      action: row.action as AutonomousAction,
      status: row.status as StoredDispatch["status"],
      attempts: Number(row.attempts),
      lastAttemptAt: row.last_attempt_at === null ? null : String(row.last_attempt_at),
    };
  }
}

const DEFAULTS = {
  intervalMs: 30_000,
  leaseMs: 120_000,
  retryAfterMs: 120_000,
  maxSelectedPerTick: 5,
  maxDispatchedPerTick: 2,
  maxAttempts: 3,
} as const;

export class CoordinatorHeartbeat {
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly timerSet: typeof globalThis.setInterval;
  private readonly timerClear: typeof globalThis.clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly repository: Pick<RoomRepository, "getEmergencyStop" | "getImprovement" | "listImprovements">,
    private readonly state: CoordinatorStateStore,
    private readonly executor: CoordinatorExecutor,
    private readonly options: CoordinatorHeartbeatOptions,
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.timerSet = options.setInterval ?? globalThis.setInterval;
    this.timerClear = options.clearInterval ?? globalThis.clearInterval;
  }

  start() {
    if (this.options.enabled === false || this.timer) return false;
    const intervalMs = positive(this.options.intervalMs, DEFAULTS.intervalMs);
    this.timer = this.timerSet(() => void this.safeTick(), intervalMs);
    void this.safeTick();
    return true;
  }

  stop() {
    if (this.timer) this.timerClear(this.timer);
    this.timer = null;
    this.state.releaseLease(this.ownerId);
  }

  close() {
    this.stop();
    this.state.close();
  }

  async tick(): Promise<CoordinatorTickResult> {
    const initialStop = await this.repository.getEmergencyStop();
    if (initialStop.active) return { acquiredLease: false, stopped: true, selected: 0, dispatched: 0 };
    const now = this.now();
    const leaseMs = positive(this.options.leaseMs, DEFAULTS.leaseMs);
    if (!this.state.tryAcquireLease(this.ownerId, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString())) {
      return { acquiredLease: false, stopped: false, selected: 0, dispatched: 0 };
    }

    let selected = 0;
    let dispatched = 0;
    let stopped = false;
    try {
      const candidates = await this.candidates(positive(this.options.maxSelectedPerTick, DEFAULTS.maxSelectedPerTick));
      selected = candidates.length;
      for (const candidate of candidates) {
        if (dispatched >= positive(this.options.maxDispatchedPerTick, DEFAULTS.maxDispatchedPerTick)) break;
        if ((await this.repository.getEmergencyStop()).active) {
          stopped = true;
          break;
        }
        const fresh = await this.repository.getImprovement(candidate.improvement.id);
        if (!fresh || fresh.revision !== candidate.improvement.revision || !this.actionable(fresh, candidate.action)) continue;
        // The canonical projection read above can yield while an operator stops
        // automation, so close that race immediately before the synchronous
        // reservation and executor handoff.
        if ((await this.repository.getEmergencyStop()).active) {
          stopped = true;
          break;
        }
        const tickNow = this.now();
        const leaseExpiresAt = new Date(tickNow.getTime() + leaseMs).toISOString();
        if (!this.state.renewLease(this.ownerId, tickNow.toISOString(), leaseExpiresAt)) break;
        const idempotencyKey = coordinatorDispatchKey(fresh, candidate.action);
        this.state.reserveDispatch({ idempotencyKey, improvementId: fresh.id, improvementRevision: fresh.revision, action: candidate.action }, tickNow.toISOString());
        const retryBefore = new Date(tickNow.getTime() - positive(this.options.retryAfterMs, DEFAULTS.retryAfterMs)).toISOString();
        const begun = this.state.beginDispatch(idempotencyKey, this.ownerId, tickNow.toISOString(), retryBefore, positive(this.options.maxAttempts, DEFAULTS.maxAttempts));
        if (!begun) continue;
        try {
          const result = await this.executor.dispatch({ improvement: fresh, action: candidate.action, idempotencyKey, expectedRevision: fresh.revision });
          this.state.recordSuccess(idempotencyKey, this.now().toISOString(), result.evidence);
        } catch (error) {
          this.state.recordFailure(idempotencyKey, this.now().toISOString(), error);
        }
        dispatched += 1;
      }
      return { acquiredLease: true, stopped, selected, dispatched };
    } finally {
      this.state.releaseLease(this.ownerId);
    }
  }

  private async candidates(limit: number) {
    const selected: Array<{ improvement: Improvement; action: AutonomousAction }> = [];
    let cursor: string | undefined;
    while (selected.length < limit) {
      const page = await this.repository.listImprovements({ states: ["APPROVED", "IN_PROGRESS"], limit: Math.min(100, limit), cursor });
      for (const improvement of page.items) {
        const action = (["ANALYZE", "RUN_TESTS", "EDIT_SANDBOX"] as const).find((candidate) => this.actionable(improvement, candidate));
        if (action) selected.push({ improvement, action });
        if (selected.length >= limit) break;
      }
      if (!page.nextCursor || selected.length >= limit) break;
      cursor = page.nextCursor;
    }
    return selected;
  }

  private actionable(improvement: Improvement, action: AutonomousAction) {
    if (["BLOCKED", "CANCELED", "COMPLETED", "PAUSED"].includes(improvement.state)) return false;
    const claim = improvement.workClaim;
    const validOtherClaim = claim.status === "ACTIVE" && Date.parse(claim.leaseExpiresAt ?? "") > this.now().getTime()
      && claim.holderMemberId !== this.options.workerMemberId;
    if (validOtherClaim || claim.status === "COMPLETED") return false;
    return evaluateActionPolicy({ improvement, action, autonomous: true, emergencyStop: { active: false, activatedBy: null, activatedAt: null, reason: null } }).authorized;
  }

  private async safeTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.ticking = false;
    }
  }
}

export class HttpDeveloperTeamExecutor implements CoordinatorExecutor {
  constructor(private readonly endpoint: string, private readonly authorization?: string) {}

  async dispatch(input: CoordinatorDispatch): Promise<CoordinatorDispatchResult> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey, ...(this.authorization ? { authorization: this.authorization } : {}) },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Developer-team executor rejected dispatch with HTTP ${response.status}`);
    const result = await response.json() as Partial<CoordinatorDispatchResult>;
    return { evidence: Array.isArray(result.evidence) ? result.evidence : [] };
  }
}

export function coordinatorEnabled(environment: NodeJS.ProcessEnv = process.env) {
  return environment.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_HEARTBEAT_ENABLED !== "false"
    && Boolean(environment.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_URL?.trim());
}

export function coordinatorDispatchKey(improvement: Improvement, action: AutonomousAction) {
  const digest = createHash("sha256").update(`${improvement.id}\0${improvement.revision}\0${action}`).digest("hex").slice(0, 32);
  return `heartbeat:${digest}`;
}

function positive(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
