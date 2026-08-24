import { describe, expect, it } from "vitest";
import { CONTINUATION_STATUSES, canTransitionContinuation, normalizeContinuationInboxEntry, normalizeContinuationRecord } from "./continuation-record.js";

describe("continuation record state machine", () => {
  const legal = new Set(["QUEUED>RUNNING", "QUEUED>CANCELLED", "QUEUED>FAILED", "RUNNING>WAITING_TOOL", "RUNNING>BLOCKED", "RUNNING>COMPLETED", "RUNNING>FAILED", "RUNNING>CANCELLED", "WAITING_TOOL>RUNNING", "WAITING_TOOL>BLOCKED", "WAITING_TOOL>FAILED", "WAITING_TOOL>CANCELLED", "BLOCKED>QUEUED", "BLOCKED>FAILED", "BLOCKED>CANCELLED", "COMPLETED>ACKNOWLEDGED", "FAILED>ACKNOWLEDGED", "CANCELLED>ACKNOWLEDGED"]);
  it("implements the complete legal/illegal matrix and terminal immutability", () => {
    for (const from of CONTINUATION_STATUSES) for (const to of CONTINUATION_STATUSES) expect(canTransitionContinuation(from, to), `${from}>${to}`).toBe(legal.has(`${from}>${to}`));
    expect(CONTINUATION_STATUSES.filter((status) => canTransitionContinuation("ACKNOWLEDGED", status))).toEqual([]);
  });
  it("rejects hidden/unbounded or malformed persisted records", () => {
    expect(normalizeContinuationRecord({ schemaVersion: 1, jobId: "x" })).toBeUndefined();
    expect(normalizeContinuationInboxEntry({ schemaVersion: 1, inboxEntryId: "x", summary: "<thinking>secret</thinking>" })).toBeUndefined();
  });
});
