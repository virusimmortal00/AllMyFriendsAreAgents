---
id: nonexclusive-project-grants
status: proposed
owner: developer-team
reviewers: []
depends_on: [git-security-boundary]
reported_by: crimsonsunset
updated: 2026-08-21
---

# Outcome

Project edit permission is a durable, nonexclusive set of per-agent grants. Changing one agent's grant never silently revokes another agent, while every actual writable run remains bound to an authorized assignment and the current concurrency safety gates.

# Acceptance checks

- Legacy `nobody` and single `writableAgent` state migrate without losing the user's existing intent.
- JSON and SQLite storage persist the same explicit set of granted agent IDs across restart and JSON-to-SQLite import.
- Toggling project access in one agent's settings changes only that agent and removes the obsolete replacement warning.
- Browser mutations require a current joined-human identity; bridge mutations require the appropriate Developer Team capability. Missing, stale, unauthorized, or cross-project context is rejected without changing stored grants.
- The settings API rejects unknown agents, malformed grant payloads, and unsupported state transitions without changing stored grants.
- Reviews always remain read-only, and a stored grant alone cannot bypass an assignment claim, fencing token, execution manifest, verified Git broker, or active-assignment limit.
- Until controlled concurrency is independently accepted, multiple grants may exist but the runner still permits only one active writable assignment.
- Desktop and mobile Agent Settings clearly distinguish durable project grants from current assignment/concurrency availability.
- Migration, storage-contract, restart, API, runner-permission, and responsive UI tests pass.

# Current state

Live dev still stores one exclusive `writableAgent` value. Enabling another agent displays “Enabling this will remove edit access from …” and replaces the previous selection. That behavior accurately describes the old storage model but conflicts with the assignment-scoped concurrency design.

The room agreed this is separate from Git security-boundary task 3.27, may be developed alongside its correction, and is a hard prerequisite for enabling concurrent writers. It is not implemented, merged, or live.

# Implementation approach

- Replace the singular setting with a versioned collection of agent IDs at the shared room-state/storage contract.
- Use a canonical schema with a version number and unique agent IDs in deterministic order. API writes reject unknown IDs; persisted legacy duplicates are normalized during migration.
- Backfill `nobody` to an empty collection and a legacy selected agent to a one-element collection. JSON-to-SQLite import atomically replaces the destination room's grant set rather than merging it; migration and import are idempotent and covered by round-trip and retry tests.
- Require current joined-human context for browser mutations and a dedicated Developer Team capability for bridge mutations. Bind every mutation to the configured project and record the actor without introducing account authentication beyond the existing local-LAN trust model.
- Preserve per-session permission compatibility so a grant/revoke cannot reuse a session created under the wrong permission.
- Update settings mutations to target one agent explicitly and persist atomically.
- Render independent per-agent toggles and show assignment/concurrency gating as status copy rather than destructive grant behavior.
- Keep read-only review resolution authoritative over all stored grants.

# Dependencies and release gate

- Tracking: [GitHub issue #12](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/12).
- Related program: [GitHub issue #9](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/9) and [`9-governed-assignment-workspaces.md`](9-governed-assignment-workspaces.md).
- Predecessor UI: [`project-permissions-toggle.md`](project-permissions-toggle.md).
- Concurrent writers remain disabled until both the corrected Git security boundary and this grant-model change receive independent acceptance.
- Atomic active-assignment claiming and fencing remain owned by the assignment lifecycle/Git-boundary work. This ticket verifies grants cannot bypass those controls; it does not create a second scheduler or lock.
- Merge and deployment continue to require their own later authorization gates.

# Next action

Developer Team should independently review this planning contract, then implement it in this isolated branch without touching the live dev checkout. Verification must cover both JSON and SQLite before the change can be proposed for merge.

# Evidence

- `crimsonsunset` reproduced the exclusive replacement warning in the live room on 2026-08-21.
- Cursor Grok, Cursor Composer, Cursor Gemini, and Codex Terra agreed that durable permission grants must be distinct from assignment scheduling and that this ticket gates concurrency release.
- Live status at planning time: server commit `b688c9f`; this change is absent from live, `main`, and `origin/main`.

# Open questions

- None. Scope, acceptance checks, dependency order, and implementation approach were agreed in the active room.
