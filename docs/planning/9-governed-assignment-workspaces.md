---
id: governed-assignment-workspaces
status: active
issue: 9
owner: developer-team
reviewers: []
depends_on: []
reported_by: issue-9
updated: 2026-08-24
---

# #9: Governed assignment-scoped developer workspaces

**Status**: Implemented through Phase 2 — concurrency and landing gates still open
**Ticket**: [#9](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/9) — “Build governed assignment-scoped developer workspaces”
**Branch**: `main` for Phase 1; each follow-on uses an isolated task worktree
**Base**: `main`

---

## Overview

The application can now persist and recover one trusted writable-agent assignment
in its own Git worktree. Before PR #10, writable processes ran against the selected
project path and assignment state had no durable workspace boundary.

Concretely, this ticket:

- keeps the shipped trusted single-writer lifecycle recoverable across restarts;
- adds a fail-closed, assignment-scoped Git broker before allowing concurrency;
- adds durable exclusive workspace ownership for concurrent assignments; and
- keeps merge and deployment behind distinct, immutable authorization gates.

**What this is NOT:**

- a claim that ordinary Git worktrees are a security boundary;
- permission for developer writers to push, merge, publish, or deploy; or
- automatic cleanup of dirty, missing, conflicted, or unmerged work.

**Dependency chain:**

```text
Phase 1: trusted single writer — shipped
  ↓
Phase 2: adversarial Git boundary — implemented, pending independent acceptance
  ↓
Phase 3: broker-gated concurrent writers
  ↓
Phase 4: independently authorized merge and deployment
```

The trusted single-writer lifecycle remains the default. The Phase 2 broker and
confined launch path activate only through the explicit
`assignment-git-broker/v1` capability. Concurrency remains disabled, and explicit
reviews continue through the existing read-only adapter.

## Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | What owns writable isolation? | One durable workspace per assignment, not per agent. | An assignment is the recoverable unit of provenance and review; an agent identity can work on different assignments over time. |
| 2 | Can the first slice enable concurrency? | No. Ship it as an explicitly trusted, single-writer prototype. | Ordinary linked worktrees share Git metadata and cannot safely isolate concurrent or untrusted writers. |
| 3 | What happens to incomplete work during cleanup? | Preserve dirty, missing, conflicted, and unmerged records and paths. | Recovery evidence is more important than automatic disk cleanup. |
| 4 | What unlocks concurrent writers? | A fail-closed broker that passes adversarial boundary tests. | Path separation alone does not prevent ref, config, hook, remote, credential, or cross-worktree mutation. |
| 5 | Who may land or deploy changes? | Neither operation belongs to the developer-writer capability; each gets a separate exact-commit gate. | Review, merge, and deployment are distinct decisions with different authority and failure modes. |

## Scope

**In:**

- JSON and SQLite assignment records and migration;
- assignment branch/worktree creation from an immutable manifest-bound base;
- writable-process cwd selection and preserved read-only review behavior;
- restart reconciliation and conservative cleanup;
- an assignment-scoped Git broker and confined writer startup;
- durable workspace leases for controlled concurrency; and
- separate merge and deployment decisions tied to immutable commits.

**Out:**

- general-purpose sandboxing for arbitrary untrusted code — this ticket confines the documented developer-writer path only;
- automatic publication or deployment — explicitly prohibited by this design; and
- private/shared Markdown agent workspaces — tracked separately in [#1](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/1).

## Architecture

```text
developer identity + fenced claim + execution manifest
                         │
                         ▼
              durable assignment record
              base / branch / head / path
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
 trusted single-writer          verified Git broker
 (current rollback mode)        + confined writer
                                      │
                                      ▼
                            durable workspace lease
                                      │
                                      ▼
                          independent review evidence
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                    merge gate               deploy gate
```

Enforcement belongs at assignment creation, writer startup, and every brokered Git
operation. Failure to prove identity, ownership, manifest freshness, canonical
path, or broker capability fails closed. Explicit reviews continue through the
existing read-only source-control adapter.

## Files to create / modify

| File | Change |
|---|---|
| [`server/assignment-record.ts`](../../server/assignment-record.ts) | Persisted assignment, lifecycle, recovery, and prototype metadata contract. |
| [`server/assignment-lifecycle.ts`](../../server/assignment-lifecycle.ts) | Trusted creation, governance checks, reconciliation, and conservative cleanup. |
| [`server/assignment-lifecycle.test.ts`](../../server/assignment-lifecycle.test.ts) | Real-Git lifecycle, restart, concurrency-gate, and preservation coverage. |
| [`server/agent-runner.ts`](../../server/agent-runner.ts) | Select the assignment cwd only for writable execution. |
| [`server/index.ts`](../../server/index.ts) | Startup reconciliation and authenticated assignment endpoints. |
| [`server/room-store.ts`](../../server/room-store.ts) | Atomic JSON assignment persistence. |
| [`server/storage/room-repository.ts`](../../server/storage/room-repository.ts) | Shared assignment-store contract. |
| [`server/storage/sqlite-room-repository.ts`](../../server/storage/sqlite-room-repository.ts) | SQLite assignment persistence. |
| [`server/storage/migrations/sqlite/0007_assignment_lifecycle.sql`](../../server/storage/migrations/sqlite/0007_assignment_lifecycle.sql) | Assignment schema and uniqueness constraints. |
| [`server/storage/import-json-to-sqlite.ts`](../../server/storage/import-json-to-sqlite.ts) | JSON-to-SQLite assignment backfill. |
| [`server/git-security-boundary.ts`](../../server/git-security-boundary.ts) | Assignment-scoped operation broker, claim/path/ref validation, serialization, and hash-chained audit. |
| [`server/git-broker-server.ts`](../../server/git-broker-server.ts) | Token-authenticated Unix-socket endpoint and narrow Git shim. |
| [`server/writer-confinement.ts`](../../server/writer-confinement.ts) | Attested fail-closed macOS/Linux writer confinement. |
| [`server/git-security-boundary.test.ts`](../../server/git-security-boundary.test.ts) | Real-Git adversarial broker, ingress, and confinement coverage. |

Existing migration, import, developer-team, and runner test files are modified with
the corresponding contract coverage. The Phase 3 and Phase 4 file inventory will
be added when those designs lock; no placeholder files are created.

## Phasing

### Phase 1: Trusted single-writer lifecycle — Done ✅

- Persist complete assignment and recovery evidence in JSON and SQLite.
- Create a unique branch/worktree at an immutable, manifest-bound base.
- Route only writable generations to the assignment cwd.
- Reconcile restart state and preserve dirty or unmerged work.
- Expose trusted/single-writer metadata and no publication operation.

**Outcome:** PR #10 is merged and live at `b688c9f`; the rebased full suite passes
287/287 tests, the production build passes, and an independent reviewer accepted
all seven recorded criteria.

### Phase 2: Assignment-scoped Git security boundary — Implemented, pending independent acceptance

- Bind broker requests to assignment identity, branch, base, head, path, claim,
  manifest, and developer-team revision.
- Confine writer startup so unrestricted Git is unavailable.
- Reject path escape, live-checkout access, cross-assignment access, mutable refs,
  configuration, hooks, remotes, credentials, and option/environment bypasses.
- Prove protected state remains unchanged under adversarial attempts.

**Outcome:** The broker exposes only status, diff, stage, and commit; revalidates
developer identity, persisted claim/manifest fencing, canonical repository and
workspace identity, branch, base, and observed head for every serialized
operation; and writes hash-chained results including malformed and unauthenticated
ingress. Writer startup attests the Unix socket, owner/mode, shim digest, tokenized
liveness, and current manifest before macOS or Linux confinement starts. The
worktree `.git` pointer and direct Git executable are hidden or denied inside the
writer, closing replacement and copy-and-run bypasses. The trusted single-writer
mode and read-only review path remain available.

### Phase 3: Controlled concurrent writers

- Require the verified broker capability before starting concurrent writes.
- Persist exclusive per-workspace leases and serialize assignment-local Git work.
- Recover cancellation, crash, and partial broker failure without reassignment or
  deletion of incomplete work.

**Outcome:** Independent assignments can edit and commit simultaneously without
cross-workspace or shared-Git-state mutation, and disabling the broker prevents new
concurrent writers.

### Phase 4: Separate landing and deployment gates

- Match persisted, reviewed, and broker-verified heads before merge eligibility.
- Consume merge approval only for its exact assignment, source head, and target base.
- Record the resulting immutable merge commit without triggering deployment.
- Require a separate deployment approval for that exact merged commit and environment.

**Outcome:** Unauthorized, stale, replayed, substituted, or out-of-order merge/deploy
attempts fail closed; successful merge and deployment remain separately auditable.

## Key files referenced

| File | Role |
|---|---|
| [`server/source-control-adapter.ts`](../../server/source-control-adapter.ts) | Existing read-only review boundary that must remain unchanged in capability. |
| [`server/developer-team.ts`](../../server/developer-team.ts) | Immutable member revisions, roles, and capabilities used by assignment governance. |
| [`server/developer-bridge.ts`](../../server/developer-bridge.ts) | Fenced claims and execution manifests reused by assignment authorization. |
| [`server/project-permissions.ts`](../../server/project-permissions.ts) | Existing project-write toggle and agent selection. |
| [`docs/planning/project-permissions-toggle.md`](project-permissions-toggle.md) | Prior planning record for the write-selection mechanism this ticket extends. |

## Implementation notes

### 2026-08-21 — Phase 1 reconciliation

Phase 1 landed as `AssignmentLifecycleService` rather than the earlier room draft’s
standalone worktree helper. This keeps governance and both supported storage
backends in one contract. The service physically removes nothing during cleanup;
it only refreshes durable evidence. An overlapping room-agent draft was preserved
unchanged as stash `0266f87e3b76b762f79f7b176cf6abb387a77a47` and was not mixed into PR #10.

## Related documentation

- [Issue #9](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/9) — canonical tracker and phase checklist.
- [Project permissions toggle](project-permissions-toggle.md) — immediate predecessor for selecting one writable agent.
- [Issue #1](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/1) — separate private/shared Markdown workspace proposal.

_Created: 2026-08-21_
_Planning session: traced the existing developer-team, claim/manifest, runner, storage, and read-only source-control paths and incorporated the agent-room threat-model decisions._
_Last reconciled: 2026-08-21 (Phase 2 rebased onto `origin/main` at `9210c0f`)_
