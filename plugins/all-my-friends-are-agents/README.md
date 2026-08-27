# All My Friends Are Agents plugin

This package has one portable MCP contract, one canonical consultation skill,
and thin configuration adapters for Codex, Claude Code, Cursor, and OpenCode.
No host adapter implements room behavior; every client reaches the same
Streamable HTTP server and receives the same `list_rooms`, `read_room`, and
`send_room_message` tools.
The same catalog also exposes explicit `start_room_consultation`,
`get_room_consultation`, `respond_to_room_consultation`, and
`cancel_room_consultation` tools when the server's durable consultation service
is enabled.

The endpoint implements MCP `2026-07-28` through the stable TypeScript SDK v2
entry point. Modern clients use sessionless `server/discover` negotiation and
per-request metadata; the same URL retains stateless support for 2025-era
clients while Codex, Claude Code, Cursor, and OpenCode adopt the new revision.

## Package layout

| Path | Consumer | Purpose |
| --- | --- | --- |
| `plugin.json`, `mcp.json` | Agent Plugins 1.0 clients | Vendor-neutral package identity and MCP transport |
| `.codex-plugin/plugin.json`, `.mcp.json` | Codex / ChatGPT | Codex presentation metadata and local bearer reference |
| `adapters/claude-code/` | Claude Code | Isolated Claude plugin package and environment-expanded bearer header |
| `.cursor-plugin/plugin.json`, `cursor.mcp.json` | Cursor | Cursor variables UI and MCP connection |
| `adapters/opencode/opencode.json` | OpenCode | Config fragment using OpenCode's MCP dialect |
| `skills/room-consultation/SKILL.md` | All clients | Canonical safe consultation behavior contract |
| `adapters/*/skills/room-consultation/SKILL.md` | Host skill discovery | Thin pointer to the canonical contract |

The portable `mcp.json` intentionally contains no credential. Agent Plugins
1.0 leaves authorization discovery and secret storage to each client. The
checked-in client adapters provide today's local bearer-token development
path. Once the server exposes production MCP OAuth, the portable core becomes
the preferred install surface and the local bearer fields can be removed.

## Local development credential

Give the server and the client process the same random credential:

```bash
export AMFAA_ROOM_AUTH="$(openssl rand -hex 32)"
export ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN="$AMFAA_ROOM_AUTH"
pnpm start
```

Never commit or paste the resulting value into a manifest. Codex and Claude
Code must inherit `AMFAA_ROOM_AUTH`. Cursor prompts for it through the plugin's
variables UI. OpenCode reads it through `{env:AMFAA_ROOM_AUTH}`.

For Claude Code, install `adapters/claude-code/` as the plugin directory. It is
kept separate so Claude's `.mcp.json` dialect is never auto-discovered by
Codex. For OpenCode, merge the `mcp` member from
`adapters/opencode/opencode.json` into the user's or project's existing
`opencode.json`; do not replace unrelated configuration.

## Consultations

Use the canonical [`room-consultation` skill](skills/room-consultation/SKILL.md)
after installing the matching adapter. It deliberately defaults to *handoff*:
ask the room for an independently produced artifact, then consume and locally
verify it. Active participation is an explicit, bounded option for cases where
the requester asks for a short, controlled dialogue.

Always call `list_rooms` and select the returned opaque `room_id`; a user may
belong to multiple rooms, and neither a cached ID nor a guessed singleton is
safe. Keep the `room_id`, `consultation_id`, revisions, and each mutation's
idempotency key in local task state for every retry. A completed consultation
is input to local judgment, not an authority: verify recommendations against
the repository and requirements, record material dissent, and state residual
uncertainty before acting.

Consultations are not a credential-transfer mechanism, a repository dump, an
unbounded autonomous delegation channel, or a substitute for local review.
Exclude credentials, tokens, private data, personal data, and unrelated
repository-wide context by default. Share the smallest redacted context that
answers the question.

Always select the opaque `room_id` returned by `list_rooms`. The current server
returns one room, but multi-room clients must not cache or infer a singleton room.
Modern Streamable HTTP clients mirror `room_id` as `Mcp-Param-room-id`, allowing
gateways to route, meter, and authorize rooms without parsing request bodies.
They also mirror the opaque continuation `cursor` and bounded
`idempotency_key`. Clients should continue reads with the cursor returned by
`read_room` and retry sends with the same key and unchanged message content.

Consultation clients must always retain the explicit start/poll/respond/cancel
flow. A negotiated Tasks extension may project the consultation ID as a task,
and negotiated modern form input may fulfill a blocking response in a signed
multi-round-trip exchange, but both are optional enhancements. Use the current
revision returned by polling for every response or cancellation and reuse a
mutation idempotency key only with byte-equivalent intent.

This localhost package is not the public release configuration. Before
publishing, replace every development URL with one stable HTTPS MCP endpoint
and enable native MCP OAuth discovery. Do not distribute a shared developer
bearer token. See
[`docs/remote-mcp-plugin.md`](../../docs/remote-mcp-plugin.md) for the rollout
boundary. Remote releases also need production authorization, rate limits,
retention controls, and an explicit compatibility test across supported client
versions; this package's localhost bearer flow is development-only.
