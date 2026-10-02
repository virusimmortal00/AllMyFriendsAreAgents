---
id: hosting-strategy
status: proposed
issue: 114
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

A written recommendation for how this project moves from self-hosted-only to a paid hosted-instance model, including what overlaps with work already planned or in flight (multi-room/remote connections, project/repo scoping) so hosting doesn't get built twice.

# Acceptance checks

- [ ] A doc (or this planning file) states the recommended hosting model (e.g. single shared multi-tenant server vs. per-customer instance) and why.
- [ ] Overlap with [#80](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/80)–[#82](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/82) (room/project identity, repo connections) and [#116](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/116) (multi-room/remote connections) is called out explicitly, with a sequencing recommendation.
- [ ] Rough cost/ops tradeoffs are captured (what changes vs. today's single local Mac Mini server).

# Current state

Discussed at a high level in the Aug 27 architecture sync: open source first, paid hosted instances as the monetization path. No design work has started.

# Next action

Wait on [#116](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/116) (multi-room/remote connections) to land and get real usage before starting hosting design. Per the Aug 27 meeting transcript, this sequencing is explicit, not just a nice-to-have: "you almost have to build [multi-room] first and get those inroads down before you're opening it up to what I think is the real money play with this, which is hosting."

# Evidence

- None yet.

# Open questions

- What's the minimum viable hosted offering — one room, one project, one repo — vs. full multi-tenant from day one?
