---
id: participant-mentions
status: superseded
issue: 5
owner: developer-team-sol
reviewers: [cursor-grok, claude-opus, claude-sonnet]
depends_on: [project-permissions-toggle]
reported_by: crimsonsunset
updated: 2026-08-22
---

# Outcome

Humans can select any current human or agent from an accessible `@` autocomplete. Messages retain a stable target ID and the label/revision selected at send time without forcing the target to answer.

# Acceptance checks

- Typing `@` opens a keyboard- and pointer-accessible participant list.
- Agent targets use stable room participant IDs; human targets use their durable local room IDs.
- Sent messages retain target kind, stable ID, selected label, provider/model snapshot where applicable, revision, and text offsets in JSON and SQLite storage.
- The server rejects forged, stale, or text-mismatched mention metadata.
- Unanswered mentions create no forced turn, spinner, or error state.
- Humans and agents use the same mention record shape.
- The autocomplete remains usable in the mobile composer.

# Current state

Shipped. This file is historical; GitHub is the tracker.

# Next action

None. Landed in [PR #5](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/5) and [PR #7](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/7).

# Evidence

- Focused mention, persistence, migration, component, optimistic-send, and reconnect-persistence tests pass.
- Production TypeScript/Vite build passes (270/270 tests).

# Open questions

- None. A mention is a social signal, not a mandatory response or command.
