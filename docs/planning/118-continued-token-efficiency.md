---
id: continued-token-efficiency
status: proposed
issue: 118
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

Token spend per useful room turn keeps dropping from where [#71](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/71) left it; "wasted on unused output" tokens (mentioned as 50%+ as of the Aug 27 sync) are measured and reduced further.

# Acceptance checks

- [ ] A concrete before/after metric exists (e.g. tokens per turn, or % of generated tokens that were never surfaced/used) comparing current state to a baseline taken after #71 shipped.
- [ ] At least one further reduction lands (e.g. tighter context assembly, avoiding redundant per-agent context, trimming oversized prompts further) with the metric improving.

# Current state

#71 (closed) already cut broadcast/prompt-driven token burn. The Aug 27 sync flagged that over 50% of tokens are still wasted on unused outputs — this is a continuation, not a regression.

# Next action

Instrument or re-check current token-per-turn / wasted-output numbers to get a real baseline before picking the next optimization.

# Evidence

- None yet.

# Open questions

- Is "unused output tokens" mainly about agents generating output that never gets read by anyone (dead responses), or about oversized context windows? These have different fixes.
