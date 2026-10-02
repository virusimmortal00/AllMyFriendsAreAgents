---
id: discuss-to-owner-phase
status: proposed
issue: 121
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

When a participant is tagged as the owner of a task, the room enters an "owned" state where other participants no longer chime in with unsolicited responses on that task, distinct from today's mentions which are purely a social signal with no effect on who responds.

# Acceptance checks

- [ ] Tagging a participant as the owner of a task is a distinct action from a plain @-mention.
- [ ] Once a task has an owner, other participants' unsolicited responses on that task are suppressed or visibly separated from the owner's work.
- [ ] The room can still hold an open "let's discuss" phase before an owner is assigned, where anyone can respond.

# Current state

Not started. [#5](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/5) (shipped, see `participant-mentions.md`) intentionally made mentions "a social signal, not a mandatory response or command" — the opposite problem (suppressing unwanted responses once someone owns a task) was left unsolved.

# Next action

Scope the smallest version — probably just a room-level "task has an owner" flag that changes how the room surfaces other participants' replies, not a full workflow engine.

# Evidence

- None yet.

# Open questions

- Is a task the same concept as an assignment ([#9](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/9)'s governed assignment workspaces), or a lighter-weight conversational-only concept?
