---
id: notify-ide-agent-review
status: proposed
issue: 124
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

When a room surfaces something that needs a human/IDE-agent's attention (e.g. after reviewing a merged PR), the IDE agent finds out without the human having to remember to check the room.

# Acceptance checks

- [ ] Some mechanism exists for a room to signal "this needs attention" outside the room's own chat.
- [ ] Cursor (or another IDE harness) can receive or check that signal without the human manually re-opening the room.

# Current state

Not started, explicitly deferred. Aug 27 sync: "that's kind of like a feature that I like probably don't need to solve yet." No mechanism decided — options floated were a webhook into Cursor, or having Cursor poll/check a notifications endpoint as part of its own workflow. [PUNT] — tracked so it isn't lost, not active work.

# Next action

None right now. Likely follows naturally once a room-side PR-review-trigger implementation (adjacent to [#83](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/83)/[#84](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/84)) exists to notify from.

# Evidence

- None yet.

# Open questions

- Webhook push vs. Cursor-side polling — no strong opinion expressed in the meeting either way.
