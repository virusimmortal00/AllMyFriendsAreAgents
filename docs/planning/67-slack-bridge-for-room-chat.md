---
id: slack-bridge-for-room-chat
status: proposed
issue: 67
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-25
---

# Outcome

The room can be bridged to a Slack channel: every human/agent chat message mirrors into Slack, and a Slack user who @-mentions the app becomes a real room participant whose message can trigger an agent-conversation round.

# Acceptance checks

- Slack Events API webhook signature is verified (HMAC over the raw body + timestamp replay window) before any event is processed.
- A first message from a new Slack user auto-creates a persistent room-participant identity (deterministic id derived from Slack team+user id), with no explicit linking step.
- Plain Slack channel messages (`message` events) are mirrored into the room transcript but do not enqueue a conversation round.
- `app_mention` events are mirrored into the room transcript and enqueue a conversation round, same as a browser chat message today.
- Every new room chat message (human, developer-bridge, or agent) mirrors out to the configured Slack channel via `chat.postMessage`, using each speaker's display name as the `username` override.
- Messages that originated from Slack do not echo back into the same Slack channel.
- The bridge is fully feature-gated: with no Slack signing secret/bot token configured, none of this code path is reachable, matching how the GitHub contribution broker is gated.
- The server's existing non-loopback bind guard is untouched; the webhook route's only auth boundary is Slack's request signature, and public reachability is left to an external tunnel/proxy, not a server-side bind change.

# Current state

Not started. Design was ironed out in chat and cross-posted as an addendum on the architecture RFC ([#60](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/60)), since a Slack bridge's identity/scoping needs depend on how rooms end up modeled there.

# Next action

Smallest first slice:
1. `server/slack-signature.ts` — signature + replay verification (pure function, easy to unit test).
2. `server/slack-client.ts` — fetch-based `chat.postMessage` / `users.info` wrapper (no new npm dependency; native fetch covers this).
3. `server/slack-bridge.ts` — lazy identity join via the existing `HumanPresenceRegistry.join(input, resumeId)` path, `app_mention`-gated conversation triggering, egress formatting via `visibleAgentChatText`.
4. `server/slack-api.ts` — raw-body webhook route registered before the global `express.json()` middleware, plus Slack's one-time `url_verification` challenge handshake.
5. Egress wiring: the `broadcast()` wrapper already receives `messages-appended` events from `RoomEventStream`; forward `chat`-kind messages from there rather than touching every message-insertion call site.

# Evidence

- None yet.

# Open questions

- Where should the channel-bridge connection live once multi-room lands: room-scoped (symmetric with how a project owns its repo connection), project-scoped, or a server-wide channel-to-room mapping table? Flagged as open in the #60 addendum, not decided here.
- Socket Mode was considered as an ingress transport (no public URL needed, fits local-first) but Events API webhook was chosen instead; revisit if the tunnel requirement proves painful in practice.
