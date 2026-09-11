---
id: protected-work-retention
status: active
issue: 176
updated: 2026-09-10
---

# Outcome

Protected-work history has a bounded storage lifecycle without sacrificing
active-work recovery, retained request idempotency, or audit verification.

# Acceptance checks

- Keep terminal records hot for 30 days, subject to a 256-record ceiling.
- Bound new action receipts at 64 per record, reserving two receipt slots for
  stop and terminal recovery after retry admission is exhausted.
- Compact each live record's audit history after 32 events to a verifiable
  boundary event and retain the following chain.
- Refuse new work when the hot ledger reaches 6 MiB while reserving a further
  2 MiB for active stop, acknowledgement, and terminal recovery mutations.
- Move expired or excess terminal records to a separately bounded 16 MiB
  archive. Compact its oldest detailed entries into a chained checkpoint.
- Migrate the version 1 ledger to version 2 atomically and without dropping
  records or events during migration.

# Current state

The version 2 JSON ledger separates hot records from archived terminal records.
Retained archive entries contain the complete final record, compacted audit
anchor, and retained audit events, so request replays and chain verification
survive restart and archival. When the archive reaches its
byte budget, its oldest detail is replaced by a cumulative checkpoint whose
hash is the predecessor of the first retained archive entry. This preserves
verification of the remaining chain while making the replay window explicitly
bounded.

Maintenance is transactional with the next protected-work mutation. Active
records are never selected for archival. A full admission budget rejects only a
new record; existing records can use the recovery reserve. Retry receipts stop
before the two recovery slots, and existing version 1 receipt arrays are
grandfathered instead of being truncated during migration. Full archive
verification occurs at startup; subsequent writes verify only their new audit
event, archive entries, checkpoint boundary, and persisted byte accounting.

# Next action

Run focused protected-work tests and the repository quality gate. Keep the
experimental investigation lane disabled by default until its separate executor
requirements are satisfied.

# Evidence

- `server/protected-work-store.ts`
- `server/protected-work-store.test.ts`
- `server/protected-work-service.test.ts`
- `docs/operations/protected-work-retention.md`

# Open questions

None. The detailed replay window is the lesser of the 30-day hot duration and
the retained portion of the 16 MiB archive; older compacted identities are not
eligible for replay and a reused request identity is treated as a new request.
