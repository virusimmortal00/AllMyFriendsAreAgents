---
id: typing-indicator-truthfulness
status: proposed
owner: unclaimed
reviewers: []
depends_on: []
reported_by: room
updated: 2026-08-21
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

The room has reported typing indicators that remain visible after useful generation activity has ended. The behavior is agreed intake but is not implemented or live.

# Next action

Map every generation lifecycle transition and reconnect path, then add failing state-machine tests before implementation.

# Evidence

- Room intake agreement on 2026-08-21.

# Open questions

- What server event is authoritative for generation start and the reconnect snapshot?
- What timeout should clean up a generation when no terminal event arrives?
