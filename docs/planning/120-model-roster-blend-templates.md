---
id: model-roster-blend-templates
status: proposed
issue: 120
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

A room owner can define a preferred mix of models for that room (e.g. "always include one OpenAI model," "cycle through this list weekly") and save/reuse that mix as a template across rooms, rather than manually picking models each time.

# Acceptance checks

- [ ] A room can be configured with a named roster/template defining which models fill which slots.
- [ ] Templates can be saved and applied to more than one room.
- [ ] Existing single-model/manual room setup still works unchanged when no template is used.

# Current state

Not started. [#56](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/56) (closed) covers discovering and configuring providers/models; it doesn't cover saving reusable named blends/rosters per room.

# Next action

Define what a "slot" means (role-based like facilitator/challenger from [#106](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/106)–[#112](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/112), vs. just a flat list of N models) before building storage/UI for it.

# Evidence

- None yet.

# Open questions

- Does this connect to the room-role work already in #106–#112 (facilitator/contributor/challenger/scribe), or is it a separate, simpler "which models are in this room" concept?
- Self-improving/auto-tuned blends ("quantify what good looks like and have it retrain itself") was floated as a stretch idea — explicitly out of scope for a first pass.
