---
id: headless-bring-your-own-client
status: proposed
issue: 123
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

A user can drive a room through their own client (e.g. Slack, a custom UI) without using the project's built-in web UI, once that becomes a priority.

# Acceptance checks

- [ ] A documented API/protocol exists for driving a room without the built-in UI.
- [ ] At least one non-built-in client (even a minimal example) can join a room and exchange messages through it.

# Current state

Not started, explicitly deferred. Aug 27 sync: "eventual headless type of mode or bring your own client type of mode... that's probably further down the road... I don't think we get crazy trying to build that quite yet." [PUNT] — tracked so it isn't lost, not active work.

# Next action

None right now. Revisit once the Slack bridge ([#67](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/67)) or MCP bridge ([#106](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/106)–[#112](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/112)) work make the "not a built-in UI" pattern more concrete.

# Evidence

- None yet.

# Open questions

- Does the Slack bridge (#67) end up being a proof-of-concept for this, or a special case that doesn't generalize?
