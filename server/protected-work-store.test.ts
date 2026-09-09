import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ProtectedWorkStore, type ProtectedWorkRecord } from "./protected-work-store.js";

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
