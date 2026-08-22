---
id: typing-indicator-truthfulness
status: superseded
issue: 25
owner: unclaimed
reviewers: []
depends_on: []
reported_by: room
updated: 2026-08-22
---

# Outcome

The room shows an agent as typing only while that agent has at least one active generation.

# Acceptance checks

- Derive typing state from a set of active generation IDs, not queue or presence state.
- Add an ID only when generation starts.
- Remove it on completion, cancellation, failure, supersession, timeout, and disconnect cleanup.
- Replace local state with the authoritative reconnect snapshot.
- Cover overlapping generations, provider cooldown, abandoned turns, late completion after supersession, and reconnect with no phantom typing.

# Current state

Promoted to [#25](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/25). This file is historical.

# Next action

Do the work on #25. Do not update this file except to record evidence after close.

# Evidence

- Room intake agreement on 2026-08-21.

# Open questions

- What server event is authoritative for generation start and the reconnect snapshot?
- What timeout should clean up a generation when no terminal event arrives?
