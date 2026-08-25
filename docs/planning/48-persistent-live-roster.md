---
id: 48-persistent-live-roster
status: active
owner: developer-team
reviewers: []
depends_on: []
reported_by: Bobbo
updated: 2026-08-24
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

Implementation is isolated on `codex/issue-48-dynamic-roster`. It is not merged and is not running on the live dev server.

# Next action

Complete focused regression coverage, run isolated browser verification, and submit the exact verified commit for independent review.

# Evidence

- Tracking issue: https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/48
- `pnpm build`
- `pnpm test -- --run`

# Open questions

- None within this slice. Adding new executable harness definitions remains a code-reviewed catalog change, not a room mutation.
