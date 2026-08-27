---
id: 107-durable-room-consultations
status: active
issue: 107
owner: developer-team
reviewers: []
depends_on: [106]
reported_by: Bobbo
updated: 2026-08-27
---

# Outcome

Every consultation transport and client can rely on one versioned, durable,
room-scoped domain. Active and terminal consultations retain their request,
roles, provenance, lifecycle history, and structured result across JSON and
SQLite reconstruction.

# Acceptance checks

- Opaque `roomId` plus `consultationId` is the full identity; neither component
  may be defaulted, inferred, or omitted.
- `queued`, `discussing`, `input_required`, `complete`, `failed`, and
  `cancelled` transitions are revision checked. Every accepted transition
  records its prior and next state, timestamp, actor, and non-empty reason.
- A room-scoped idempotency key is at most 128 bytes. Reuse replays only the
  same consultation ID and canonical SHA-256 request digest; conflicting reuse
  is rejected and cannot overwrite the immutable request.
- Persistent participant affinities are keyed by room and captured as a
  consultation-start snapshot. Facilitator, contributor, challenger, and
  scribe duties are temporary, traceable assignments with release history.
- Completion requires a versioned artifact containing synthesis,
  recommendations, evidence, blockers, dissent, provenance, and completion
  metadata.
- JSON, SQLite, migration, and shared repository-contract tests reconstruct
  active and terminal records and prove cross-room lookup, list, event,
  affinity, identity, and idempotency isolation.

# Current state

The version-one domain, repository contract, JSON and SQLite adapters, SQLite
and PostgreSQL migrations, and contract coverage are implemented in the issue
#107 worktree. Transport and consultation UI behavior remain intentionally out
of scope for this foundation.

# Next action

Integrate the repository boundary with the consultation transport in the next
bounded child issue after #107 review.

# Evidence

- Tracking issue: https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/107
- Parent issue: https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/106
- `pnpm test -- --run shared/consultation-domain.test.ts server/storage/consultation-repository.contract.test.ts server/storage/sqlite-migrations.test.ts`
- `pnpm build`
- `pnpm check:planning-docs`

# Multi-room invariants

1. Room identity is data, never ambient process state. All point reads and
   event reads require both IDs; all list and affinity reads require a room ID.
2. Database primary keys, unique idempotency constraints, and lookup indexes
   begin with `room_id`. The same consultation ID, participant ID, and
   idempotency key may safely exist in different rooms.
3. Affinities cannot cross rooms when captured, and reconstructed projections
   retain the original room ID in the projection and every event.
4. A request or event from one room must never satisfy, conflict with, or appear
   in an operation scoped to another room.

# Open questions

- None within the domain and persistence foundation. Transport-specific access
  control and bounded participant selection belong to follow-up issues.
