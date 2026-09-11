import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProtectedWorkCapacityError, ProtectedWorkStore, type ProtectedWorkRecord } from "./protected-work-store.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function record(workId: string, now: string, phase: ProtectedWorkRecord["phase"] = "available"): ProtectedWorkRecord {
  return {
    schemaVersion: 1, revision: 1, workId, roomId: "room", owner: "codex-sol", objective: "Review",
    requestDigest: digest(workId), phase, createdAt: now, startedAt: phase === "queued" ? null : now,
    stoppedAt: phase === "queued" ? null : now, updatedAt: now, blocker: null,
    disposition: phase === "available" ? "no-update" : null, departureCursor: null, returnAttempts: 0,
    package: null, report: null,
  };
}

it("normalizes report field order before auditing, round-trips, and rejects tampered records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-"));
  try {
    const now = new Date().toISOString();
    const record: ProtectedWorkRecord = {
      schemaVersion: 1, revision: 1, workId: "protected-fixture", roomId: "room", owner: "codex-sol", objective: "Review",
      requestDigest: "a".repeat(64), phase: "report-pending", createdAt: now, startedAt: now, stoppedAt: now,
      updatedAt: now, blocker: null, disposition: null, departureCursor: null, returnAttempts: 1,
      package: { summary: "Finding", evidenceRefs: [], unresolvedQuestions: [], status: "completed", createdAt: now },
      report: { relevance: "qualified", text: "Bounded finding", cursor: "current" },
    };
    const store = await ProtectedWorkStore.open(directory);
    expect(await store.put(record, 0)).toBe(true);
    expect(await (await ProtectedWorkStore.open(directory)).get(record.workId)).toEqual(record);
    expect(await store.put({ ...record, revision: 2 }, 0)).toBe(false);
    const file = path.join(directory, "protected-work.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.records[record.workId].report.text = "Substituted";
    await writeFile(file, JSON.stringify(state));
    await expect(ProtectedWorkStore.open(directory)).rejects.toThrow(/Invalid protected-work record/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

describe("protected-work retention", () => {
  it("migrates a v1 ledger without dropping records or audit history", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-migrate-"));
    try {
      const now = "2026-01-01T00:00:00.000Z";
      const value = record("protected-legacy", now);
      const unsigned = { workId: value.workId, revision: value.revision, at: value.updatedAt, phase: value.phase, recordHash: digest(value), previousHash: null };
      await writeFile(path.join(directory, "protected-work.json"), JSON.stringify({ schemaVersion: 1, records: { [value.workId]: value }, events: [{ ...unsigned, eventHash: digest(unsigned) }] }));
      const store = await ProtectedWorkStore.open(directory);
      expect(await store.get(value.workId)).toEqual(value);
      const migrated = JSON.parse(await readFile(path.join(directory, "protected-work.json"), "utf8"));
      expect(migrated).toMatchObject({ schemaVersion: 2, records: { [value.workId]: value }, anchors: {}, actionReceiptCaps: {}, archive: { checkpoint: null, entries: [] } });
      expect(migrated.events).toHaveLength(1);
      expect(await (await ProtectedWorkStore.open(directory)).get(value.workId)).toEqual(value);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reserves bounded recovery receipts for an oversized active v1 record", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-action-migrate-"));
    try {
      const now = "2026-01-01T00:00:00.000Z";
      const actions = Array.from({ length: 5 }, (_, index) => ({ key: `${index}`.padStart(64, "a"), action: "retry-return" as const }));
      const base = record("protected-legacy-active", now, "blocked");
      const { returnAttempts, package: workPackage, report, ...beforeActions } = base;
      const value = { ...beforeActions, actions, returnAttempts, package: workPackage, report };
      const unsigned = { workId: value.workId, revision: value.revision, at: value.updatedAt, phase: value.phase, recordHash: digest(value), previousHash: null };
      await writeFile(path.join(directory, "protected-work.json"), JSON.stringify({ schemaVersion: 1, records: { [value.workId]: value }, events: [{ ...unsigned, eventHash: digest(unsigned) }] }));
      const policy = { maxActionReceipts: 4, actionRecoveryReserve: 2 };
      const store = await ProtectedWorkStore.open(directory, policy);
      expect(store.actionReceiptAvailable(value, "retry-return")).toBe(false);
      expect(store.actionReceiptAvailable(value, "stop")).toBe(true);
      expect(store.actionReceiptAvailable(value, "dismiss")).toBe(true);
      const afterStop = { ...value, revision: 2, updatedAt: "2026-01-01T00:00:01.000Z",
        actions: [...actions, { key: "f".repeat(64), action: "stop" as const }] };
      expect(await store.put(afterStop, value.revision)).toBe(true);
      const reopened = await ProtectedWorkStore.open(directory, policy);
      expect(reopened.actionReceiptAvailable(afterStop, "stop")).toBe(false);
      expect(reopened.actionReceiptAvailable(afterStop, "dismiss")).toBe(true);
      const file = path.join(directory, "protected-work.json");
      const tampered = JSON.parse(await readFile(file, "utf8"));
      tampered.actionReceiptCaps[value.workId] += 100;
      await writeFile(file, JSON.stringify(tampered));
      await expect(ProtectedWorkStore.open(directory, policy)).rejects.toThrow(/receipt cap/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("compacts a long audit history to a verifiable anchor and round-trips", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-audit-"));
    try {
      const store = await ProtectedWorkStore.open(directory, { maxAuditEventsPerRecord: 3 });
      let value = record("protected-long-running", "2026-01-01T00:00:00.000Z", "queued");
      expect(await store.put(value, 0)).toBe(true);
      for (let revision = 2; revision <= 12; revision += 1) {
        const previous = value;
        value = { ...previous, revision, updatedAt: new Date(Date.parse(previous.updatedAt) + 1_000).toISOString(), blocker: `Attempt ${revision}` };
        expect(await store.put(value, previous.revision)).toBe(true);
      }
      const state = JSON.parse(await readFile(path.join(directory, "protected-work.json"), "utf8"));
      expect(state.anchors[value.workId].revision).toBe(9);
      expect(state.events.map((event: { revision: number }) => event.revision)).toEqual([10, 11, 12]);
      expect(await (await ProtectedWorkStore.open(directory, { maxAuditEventsPerRecord: 3 })).get(value.workId)).toEqual(value);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("archives terminal history, preserves replay identity, and compacts archive detail to a chained checkpoint", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-archive-"));
    try {
      const policy = { terminalRetentionMs: 365 * 24 * 60 * 60 * 1_000, maxTerminalRecords: 1, maxArchiveBytes: 2_500 };
      const store = await ProtectedWorkStore.open(directory, policy);
      const values: ProtectedWorkRecord[] = [];
      for (let index = 0; index < 8; index += 1) {
        const value = { ...record(`protected-history-${index}`, new Date(Date.UTC(2026, 0, index + 1)).toISOString()), objective: `Review ${index} ${"x".repeat(400)}` };
        values.push(value);
        expect(await store.put(value, 0)).toBe(true);
      }
      expect(await store.list()).toEqual([values.at(-1)]);
      const state = JSON.parse(await readFile(path.join(directory, "protected-work.json"), "utf8"));
      expect(Buffer.byteLength(JSON.stringify(state.archive))).toBeLessThanOrEqual(policy.maxArchiveBytes);
      expect(state.archive.entryBytes).toBe(Buffer.byteLength(state.archive.entries.map((entry: unknown) => JSON.stringify(entry)).join(",")));
      expect(state.archive.checkpoint).toMatchObject({ entryCount: expect.any(Number), throughHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(state.archive.entries.length).toBeGreaterThan(0);
      const retained = state.archive.entries.at(-1).record as ProtectedWorkRecord;
      expect(await store.get(retained.workId)).toEqual(retained);
      await expect(ProtectedWorkStore.open(directory, policy)).resolves.toBeInstanceOf(ProtectedWorkStore);
      state.archive.entries.at(-1).record.objective = "Substituted archive detail";
      await writeFile(path.join(directory, "protected-work.json"), JSON.stringify(state));
      await expect(ProtectedWorkStore.open(directory, policy)).rejects.toThrow(/archive/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("moves expired terminal records out of the hot ledger without evicting active work", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-expiry-"));
    try {
      const store = await ProtectedWorkStore.open(directory, { terminalRetentionMs: 30 * 24 * 60 * 60 * 1_000 });
      const terminal = record("protected-expired", "2026-01-01T00:00:00.000Z");
      const active = record("protected-current", "2026-02-01T00:00:00.001Z", "queued");
      expect(await store.put(terminal, 0)).toBe(true);
      expect(await store.put(active, 0)).toBe(true);
      expect(await store.list()).toEqual([active]);
      expect(await store.get(terminal.workId)).toEqual(terminal);
      expect(await store.get(active.workId)).toEqual(active);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses new admission at the hot-ledger budget while retaining space for terminal recovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-capacity-"));
    try {
      const store = await ProtectedWorkStore.open(directory, { maxAdmissionBytes: 1_400, maxHotLedgerBytes: 4_000 });
      const active = record("protected-active", "2026-01-01T00:00:00.000Z", "queued");
      expect(await store.put(active, 0)).toBe(true);
      await expect(store.put({ ...record("protected-refused", "2026-01-01T00:00:01.000Z", "queued"), owner: "claude-sonnet" }, 0)).rejects.toBeInstanceOf(ProtectedWorkCapacityError);
      const recovered = { ...active, revision: 2, phase: "available" as const, stoppedAt: "2026-01-01T00:00:02.000Z", updatedAt: "2026-01-01T00:00:02.000Z", disposition: "no-update" as const };
      expect(await store.put(recovered, active.revision)).toBe(true);
      expect(await (await ProtectedWorkStore.open(directory)).get(active.workId)).toEqual(recovered);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("allows an oversized migrated ledger to shrink but rejects further growth", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-oversized-"));
    try {
      const now = "2026-01-01T00:00:00.000Z";
      const value = { ...record("protected-legacy-oversized", now, "queued"), objective: "x".repeat(2_000) };
      const unsigned = { workId: value.workId, revision: value.revision, at: value.updatedAt, phase: value.phase, recordHash: digest(value), previousHash: null };
      await writeFile(path.join(directory, "protected-work.json"), JSON.stringify({ schemaVersion: 1, records: { [value.workId]: value }, events: [{ ...unsigned, eventHash: digest(unsigned) }] }));
      const policy = { maxAdmissionBytes: 500, maxHotLedgerBytes: 1_000 };
      const store = await ProtectedWorkStore.open(directory, policy);
      const grown = { ...value, revision: 2, updatedAt: "2026-01-01T00:00:01.000Z", blocker: "y".repeat(2_000) };
      await expect(store.put(grown, value.revision)).rejects.toBeInstanceOf(ProtectedWorkCapacityError);
      const shrunk = { ...value, revision: 2, updatedAt: "2026-01-01T00:00:02.000Z", objective: "Review" };
      expect(await store.put(shrunk, value.revision)).toBe(true);
      expect(await (await ProtectedWorkStore.open(directory, policy)).get(value.workId)).toEqual(shrunk);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reserves action receipt capacity for stop and terminal recovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "protected-store-actions-"));
    try {
      const store = await ProtectedWorkStore.open(directory, { maxActionReceipts: 4, actionRecoveryReserve: 2 });
      const actions = [0, 1].map((index) => ({ key: `${index}`.padStart(64, "a"), action: "retry-return" as const }));
      const value = { ...record("protected-actions", "2026-01-01T00:00:00.000Z", "blocked"), actions };
      expect(store.actionReceiptAvailable(value, "retry-return")).toBe(false);
      expect(store.actionReceiptAvailable(value, "stop")).toBe(true);
      expect(store.actionReceiptAvailable(value, "dismiss")).toBe(true);
      const afterStop = { ...value, actions: [...actions, { key: "f".repeat(64), action: "stop" as const }] };
      expect(store.actionReceiptAvailable(afterStop, "stop")).toBe(false);
      expect(store.actionReceiptAvailable(afterStop, "dismiss")).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
