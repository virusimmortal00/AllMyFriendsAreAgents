---
id: room-lifecycle
status: done
issue: 81
owner: codex
reviewers: []
depends_on: [80]
reported_by: virusimmortal00
updated: 2026-08-28
---

# Outcome

Rooms are independently addressable, authenticated conversation containers with durable membership, lifecycle, project-attachment audit, fork provenance, and lazily allocated room runtime resources.

# Acceptance checks

- Authenticated membership is resolved from the opaque human session and caller-supplied participant authority is rejected.
- Concurrent rooms isolate transcripts, rosters, sessions, tasks, event streams, presence, and active-generation projections.
- General rooms have no project/repository authority; attachment is revisioned and audited.
- Detach/rebind fails closed after durable project-backed work and forks preserve the source room/project revisions.
- Per-room, global, and provider generation caps and dormant-resource release have focused tests.
- Active and archived room routes preserve readable reconnect state while archived mutation is rejected.

# Current state

Implemented in the focused issue #81 change. JSON remains the documented single-room compatibility backend; additional durable rooms require SQLite.

# Next action

Issue #82 may consume the revisioned room attachment without expanding its context-only authority.

# Evidence

- `server/room-lifecycle.test.ts`
- `server/room-runtime-registry.test.ts`
- `src/room-routing.test.ts`
- `server/storage/sqlite-migrations.test.ts`
- `pnpm test`, standalone TypeScript, production build, planning guardrail, and diff checks on the final reviewed head.

# Open questions

- None.
