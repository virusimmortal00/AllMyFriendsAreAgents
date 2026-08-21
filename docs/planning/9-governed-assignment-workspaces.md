---
id: governed-assignment-workspaces
status: active
owner: developer-team
reviewers:
  - independent-codex-review
depends_on: []
reported_by: agent-room
updated: 2026-08-21
---

# Outcome

Developer agents work in durable, assignment-scoped Git workspaces. The initial
release is an explicitly trusted single-writer prototype; later phases add a
fail-closed Git broker, controlled concurrency, and separate merge and deploy
authorization.

# Acceptance checks

- Persist assignment identity, immutable base and observed head SHAs, branch,
  canonical workspace, lifecycle state, and recovery evidence in JSON and SQLite.
- Keep writable agent processes inside their assignment workspace while reviews
  retain the existing read-only project view.
- Reconcile clean, dirty, missing, merged, and unmerged work after restart without
  deleting dirty or unmerged work.
- Do not expose push, merge, or deploy from the trusted lifecycle.
- Keep concurrent writers disabled until the assignment-scoped Git broker passes
  adversarial path, ref, configuration, hook, remote, and isolation tests.
- Require distinct, immutable authorization and evidence for merge and deployment.

# Current state

The trusted single-writer lifecycle is implemented in an isolated worktree and
independently accepted against its seven recorded criteria. It is not yet merged
or live. The Git security boundary, concurrent scheduler, and downstream gates
remain unimplemented.

# Next action

Developer Team: commit and merge the accepted trusted-lifecycle slice. Start the
Git security-boundary phase only from that landed commit.

# Evidence

- Tracking issue: https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/9
- Focused lifecycle and migration verification: 35/35 tests passed.
- Independent verification: full suite 285/285 and production build passed.
- Independent acceptance found all seven trusted-lifecycle criteria satisfied.

# Open questions

- Which OS-level confinement mechanism should back the writer process on each
  supported self-hosting platform?
- What minimum broker capability/version evidence should unlock concurrent mode?
