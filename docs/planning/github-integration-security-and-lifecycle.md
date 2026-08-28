---
id: github-integration-security-and-lifecycle
status: proposed
issue:
owner: unclaimed
reviewers: []
depends_on: [82, 129]
reported_by: room-discussion
updated: 2026-08-28
---

# GitHub integration security and lifecycle

> Temporary architecture note. This defines the security contract for the
> [reusable GitHub integration](github-integration-architecture.md) before work is
> promoted into implementation issues.

## Outcome

The GitHub connection behaves as a server-owned capability with explicit
authorization, encrypted local storage, narrow runtime resolution, predictable
revocation, and no credential exposure to rooms, users, agents, or browsers.

## Trust and authority model

The current product decision is that invitation to a server is an invitation into
the server's code-visibility trust boundary. The server owner is responsible for
inviting only people who may see repository context agents present in rooms they
can access.

This does not make every member a server administrator, project configurator, or
room participant.

| Action | Required authority |
| --- | --- |
| View code or GitHub context already presented in a room | Server member and access to that room |
| Ask an agent to fetch GitHub context | Server member, room membership, effective GitHub-read capability, and a valid inherited project binding |
| Connect, reconnect, or disconnect GitHub | Server owner/admin with integration-configure capability |
| Change the app installation's selected repositories | Authorized GitHub user plus server owner/admin authority for the corresponding server workflow |
| Bind or rebind a project repository | Server owner/admin with project-repository-configure capability |
| Select a repository for an individual room | Never; rooms inherit from projects |
| Mutate GitHub state | Not granted by GitHub-read; requires a separately designed capability and confirmation flow |

The server invitation UI and member-management UI must carry a persistent warning
substantially equivalent to:

> Server members may see private code, pull requests, issues, CI results, and
> other repository context presented by agents in rooms they can access.

## Device-flow lifecycle

```text
disconnected
  -> authorizing
      -> ready
      -> expired/denied -> disconnected
ready
  -> refreshing -> ready
  -> degraded -> refreshing or reauthorization-required
  -> revoked
revoked
  -> authorizing (new flow)
```

### Start

1. An authorized control-plane principal asks the server to start device
   authorization.
2. The server requests a device/user code pair from GitHub using the bundled
   public GitHub App client ID.
3. The UI shows GitHub's verification URL, user code, expiry, and polling status.
4. The server, not the browser, polls GitHub at the required interval.
5. The browser receives only a server-generated flow ID and display-safe device
   flow fields. It never receives the resulting access or refresh token.

Device authorization attempts are short-lived, single-use, bound to the initiating
server principal and server instance, rate-limited, and auditable. Polling stops on
success, denial, expiry, cancellation, or server shutdown.

The client ID is public and does not prove that a device request came from a
legitimate server. The UI must identify the expected GitHub App, show device codes
only inside the authenticated integration flow, and warn administrators never to
approve a code received through chat, email, an agent response, or another server.

### Ready

After token exchange, the server validates the GitHub identity, discovers the
app's installations visible to that user, refreshes the repository catalog, and
stores token material through the credential vault. It commits the public
connection record only after secret storage succeeds.

### Refresh

The provider refreshes before expiry with single-flight coordination so concurrent
room requests do not race token rotation. A refresh token replacement is written
atomically before the old value is discarded. Transient GitHub failures may enter
`degraded`; invalid/revoked credentials fail closed and require reauthorization.

### Disconnect and revocation

Disconnect performs a server-side state transition before any best-effort remote
revocation call. New resolution attempts fail immediately. It then:

- removes token material from the vault;
- invalidates the repository catalog and project binding health;
- invalidates affected GitHub-read caches;
- cancels pending device flows and refreshes;
- records a redacted audit event; and
- reports which projects and rooms are affected without exposing secrets.

GitHub-side revocation, user access loss, app suspension, installation deletion,
or repository deselection is discovered on request failure or catalog refresh and
triggers the same fail-closed behavior at the narrowest affected scope.

## Credential-vault contract

Token persistence is not an environment-variable replacement if it is merely
written as plaintext JSON. The server needs a small, pluggable vault abstraction:

```ts
interface CredentialVault {
  put(record: SecretRecord, expectedRevision?: number): Promise<SecretPointer>;
  get(pointer: SecretPointer): Promise<SecretRecord | undefined>;
  delete(pointer: SecretPointer, expectedRevision?: number): Promise<void>;
}
```

Requirements:

- encrypted at rest with authenticated encryption;
- a locally protected key that is not stored beside ciphertext without an
  explicit deployment warning;
- strict filesystem permissions and no browser-readable API;
- atomic revisioned writes and crash-safe token rotation;
- redacted serialization, inspection, errors, metrics, and audit events;
- backup/restore documentation that treats vault data as credentials;
- an operator-visible health state when the vault is locked or unavailable; and
- provider-independent records so a later hosted broker can replace locally
  stored user tokens without changing project bindings.

The first backend remains an implementation decision. Desktop keychains, host
keyrings, and encrypted server stores have different headless-deployment tradeoffs
and should be evaluated before an issue locks the choice.

## Threats and required controls

### Credential exfiltration

- Tokens and refresh tokens are never placed in a model prompt, tool result,
  transcript, room event, URL, log field, audit payload, exception message, or
  browser response.
- GitHub HTTP authorization headers are constructed only inside the adapter.
- Test fixtures use unmistakably fake tokens and a network mock.
- Redaction tests cover structured values, nested errors, and upstream response
  bodies.

