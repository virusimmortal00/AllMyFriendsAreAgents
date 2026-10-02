---
id: topic-branching-context-rot
status: proposed
issue: 119
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

When a room conversation drifts onto a new topic, it can be forked into a new room/thread so a late-joining participant gets a topic-scoped summary instead of the entire prior transcript, keeping context manageable as rooms run long.

# Acceptance checks

- [ ] A conversation can be split into a new room/thread at a chosen point, with the new room scoped to that topic going forward.
- [ ] A participant joining a topic-branched room gets a summary of just that topic, not the full parent-room history.
- [ ] The parent room retains its own history unaffected by the fork.

# Current state

Not started. Flagged as a known challenge in the Aug 27 architecture sync. [#89](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/89) (closed) solved per-agent context delivery via delta cursors + cold-start summary, but that's about efficient delivery of one room's existing history — it doesn't address splitting a long-running room into topic-scoped sub-rooms.

# Next action

Depends on multi-room support ([#116](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/116)) landing first — branching a topic into "a new room" needs multiple rooms to exist as a concept before this is buildable.

# Evidence

- None yet.

# Open questions

- Is branching manual (someone explicitly forks) or does something try to detect topic drift automatically?
- How does search/reference back into the parent room work once branched?
