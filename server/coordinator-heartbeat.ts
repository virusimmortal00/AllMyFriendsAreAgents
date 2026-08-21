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
  readonly policy: HeartbeatPolicy;
  readonly inputEvidence: readonly string[];
  readonly signal: AbortSignal;
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
  readonly timeBudgetMs?: number;
  readonly now?: () => Date;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onError?: (error: unknown) => void;
}

export const HEARTBEAT_PERMITTED_CAPABILITIES = ["ANALYZE", "EDIT_SANDBOX", "RUN_TESTS"] as const;

export interface HeartbeatPolicy {
  readonly version: string;
  readonly eligibleStates: readonly ["APPROVED", "IN_PROGRESS"];
  readonly governedProposalRequired: true;
  readonly cadenceMs: number;
  readonly maxConcurrency: 1;
  readonly maxSelectedPerRun: number;
  readonly maxDispatchedPerRun: number;
  readonly maxAttemptsPerRevision: number;
  readonly retryAfterMs: number;
  readonly timeBudgetMs: number;
  readonly permittedCapabilities: typeof HEARTBEAT_PERMITTED_CAPABILITIES;
  readonly prohibitedCapabilities: readonly ["COMMIT", "PUSH", "MERGE", "DEPLOY", "PUBLISH_UPSTREAM", "BYPASS_GOVERNED_EXECUTOR"];
}

export interface HeartbeatRuntimeState {
  readonly revision: number;
  readonly enabled: boolean;
  readonly emergencyStopped: boolean;
  readonly changedBy: string | null;
  readonly changedAt: string | null;
  readonly reason: string | null;
}

export interface HeartbeatAttemptRecord {
  readonly idempotencyKey: string;
  readonly policyVersion: string;
  readonly authorityDecision: "AUTHORIZED" | "DENIED";
  readonly authorityReasons: readonly string[];
  readonly improvementId: string;
  readonly selectedRevision: number;
  readonly inputEvidence: readonly string[];
  readonly action: AutonomousAction;
  readonly outcome: "STARTED" | "SUCCEEDED" | "FAILED" | "HALTED" | "BLOCKED";
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly nextAction: string | null;
  readonly blocker: string | null;
}