### Device-flow phishing

- Starting a flow requires an authenticated owner/admin action; unsolicited codes
  are never shown on login, invitation, or room surfaces.
- The UI links only to GitHub's canonical device verification origin and states
  which app the administrator should expect GitHub to name.
- Flow IDs are high-entropy server identifiers, bound to the initiating principal,
  and cannot be used to retrieve tokens.
- Approval of a code created elsewhere cannot attach a token to this server's
  locally tracked authorization attempt.
- Rate limits and audit events make repeated device-code generation visible.

### Confused-deputy repository access

- Runtime operations resolve repository identity from room attachment and current
  project connection revision.
- Caller-provided owner, repository, remote, installation, binding, or credential
  identifiers are rejected or ignored at room command boundaries.
- The project binding repository ID must match the verified project's canonical
  remote identity.
- Redirects and GitHub API URLs are allowlisted so tokens cannot be forwarded to
  arbitrary hosts.

### Stale authorization

- Connection, project binding, installation catalog, and policy each carry a
  revision or freshness marker.
- Rebind, deselection, disconnect, membership loss, and policy change invalidate
  cached decisions.
- A stale UI precondition receives a conflict response rather than overwriting a
  newer configuration.

### Identity ambiguity

- A human room session must resolve to one durable server principal before
  `server member` is used as an authorization fact.
- Deactivated principals lose new room and control-plane authorization even if an
  ephemeral room token remains in memory.
- Owner/admin configuration events record the durable principal, not only a
  display name or transient human ID.

### Overbroad GitHub permission

- The public GitHub App requests only permissions needed by implemented read
  operations.
- Initial installation defaults to selected repositories, with an explicit UI
  warning if the installer chooses all repositories.
- Webhooks are disabled until a concrete event-driven feature needs them.
- GitHub writes are not enabled merely because the configuring user or app has a
  broader permission.

### Shared-server disclosure

- Invitation and membership management communicate the server-wide code trust
  boundary before an invitation is finalized.
- Room access continues to protect transcripts and interaction even though
  individual GitHub entitlements are not checked for viewers.
- Agent responses should avoid dumping unnecessary file content; existing result
  size and sensitive-path policies continue to apply.

## Audit events

Audit payloads use stable IDs and metadata, never secret material. At minimum:

- GitHub device authorization started, completed, denied, expired, or cancelled;
- connection refreshed, degraded, reauthorized, disconnected, or revoked;
- installation/repository catalog refreshed and material selection changes found;
- project repository bound, verified, rebound, disconnected, or invalidated;
- GitHub read denied by capability, room/project state, policy, stale revision, or
  connection health; and
- future GitHub mutation requested, confirmed, executed, or denied.

Repository names may themselves be sensitive. Operator logs should support IDs or
redacted names, while the authenticated configuration UI can show names to the
trusted server administrator.

## Mutation boundary

During the device-user phase, GitHub would attribute mutations to the configuring
user. That is unsuitable as an implicit shared-room write identity. The initial
release therefore keeps `/gh` read-only.

A later mutation design must decide:

- whether only owner/admin principals can trigger writes;
- whether a human must confirm every mutation or a bounded class of mutations;
- how the actor and configuring identity appear in audit and GitHub attribution;
- how branch, repository, operation, and rate limits are constrained; and
- whether mutation waits for broker-issued installation tokens.

## Acceptance checks

- Device-flow tokens never cross the server/browser boundary after exchange.
- Token persistence, refresh, and deletion are atomic and tested across restart.
- Connection loss fails closed for every affected project and room.
- A room or model cannot redirect a credential to a different repository or host.
- A removed/deactivated server principal cannot rely on an old room session.
- Invite, member-management, and integration UIs state the server code-visibility
  trust boundary.
- GitHub-read remains read-only even if the app/user token has broader effective
  permissions.
- Audit and diagnostic output is useful without revealing tokens or private
  repository names outside the authenticated operator UI.

## Current state

- The current adapter is allowlisted and read-only, and project/revision/policy
  context participates in authorization and caching.
- Credentials are supplied through process environment and held in memory; there
  is no durable credential-vault implementation or token refresh lifecycle.
- Room human sessions and durable control-plane principals are separate identity
  mechanisms.
- Current tests mock GitHub fetches and use literal fake credentials; no live
  device authorization, refresh, revocation, restart, or installation-selection
  evidence exists.

## Next action

Resolve the vault backend and canonical-principal prerequisites, then use
[the delivery plan](github-integration-delivery-plan.md) to open narrowly scoped
issues with security acceptance checks copied into each slice.

## Evidence

- `server/project-repository-connection.ts`
- `server/room-bound-github-read.ts`
- `server/room-bound-github-read.test.ts`
- `server/human-session.ts`
- `server/control-plane.ts`
- `docs/operations/capabilities-and-logging.md`
- [GitHub: Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub: Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GitHub: OAuth app security guidance for device-flow public clients](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)

## Open questions

- Which vault backend works across desktop, headless Linux, containers, and backup
  restore without reintroducing mandatory environment secrets?
- Must all server members be able to access all rooms, or only see repository
  context in rooms to which they are admitted? This note assumes the latter.
- What is the acceptable maximum catalog staleness before a fetch forces refresh?
- Should private repository names be visible to every server member in project or
  room navigation, or only when presented in an accessible room?
