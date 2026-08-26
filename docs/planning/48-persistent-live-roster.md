---
id: 48-persistent-live-roster
status: done
issue: 48
owner: developer-team
reviewers: [coderabbit]
depends_on: []
reported_by: Bobbo
updated: 2026-08-25
---

# Outcome

Joined humans can add, remove, enable, disable, and reorder previously integrated agent/provider/model combinations from the room UI. The roster changes immediately without a server restart, survives JSON or SQLite restarts, and Gemini Pro is no longer in the default roster.

# Acceptance checks

- The server exposes an authenticated, revisioned roster projection and immutable supported catalog.
- Mutations reject unknown agents, arbitrary commands, duplicate entries, stale revisions, and unauthenticated callers.
- JSON and SQLite preserve ordering and enabled state, including an empty roster, and migrate the prior default without Gemini Pro.
- Removing or disabling an agent clears its session and write authority, terminates active work, clears typing state, and fences late delivery.
- Conversation ranking, mentions, actions, availability, People counts, and task-participant validation use the current enabled roster.
- The responsive dialog supports add/remove, enable/disable, ordering, keyboard operation, conflict recovery, and draft preservation.
- Full tests, production build, independent review, and an isolated browser smoke pass before merge; live SQLite canary follows merge.

# Current state

Shipped to `origin/main` and the live dev server at merge commit `db6b7fbfdae8eac48bc7ba8a542002a9b8d8a40f`. The live SQLite room is on schema migration 13 with the six-agent default, Gemini Pro excluded by default, `codex-sol` write authority preserved, and the room idle after deployment.

# Next action

Monitor issue #48 for follow-up defects. New executable harness definitions remain separate code-reviewed catalog work.

# Evidence

- Tracking issue: https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/48
- Feature PR: https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/50
- Legacy migration hotfix: https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/51
- `pnpm test -- --run`: 488 passed, one platform-specific skip after the migration hotfix.
- `pnpm build` and `git diff --check` passed.
- Final CodeRabbit CLI reviews raised zero issues on both the feature and migration hotfix commits.
- Isolated SQLite desktop/mobile browser canary passed add, disable, save, active-generation cancellation, responsive layout, and restart persistence.
- A copy of the pre-promotion live SQLite database passed migration 13 with all messages and write authority preserved; live integrity check passed after deployment.

# Open questions

- None within this slice. Adding new executable harness definitions remains a code-reviewed catalog change, not a room mutation.