export interface HeartbeatRuntimeEvent {
  readonly revision: number;
  readonly kind: "AUTHORIZED" | "EMERGENCY_STOPPED";
  readonly actorId: string;
  readonly at: string;
  readonly reason: string;
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
  runtimeState(): HeartbeatRuntimeState;
  authorize(revision: number, actorId: string, reason: string, now: string): HeartbeatRuntimeState | null;
  emergencyStop(revision: number, actorId: string, reason: string, now: string): HeartbeatRuntimeState | null;
  recordAttempt(record: HeartbeatAttemptRecord): void;
  attempts(limit?: number): readonly HeartbeatAttemptRecord[];
  runtimeEvents(limit?: number): readonly HeartbeatRuntimeEvent[];
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
      CREATE TABLE IF NOT EXISTS coordinator_runtime (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        emergency_stopped INTEGER NOT NULL,
        changed_by TEXT,
        changed_at TEXT,
        reason TEXT
      );
      INSERT INTO coordinator_runtime(singleton, revision, enabled, emergency_stopped)
      VALUES (1, 0, 0, 0) ON CONFLICT(singleton) DO NOTHING;
      CREATE TABLE IF NOT EXISTS coordinator_attempt_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        authority_decision TEXT NOT NULL,
        authority_reasons_json TEXT NOT NULL,
        improvement_id TEXT NOT NULL,
        selected_revision INTEGER NOT NULL,
        input_evidence_json TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        next_action TEXT,
        blocker TEXT
      );
      CREATE TABLE IF NOT EXISTS coordinator_runtime_events (
        revision INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL
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
      if (current && current.expires_at > now) {
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

  runtimeState(): HeartbeatRuntimeState {
    const row = this.database.prepare("SELECT revision, enabled, emergency_stopped, changed_by, changed_at, reason FROM coordinator_runtime WHERE singleton = 1").get() as Record<string, unknown>;
    return {
      revision: Number(row.revision), enabled: Boolean(row.enabled), emergencyStopped: Boolean(row.emergency_stopped),
      changedBy: row.changed_by === null ? null : String(row.changed_by), changedAt: row.changed_at === null ? null : String(row.changed_at),
      reason: row.reason === null ? null : String(row.reason),
    };
  }

  authorize(revision: number, actorId: string, reason: string, now: string) {
    if (!actorId.trim() || !reason.trim()) return null;
    const changed = this.database.prepare("UPDATE coordinator_runtime SET revision = revision + 1, enabled = 1, emergency_stopped = 0, changed_by = ?, changed_at = ?, reason = ? WHERE singleton = 1 AND revision = ?")
      .run(actorId.trim(), now, reason.trim(), revision).changes;
    if (changed !== 1) return null;
    const next = this.runtimeState();
    this.database.prepare("INSERT INTO coordinator_runtime_events(revision, kind, actor_id, occurred_at, reason) VALUES (?, 'AUTHORIZED', ?, ?, ?)").run(next.revision, actorId.trim(), now, reason.trim());
    return next;
  }

  emergencyStop(revision: number, actorId: string, reason: string, now: string) {
    if (!actorId.trim() || !reason.trim()) return null;
    const changed = this.database.prepare("UPDATE coordinator_runtime SET revision = revision + 1, enabled = 0, emergency_stopped = 1, changed_by = ?, changed_at = ?, reason = ? WHERE singleton = 1 AND revision = ?")
      .run(actorId.trim(), now, reason.trim(), revision).changes;
    if (changed !== 1) return null;
    const next = this.runtimeState();
    this.database.prepare("INSERT INTO coordinator_runtime_events(revision, kind, actor_id, occurred_at, reason) VALUES (?, 'EMERGENCY_STOPPED', ?, ?, ?)").run(next.revision, actorId.trim(), now, reason.trim());
    return next;
  }

  recordAttempt(record: HeartbeatAttemptRecord) {
    this.database.prepare(`INSERT INTO coordinator_attempt_audit(
      idempotency_key, policy_version, authority_decision, authority_reasons_json, improvement_id, selected_revision,
      input_evidence_json, action, outcome, started_at, completed_at, next_action, blocker
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.idempotencyKey, record.policyVersion, record.authorityDecision, JSON.stringify(record.authorityReasons), record.improvementId,
      record.selectedRevision, JSON.stringify(record.inputEvidence), record.action, record.outcome, record.startedAt, record.completedAt,
      record.nextAction, record.blocker,
    );
  }

  attempts(limit = 50): readonly HeartbeatAttemptRecord[] {
    const rows = this.database.prepare(`SELECT * FROM coordinator_attempt_audit ORDER BY sequence DESC LIMIT ?`).all(Math.max(1, Math.min(200, limit))) as Record<string, unknown>[];
    return rows.map((row) => ({
      idempotencyKey: String(row.idempotency_key), policyVersion: String(row.policy_version), authorityDecision: row.authority_decision as HeartbeatAttemptRecord["authorityDecision"],
      authorityReasons: JSON.parse(String(row.authority_reasons_json)), improvementId: String(row.improvement_id), selectedRevision: Number(row.selected_revision),
      inputEvidence: JSON.parse(String(row.input_evidence_json)), action: row.action as AutonomousAction, outcome: row.outcome as HeartbeatAttemptRecord["outcome"],
      startedAt: String(row.started_at), completedAt: row.completed_at === null ? null : String(row.completed_at),
      nextAction: row.next_action === null ? null : String(row.next_action), blocker: row.blocker === null ? null : String(row.blocker),
    }));
  }

  runtimeEvents(limit = 50): readonly HeartbeatRuntimeEvent[] {
    const rows = this.database.prepare("SELECT revision, kind, actor_id, occurred_at, reason FROM coordinator_runtime_events ORDER BY revision DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as Record<string, unknown>[];
    return rows.map((row) => ({ revision: Number(row.revision), kind: row.kind as HeartbeatRuntimeEvent["kind"], actorId: String(row.actor_id), at: String(row.occurred_at), reason: String(row.reason) }));
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
  timeBudgetMs: 60_000,
} as const;

export function heartbeatPolicy(options: Pick<CoordinatorHeartbeatOptions, "intervalMs" | "retryAfterMs" | "maxSelectedPerTick" | "maxDispatchedPerTick" | "maxAttempts" | "timeBudgetMs"> = {}): HeartbeatPolicy {
  return {
    version: "heartbeat-policy-v1", eligibleStates: ["APPROVED", "IN_PROGRESS"], governedProposalRequired: true,
    cadenceMs: positive(options.intervalMs, DEFAULTS.intervalMs), maxConcurrency: 1,
    maxSelectedPerRun: positive(options.maxSelectedPerTick, DEFAULTS.maxSelectedPerTick),
    maxDispatchedPerRun: positive(options.maxDispatchedPerTick, DEFAULTS.maxDispatchedPerTick),
    maxAttemptsPerRevision: positive(options.maxAttempts, DEFAULTS.maxAttempts), retryAfterMs: positive(options.retryAfterMs, DEFAULTS.retryAfterMs),
    timeBudgetMs: positive(options.timeBudgetMs, DEFAULTS.timeBudgetMs), permittedCapabilities: HEARTBEAT_PERMITTED_CAPABILITIES,
    prohibitedCapabilities: ["COMMIT", "PUSH", "MERGE", "DEPLOY", "PUBLISH_UPSTREAM", "BYPASS_GOVERNED_EXECUTOR"],
  };
}

export class CoordinatorHeartbeat {
  private readonly ownerId: string;
  private readonly now: () => Date;
  private readonly timerSet: typeof globalThis.setInterval;
  private readonly timerClear: typeof globalThis.clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private activeAbort: AbortController | null = null;
  readonly policy: HeartbeatPolicy;

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
    this.policy = heartbeatPolicy(options);
  }

  start() {
    if (this.options.enabled !== true || !this.state.runtimeState().enabled || this.timer) return false;
    const intervalMs = positive(this.options.intervalMs, DEFAULTS.intervalMs);
    this.timer = this.timerSet(() => void this.safeTick(), intervalMs);
    void this.safeTick();
    return true;
  }

  stop() {
    if (this.timer) this.timerClear(this.timer);
    this.timer = null;
    this.activeAbort?.abort(new Error("Heartbeat stopped"));
    this.state.releaseLease(this.ownerId);
  }

  status() {
    return { runtime: this.state.runtimeState(), policy: this.policy, active: this.ticking, attempts: this.state.attempts(20), audit: this.state.runtimeEvents(20) };
  }

  authorize(expectedRevision: number, actorId: string, reason: string) {
    const next = this.state.authorize(expectedRevision, actorId, reason, this.now().toISOString());
    if (next) this.start();
    return next;
  }

  emergencyStop(expectedRevision: number, actorId: string, reason: string) {
    const next = this.state.emergencyStop(expectedRevision, actorId, reason, this.now().toISOString());
    if (next) this.stop();
    return next;
  }

  close() {
    this.stop();
    this.state.close();
  }

  async tick(): Promise<CoordinatorTickResult> {
    const runtime = this.state.runtimeState();
    if (this.options.enabled !== true || !runtime.enabled || runtime.emergencyStopped) {
      return { acquiredLease: false, stopped: runtime.emergencyStopped, selected: 0, dispatched: 0 };
    }
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
        let timeout: ReturnType<typeof setTimeout> | null = null;
        try {
          const inputEvidence = evidenceSnapshot(fresh);
          const controller = new AbortController();
          this.activeAbort = controller;
          const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new Error("Heartbeat aborted")), { once: true }));
          timeout = setTimeout(() => controller.abort(new Error("Heartbeat time budget exceeded")), this.policy.timeBudgetMs);
          const startedAt = this.now().toISOString();
          this.state.recordAttempt({ idempotencyKey, policyVersion: this.policy.version, authorityDecision: "AUTHORIZED", authorityReasons: [], improvementId: fresh.id, selectedRevision: fresh.revision, inputEvidence, action: candidate.action, outcome: "STARTED", startedAt, completedAt: null, nextAction: "Await bounded executor outcome", blocker: null });
          const result = await Promise.race([
            this.executor.dispatch({ improvement: fresh, action: candidate.action, idempotencyKey, expectedRevision: fresh.revision, policy: this.policy, inputEvidence, signal: controller.signal }),
            aborted,
          ]);
          this.state.recordSuccess(idempotencyKey, this.now().toISOString(), result.evidence);
          this.state.recordAttempt({ idempotencyKey, policyVersion: this.policy.version, authorityDecision: "AUTHORIZED", authorityReasons: [], improvementId: fresh.id, selectedRevision: fresh.revision, inputEvidence, action: candidate.action, outcome: "SUCCEEDED", startedAt, completedAt: this.now().toISOString(), nextAction: "Re-evaluate current governed revision on next cadence", blocker: null });
        } catch (error) {
          this.state.recordFailure(idempotencyKey, this.now().toISOString(), error);
          const halted = this.state.runtimeState().emergencyStopped || error instanceof DOMException && error.name === "AbortError";
          this.state.recordAttempt({ idempotencyKey, policyVersion: this.policy.version, authorityDecision: "AUTHORIZED", authorityReasons: [], improvementId: fresh.id, selectedRevision: fresh.revision, inputEvidence: evidenceSnapshot(fresh), action: candidate.action, outcome: halted ? "HALTED" : "FAILED", startedAt: begun.lastAttemptAt ?? tickNow.toISOString(), completedAt: this.now().toISOString(), nextAction: halted ? null : "Retry after policy backoff if authority remains current", blocker: error instanceof Error ? error.message : String(error) });
        } finally {
          if (timeout) clearTimeout(timeout);
          this.activeAbort = null;
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
    if (!improvement.proposal || !improvement.attribution.some((entry) => entry.change.startsWith("GOVERNANCE:"))) return false;
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
      body: JSON.stringify({ ...input, signal: undefined }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Developer-team executor rejected dispatch with HTTP ${response.status}`);
    const result = await response.json() as Partial<CoordinatorDispatchResult>;
    return { evidence: Array.isArray(result.evidence) ? result.evidence : [] };
  }
}

export function coordinatorEnabled(environment: NodeJS.ProcessEnv = process.env) {
  return environment.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_HEARTBEAT_ENABLED === "true"
    && Boolean(environment.ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_URL?.trim());
}

export function coordinatorDispatchKey(improvement: Improvement, action: AutonomousAction) {
  const digest = createHash("sha256").update(`${improvement.id}\0${improvement.revision}\0${action}`).digest("hex").slice(0, 32);
  return `heartbeat:${digest}`;
}

function positive(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function evidenceSnapshot(improvement: Improvement) {
  return [
    `proposal:${improvement.proposal?.idempotencyKey ?? "missing"}`,
    ...improvement.attribution.filter((entry) => entry.change.startsWith("GOVERNANCE:")).map((entry) => `${entry.change}@r${entry.revision}`),
    ...improvement.evidence.map((entry) => `${entry.id}:${entry.uri}`),
  ];
}
