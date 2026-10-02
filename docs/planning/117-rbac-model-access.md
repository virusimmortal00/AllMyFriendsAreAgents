---
id: rbac-model-access
status: proposed
issue: 117
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

Room/project owners can grant collaborators different levels of access — e.g. who can pick which models are used, who can trigger agent-conversation rounds, who can only observe — instead of every connected participant having the same access today.

# Acceptance checks

- [ ] At least two distinct roles exist (e.g. owner/observer, or owner/contributor/observer) with enforced differences in what each can do.
- [ ] Model selection/provider configuration is gated behind a role, not open to every participant.
- [ ] Existing single-user/local usage is unaffected when no other collaborators are present (no new friction for the common case).

# Current state

Not started. [#56](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/56) (closed) covers provider/model discovery and configuration, not who is allowed to change it. No role/permission system exists for external participants today.

# Next action

Define the smallest useful role set (likely just owner vs. everyone-else) before designing a full permission matrix.

# Evidence

- None yet.

# Open questions

- Does this need to land before or after multi-room/remote connections ([#116](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/116)) ships? Permissions matter a lot more once strangers can actually connect.
