import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutonomousAction, Improvement } from "../shared/improvement-domain.js";
import { emptyImprovementStatus } from "../shared/improvement-status.js";
import {
  CoordinatorHeartbeat,
  SqliteCoordinatorStateStore,
  coordinatorDispatchKey,
  coordinatorEnabled,
  type CoordinatorDispatch,
  type CoordinatorExecutor,
} from "./coordinator-heartbeat.js";
import type { EmergencyStopProjection, ImprovementPage } from "./storage/room-repository.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeClock {
  constructor(public value = new Date("2026-08-21T12:00:00.000Z")) {}
  now = () => new Date(this.value);
  advance(milliseconds: number) { this.value = new Date(this.value.getTime() + milliseconds); }
}

class FakeRepository {
  stop: EmergencyStopProjection = { revision: 0, active: false, activatedBy: null, activatedAt: null, reason: null };
  stopReads = 0;
  onStopRead?: (count: number) => void;
  constructor(public improvements: Improvement[]) {}
  async getEmergencyStop() {
    this.stopReads += 1;
    this.onStopRead?.(this.stopReads);
    return structuredClone(this.stop);
  }
  async getImprovement(id: string) { return structuredClone(this.improvements.find((item) => item.id === id)); }
  async listImprovements(query: { cursor?: string; limit?: number } = {}): Promise<ImprovementPage> {
    const offset = Number(query.cursor ?? 0);
    const limit = query.limit ?? 50;
    const items = this.improvements.slice(offset, offset + limit);
    return { items: structuredClone(items), nextCursor: offset + items.length < this.improvements.length ? String(offset + items.length) : null };
  }
}

class FakeExecutor implements CoordinatorExecutor {
  calls: CoordinatorDispatch[] = [];
  failures = 0;
  async dispatch(input: CoordinatorDispatch) {
    this.calls.push(input);
    if (this.failures-- > 0) throw new Error("synthetic dispatch failure");
    return { evidence: [{ id: `e-${input.improvement.id}`, uri: `test://${input.improvement.id}`, description: "bounded step completed" }] };
  }
}

function improvement(id: string, revision = 7, action: AutonomousAction = "ANALYZE"): Improvement {
  return {
    id,
    revision,
    state: "APPROVED",
    risk: "LOW",
    authorId: "author",
    technicalConsensus: { status: "ACCEPTED", reviews: [] },
    actionAuthority: { status: "GRANTED", grantedBy: "operator", grantedByHuman: true, improvementRevision: revision, allowedActions: [action] },
    claims: [],
    workClaim: { fencingToken: 0, holderMemberId: null, leaseExpiresAt: null, status: "UNCLAIMED", manifests: [], history: [] },
    evidence: [],
    statusContract: emptyImprovementStatus(),
    proposal: { idempotencyKey: `proposal:${id}`, proposer: { id: "proposer", kind: "agent", capabilities: ["IMPROVEMENT_PROPOSE"] }, proposedAt: "2026-08-21T10:00:00.000Z", rationale: "bounded improvement", requestedOutcome: "verified outcome" },
    attribution: [{ actorId: "governor", at: "2026-08-21T10:30:00.000Z", change: "GOVERNANCE:decision-1:APPROVED", revision }],
    createdAt: "2026-08-21T11:00:00.000Z",
    updatedAt: "2026-08-21T11:00:00.000Z",
  };
}

async function stateFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-heartbeat-"));
  directories.push(directory);
  const databasePath = path.join(directory, "heartbeat.sqlite");
  return { directory, databasePath, state: await SqliteCoordinatorStateStore.open(directory, databasePath) };
}

function heartbeat(repository: FakeRepository, state: SqliteCoordinatorStateStore, executor: CoordinatorExecutor, clock: FakeClock, options: Record<string, unknown> = {}) {
  const runtimeEnabled = options.runtimeEnabled !== false;
  if (runtimeEnabled && !state.runtimeState().enabled) state.authorize(state.runtimeState().revision, "operator", "test authorization", clock.now().toISOString());
  const { runtimeEnabled: _runtimeEnabled, ...heartbeatOptions } = options;
  return new CoordinatorHeartbeat(repository, state, executor, {
    enabled: true,
    ownerId: "coordinator-a",
    workerMemberId: "builder",
    now: clock.now,
    ...heartbeatOptions,
  });
}

