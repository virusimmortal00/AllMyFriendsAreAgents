---
id: multi-room-remote-connections
status: proposed
issue: 116
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

A collaborator can point their own MCP client at a room running on someone else's server and participate, without cloning/running the project themselves.

# Acceptance checks

- [ ] A remote client can connect to a specific room by ID on a host server it doesn't own or run.
- [ ] Multiple rooms can run concurrently on one server without cross-talk (message/state isolation).
- [ ] Access to a given room from a remote client is scoped (see [#117](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/117) RBAC) rather than open to anyone who has the URL.

# Current state

Not started as its own effort. Related but distinct work already in flight: [#80](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/80)–[#82](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/82) (durable project/room identities, routing, repo connections) covers internal room/project identity; [#106](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/106)–[#112](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/112) (MCP consultation bridge) covers the IDE-to-room MCP protocol. Neither explicitly covers a collaborator connecting to a room on infrastructure they don't control.

# Next action

Confirmed sequencing from the Aug 27 meeting transcript: [#80](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/80)–[#82](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/82) (room-to-repo connection identity) lands first — "the room needs to be tied to a particular repo... you got to build all the connections there" — then this. The MCP bridge ([#106](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/106)–[#112](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/112)) is the direct technical enabler for the remote-connection half of this ticket. [#114](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/114) (hosting) is explicitly meant to wait until after this ships, not the reverse.

# Evidence

- None yet.

# Open questions

- Auth model for a remote collaborator: per-room invite token, account system, or something else?
