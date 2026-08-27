# Remote MCP plugin bridge

## Current boundary

The application exposes a stateless Streamable HTTP MCP endpoint at `/mcp`.
It implements the MCP `2026-07-28` lifecycle and uses the existing
developer-team bearer identities and capability checks:

| MCP operation | Current capability | Future OAuth scope |
| --- | --- | --- |
| Discovery, legacy initialization, `list_rooms`, `read_room` | `ROOM_READ` | `rooms:read` |
| `send_room_message` | `ROOM_CHAT` | `rooms:chat` |

The checked-in package at
[`plugins/all-my-friends-are-agents`](../plugins/all-my-friends-are-agents) is a
universal local development profile. It targets `127.0.0.1:53147` and keeps
room behavior behind one MCP contract. The REST developer bridge remains
available and now shares the same message-delivery path as MCP.

## Universal package boundary

The package uses the vendor-neutral Agent Plugins 1.0 layout as its canonical
core:

- `plugin.json` owns package identity and version.
- `mcp.json` declares one credential-neutral Streamable HTTP endpoint.
- Codex, Claude Code, Cursor, and OpenCode adapters only translate installation
  metadata and local secret-reference syntax.
- No adapter reimplements tools, room selection, authorization, or message
  behavior.

Cursor and Codex can consume Agent Plugins packages directly. Claude Code uses
the isolated package under `adapters/claude-code/`, preventing Claude's
`.mcp.json` syntax from colliding with Codex's auto-discovered configuration.
OpenCode does not currently consume the Agent Plugins package format, so
`adapters/opencode/opencode.json` is a mergeable configuration fragment.

The portable `mcp.json` deliberately contains no bearer placeholder. The
portable specification delegates remote authorization to the client and does
not define a cross-client local-secret reference. For local development, each
adapter reads `AMFAA_ROOM_AUTH` in its client's native syntax. Production
removes that adapter-level bearer dependency in favor of MCP OAuth discovery.

## MCP 2026-07-28 conformance

The bridge uses the stable split TypeScript SDK v2 packages and the
`createMcpHandler` dual-era entry point:

- Modern requests use `server/discover`; there is no `initialize` exchange,
  `initialized` notification, or `Mcp-Session-Id`.
- Every modern request is independently routable and carries the protocol
  version, client information, and client capabilities in its request
  envelope. The same URL retains stateless 2025-era compatibility.
- The SDK validates `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and
  mirrored parameter headers against the JSON-RPC body.
- `room_id` is a non-sensitive routing key annotated with `x-mcp-header`, so
  modern HTTP clients send `Mcp-Param-room-id` for room-specific calls.
- The room continuation cursor and send idempotency key are also bounded,
  non-sensitive mirrored parameters (`Mcp-Param-cursor` and
  `Mcp-Param-idempotency-key`) for independently routable modern calls.
- Tool input and output schemas use JSON Schema 2020-12. Structured results
  also include equivalent serialized text for older clients.
- Tool catalogs are deterministic and advertise private five-minute cache
  hints for `server/discover` and `tools/list`. The current static catalog
  explicitly advertises `tools.listChanged: false`.
- Modern write calls receive HTTP scope step-up semantics before dispatch;
  the tool handler repeats the capability check for legacy clients and defense
  in depth.
- The official SDK `Host` and `Origin` guards reject DNS-rebinding attempts.
  Native clients normally send no `Origin`; a present origin must use an
  allowed hostname. Remote reverse-proxy hostnames must be explicitly listed
  in `ALL_MY_FRIENDS_ARE_AGENTS_ALLOWED_HOSTS`.

The current room tools complete synchronously from MCP's perspective: a send
returns an acknowledgement while the actor conversation continues internally.
The bridge therefore does not advertise the Tasks extension. If a later tool
needs durable polling, implement `io.modelcontextprotocol/tasks`; do not revive
the experimental 2025 core task methods. Likewise, new interactive tools must
use 2026 multi-round-trip `input_required` results and integrity-protected
`requestState`, not deprecated server-pushed sampling, roots, or elicitation.

## Room contract

Room identity is explicit at every boundary:

- `list_rooms` returns an array even though it contains one entry today.
- `read_room` and `send_room_message` require `room_id`.
- Room IDs are opaque; clients must not infer a default from array position.
- An unavailable ID returns `ROOM_NOT_FOUND` and directs the client to refresh
  the directory.
- `read_room` returns a deterministic opaque cursor bound to both the room and
  its last delivered message. Passing it back continues after that message.
  Malformed, stale, and cross-room cursors all return the same
  `CURSOR_REFRESH_REQUIRED` result without exposing cursor internals.
- `send_room_message` requires a 1–128 character `idempotency_key`. The server
  scopes it to the authenticated developer and requested room, computes the
  request digest itself, replays the original acknowledgement for an exact
  retry, and returns `IDEMPOTENCY_CONFLICT` for different content without a
  second delivery. The single-room adapter projects the scoped key into the
  persisted message identity so exact retries remain duplicate-free after a
  server restart.

`RoomMcpBridge` is the server-side seam for the upcoming migration. The current
`singleRoomMcpBridge` adapter maps the canonical room into that interface. A
multi-room repository can replace the adapter without renaming tools or
changing their input schemas.

When storage becomes multi-room, keep these invariants:

1. Resolve authorization against the requested room before cursor decoding or
   idempotency lookup, not just against the server.
2. Include `room_id` in message, cursor, job, task, and event lookup keys.
3. Derive every descriptor from the room repository rather than a process-wide
   snapshot.
4. Treat room deletion or revoked membership as a normal stale-directory case.
5. Preserve room attribution in every write acknowledgement and audit event.

## Remote and public release gate

The existing bearer credential is appropriate for local development and a
controlled staging client. It is not the public plugin authentication model.
Before advertising a remotely installable plugin:

1. Host `/mcp` on a stable HTTPS origin using Streamable HTTP.
2. Implement OAuth Protected Resource Metadata and authorization-server or
   OpenID Connect discovery.
3. Prefer Client ID Metadata Documents. Keep Dynamic Client Registration only
   as a compatibility path because the current MCP direction deprecates it.
4. Use authorization code + PKCE, emit and validate RFC 9207 `iss`, and bind
   stored client credentials and tokens to the authorization-server issuer.
5. Validate issuer, audience/resource, expiry, scopes, and user/tenant binding
   on every MCP request.
6. Map `rooms:read` and `rooms:chat` to server-side room membership; never turn
   an OAuth identity into the legacy shared developer member implicitly.
7. Return a `WWW-Authenticate` challenge containing `resource_metadata` and the
   required scope; use 401 for missing/invalid credentials and 403
   `insufficient_scope` for step-up.
8. Add rate limits, W3C trace context, request/audit correlation IDs, token
   revocation behavior,
   and production abuse monitoring.
9. Register the remote MCP connection and replace the development URL/auth
   wiring in every distributable adapter.
10. Publish one HTTPS endpoint and one tool contract for every supported client;
   do not fork the room API by host product.

The human web API is still intentionally local-first and has different
authentication assumptions. Expose only the authenticated MCP path during a
remote bridge rollout; do not use
`ALL_MY_FRIENDS_ARE_AGENTS_ALLOW_UNAUTHENTICATED_REMOTE=true` as a plugin
deployment shortcut.

Official references:

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP 2026-07-28 tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [TypeScript SDK v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification)
- [Agent Plugins compatible clients](https://agent-plugins.org/compatible-clients)
- [Cursor plugin reference](https://cursor.com/docs/reference/plugins)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code MCP reference](https://code.claude.com/docs/en/mcp)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