describe("bounded coordinator heartbeat", () => {
  it("ships disabled and remains disabled across restart until a new authorized action", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const first = heartbeat(new FakeRepository([improvement("off")]), fixture.state, executor, clock, { runtimeEnabled: false });
    expect(first.start()).toBe(false);
    expect(await first.tick()).toMatchObject({ acquiredLease: false, dispatched: 0 });
    fixture.state.close();

    const reopened = await SqliteCoordinatorStateStore.open(fixture.directory, fixture.databasePath);
    const second = heartbeat(new FakeRepository([improvement("off")]), reopened, executor, clock, { runtimeEnabled: false });
    expect(second.status().runtime).toMatchObject({ enabled: false, emergencyStopped: false });
    expect(second.authorize(0, "operator", "approved bounded heartbeat")).toMatchObject({ enabled: true, revision: 1 });
    await vi.waitFor(() => expect(executor.calls).toHaveLength(1));
    second.stop();
    reopened.close();
  });

  it("selects only gate-authorized canonical work and obeys both per-tick bounds", async () => {
    const { state } = await stateFixture();
    const clock = new FakeClock();
    const blocked = { ...improvement("blocked"), state: "BLOCKED" as const };
    const denied = { ...improvement("denied"), actionAuthority: { ...improvement("denied").actionAuthority, status: "DENIED" as const } };
    const validOtherClaim = { ...improvement("claimed"), workClaim: { ...improvement("claimed").workClaim, status: "ACTIVE" as const, holderMemberId: "other", leaseExpiresAt: "2026-08-21T12:10:00.000Z" } };
    const repository = new FakeRepository([blocked, denied, validOtherClaim, improvement("one"), improvement("two"), improvement("three")]);
    const executor = new FakeExecutor();
    const result = await heartbeat(repository, state, executor, clock, { maxSelectedPerTick: 2, maxDispatchedPerTick: 1 }).tick();
    expect(result).toMatchObject({ acquiredLease: true, selected: 2, dispatched: 1 });
    expect(executor.calls.map(({ improvement: item }) => item.id)).toEqual(["one"]);
    state.close();
  });

  it("checks emergency stop before selection and immediately before dispatch", async () => {
    const first = await stateFixture();
    const clock = new FakeClock();
    const stoppedRepository = new FakeRepository([improvement("one")]);
    stoppedRepository.stop = { revision: 1, active: true, activatedBy: "operator", activatedAt: clock.now().toISOString(), reason: "halt" };
    const stoppedExecutor = new FakeExecutor();
    expect(await heartbeat(stoppedRepository, first.state, stoppedExecutor, clock).tick()).toMatchObject({ stopped: true, selected: 0, dispatched: 0 });
    expect(stoppedExecutor.calls).toHaveLength(0);
    first.state.close();

    const second = await stateFixture();
    const racingRepository = new FakeRepository([improvement("two")]);
    racingRepository.onStopRead = (count) => {
      if (count === 2) racingRepository.stop = { revision: 1, active: true, activatedBy: "operator", activatedAt: clock.now().toISOString(), reason: "halt before dispatch" };
    };
    const racingExecutor = new FakeExecutor();
    expect(await heartbeat(racingRepository, second.state, racingExecutor, clock).tick()).toMatchObject({ stopped: true, selected: 1, dispatched: 0 });
    expect(racingExecutor.calls).toHaveLength(0);
    second.state.close();
  });

  it("uses a durable CAS lease to prevent concurrent coordinators", async () => {
    const fixture = await stateFixture();
    const competing = await SqliteCoordinatorStateStore.open(fixture.directory, fixture.databasePath);
    const clock = new FakeClock();
    expect(fixture.state.tryAcquireLease("coordinator-a", clock.now().toISOString(), "2026-08-21T12:05:00.000Z")).toBe(true);
    const executor = new FakeExecutor();
    const result = await heartbeat(new FakeRepository([improvement("one")]), competing, executor, clock, { ownerId: "coordinator-b" }).tick();
    expect(result.acquiredLease).toBe(false);
    expect(executor.calls).toHaveLength(0);
    fixture.state.close();
    competing.close();
  });

  it("rejects overlapping runs from the same owner and enforces the time budget", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    const executor: CoordinatorExecutor = { dispatch: async () => new Promise(() => undefined) };
    const coordinator = heartbeat(new FakeRepository([improvement("bounded-time")]), fixture.state, executor, clock, { timeBudgetMs: 500 });
    const first = coordinator.tick();
    await vi.waitFor(() => expect(coordinator.status().attempts.some((attempt) => attempt.outcome === "STARTED")).toBe(true));
    expect(await coordinator.tick()).toMatchObject({ acquiredLease: false, dispatched: 0 });
    expect(await first).toMatchObject({ acquiredLease: true, dispatched: 1 });
    expect(coordinator.status().attempts[0]).toMatchObject({ outcome: "FAILED", blocker: "Heartbeat time budget exceeded" });
    fixture.state.close();
  });

  it("recovers an interrupted dispatch after lease and retry expiry without changing its idempotency key", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    const item = improvement("recover");
    expect(fixture.state.tryAcquireLease("crashed-owner", clock.now().toISOString(), "2026-08-21T12:00:01.000Z")).toBe(true);
    const stableKey = coordinatorDispatchKey(item, "ANALYZE");
    fixture.state.reserveDispatch({ idempotencyKey: stableKey, improvementId: item.id, improvementRevision: item.revision, action: "ANALYZE" }, clock.now().toISOString());
    fixture.state.beginDispatch(stableKey, "crashed-owner", clock.now().toISOString(), "2026-08-21T11:59:59.000Z", 3);
    fixture.state.close();

    clock.advance(2_000);
    const reopened = await SqliteCoordinatorStateStore.open(fixture.directory, fixture.databasePath);
    // Stable dispatch identity is derived from canonical work. Seed that exact key once,
    // then prove reopening does not create a second journal entry or external action.
    const probe = new FakeExecutor();
    const current = heartbeat(new FakeRepository([item]), reopened, probe, clock, { retryAfterMs: 1_000, leaseMs: 1_000, ownerId: "restarted-owner" });
    await current.tick();
    expect(probe.calls).toHaveLength(1);
    const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM coordinator_dispatches").get() as { count: number }).count).toBe(1);
    db.close();
    reopened.close();
  });

  it("allows expired claims, rejects stale revision evidence, and records failed then successful retry evidence", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    const baseExpired = improvement("expired");
    const expired = { ...baseExpired, workClaim: { ...baseExpired.workClaim, status: "ACTIVE" as const, holderMemberId: "other", leaseExpiresAt: "2026-08-21T11:59:59.000Z" } };
    const staleListed = improvement("stale", 4);
    const repository = new FakeRepository([expired, staleListed]);
    const originalGet = repository.getImprovement.bind(repository);
    repository.getImprovement = async (id: string) => id === "stale" ? improvement("stale", 5) : originalGet(id);
    const executor = new FakeExecutor();
    executor.failures = 1;
    const coordinator = heartbeat(repository, fixture.state, executor, clock);
    expect(await coordinator.tick()).toMatchObject({ selected: 2, dispatched: 1 });
    expect(executor.calls.map(({ improvement: item }) => item.id)).toEqual(["expired"]);
    clock.advance(121_000);
    expect(await coordinator.tick()).toMatchObject({ dispatched: 1 });
    expect(executor.calls[0].idempotencyKey).toBe(executor.calls[1].idempotencyKey);

    const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
    const row = db.prepare("SELECT status, attempts, evidence_json, error FROM coordinator_dispatches").get() as { status: string; attempts: number; evidence_json: string; error: string | null };
    expect(row).toMatchObject({ status: "SUCCEEDED", attempts: 2, error: null });
    expect(JSON.parse(row.evidence_json)).toEqual([{ id: "e-expired", uri: "test://expired", description: "bounded step completed" }]);
    db.close();
    fixture.state.close();
  });

  it("caps retry storms at the policy attempt limit", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    executor.failures = 10;
    const coordinator = heartbeat(new FakeRepository([improvement("storm")]), fixture.state, executor, clock, { maxAttempts: 2, retryAfterMs: 1 });
    await coordinator.tick();
    clock.advance(2);
    await coordinator.tick();
    clock.advance(2);
    await coordinator.tick();
    expect(executor.calls).toHaveLength(2);
    fixture.state.close();
  });

  it("starts immediately, cleans up its timer, and supports explicit opt-out", async () => {
    const fixture = await stateFixture();
    const setTimer = vi.fn(() => 42 as unknown as ReturnType<typeof setInterval>);
    const clearTimer = vi.fn();
    const coordinator = heartbeat(new FakeRepository([]), fixture.state, new FakeExecutor(), new FakeClock(), { setInterval: setTimer, clearInterval: clearTimer });
    expect(coordinator.start()).toBe(true);
    coordinator.stop();
    expect(setTimer).toHaveBeenCalledOnce();
    expect(clearTimer).toHaveBeenCalledWith(42);
    const optedOut = heartbeat(new FakeRepository([]), fixture.state, new FakeExecutor(), new FakeClock(), { enabled: false, setInterval: setTimer });
    expect(optedOut.start()).toBe(false);
    expect(coordinatorEnabled({ ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_URL: "https://executor.invalid", ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_HEARTBEAT_ENABLED: "false" })).toBe(false);
    expect(coordinatorEnabled({ ALL_MY_FRIENDS_ARE_AGENTS_COORDINATOR_EXECUTOR_URL: "https://executor.invalid" })).toBe(false);
    fixture.state.close();
  });

  it("requires governed proposal advancement and current authority", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    const plain = { ...improvement("plain"), proposal: undefined };
    const unadvanced = { ...improvement("unadvanced"), attribution: [] };
    const denied = { ...improvement("denied"), actionAuthority: { ...improvement("denied").actionAuthority, status: "DENIED" as const } };
    const executor = new FakeExecutor();
    expect(await heartbeat(new FakeRepository([plain, unadvanced, denied]), fixture.state, executor, clock).tick()).toMatchObject({ selected: 0, dispatched: 0 });
    expect(executor.calls).toHaveLength(0);
    fixture.state.close();
  });

  it("exposes policy and audit evidence while withholding prohibited capabilities", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    const executor = new FakeExecutor();
    const coordinator = heartbeat(new FakeRepository([improvement("audited")]), fixture.state, executor, clock, { maxSelectedPerTick: 1, maxAttempts: 2, timeBudgetMs: 5000 });
    expect(await coordinator.tick()).toMatchObject({ dispatched: 1 });
    expect(coordinator.status().policy).toMatchObject({ version: "heartbeat-policy-v1", maxConcurrency: 1, maxSelectedPerRun: 1, maxDispatchedPerRun: 2, maxAttemptsPerRevision: 2, timeBudgetMs: 5000 });
    expect(coordinator.status().policy.prohibitedCapabilities).toEqual(expect.arrayContaining(["COMMIT", "PUSH", "MERGE", "DEPLOY", "PUBLISH_UPSTREAM", "BYPASS_GOVERNED_EXECUTOR"]));
    expect(executor.calls[0].policy.permittedCapabilities).toEqual(["ANALYZE", "EDIT_SANDBOX", "RUN_TESTS"]);
    expect(executor.calls[0]).not.toHaveProperty("commit");
    const completed = coordinator.status().attempts.find((attempt) => attempt.outcome === "SUCCEEDED");
    expect(completed).toMatchObject({ policyVersion: "heartbeat-policy-v1", authorityDecision: "AUTHORIZED", improvementId: "audited", selectedRevision: 7, nextAction: expect.any(String) });
    expect(completed?.inputEvidence).toEqual(expect.arrayContaining(["proposal:proposal:audited", "GOVERNANCE:decision-1:APPROVED@r7"]));
    fixture.state.close();
  });

  it("persists emergency stop, aborts active work, and requires reauthorization", async () => {
    const fixture = await stateFixture();
    const clock = new FakeClock();
    let observedAbort = false;
    const executor: CoordinatorExecutor = { dispatch: async (input) => new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => { observedAbort = true; reject(input.signal.reason); }, { once: true })) };
    const coordinator = heartbeat(new FakeRepository([improvement("halt")]), fixture.state, executor, clock);
    const running = coordinator.tick();
    await vi.waitFor(() => expect(coordinator.status().active || coordinator.status().attempts.some((attempt) => attempt.outcome === "STARTED")).toBe(true));
    expect(coordinator.emergencyStop(1, "operator", "unsafe behavior")).toMatchObject({ enabled: false, emergencyStopped: true, revision: 2 });
    await running;
    expect(observedAbort).toBe(true);
    expect(coordinator.status().audit[0]).toMatchObject({ revision: 2, kind: "EMERGENCY_STOPPED", actorId: "operator", reason: "unsafe behavior" });
    fixture.state.close();

    const reopened = await SqliteCoordinatorStateStore.open(fixture.directory, fixture.databasePath);
    const restarted = heartbeat(new FakeRepository([improvement("halt", 8)]), reopened, new FakeExecutor(), clock, { runtimeEnabled: false });
    expect(restarted.status().runtime).toMatchObject({ enabled: false, emergencyStopped: true });
    expect(await restarted.tick()).toMatchObject({ stopped: true, dispatched: 0 });
    expect(restarted.authorize(2, "operator", "new review authorizes resumption")).toMatchObject({ enabled: true, emergencyStopped: false, revision: 3 });
    reopened.close();
  });
});
