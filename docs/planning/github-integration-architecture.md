---
id: github-integration-architecture
status: proposed
issue:
owner: unclaimed
reviewers: []
depends_on: [82, 129]
reported_by: room-discussion
updated: 2026-08-28
---

# Reusable GitHub integration architecture

> Temporary architecture note. This records a direction for review and issue
> slicing; it does not commit the project to implementation scope.

## Outcome

A self-hosted server can connect to one reusable public GitHub App through the
GitHub OAuth device flow. A server owner or administrator completes the flow in
the UI, chooses repositories made available to the app installation, and binds
projects to those repositories. Rooms inherit their project's repository and
never own or receive GitHub credentials.

This removes per-room personal access tokens and environment-variable setup from
the normal developer experience while preserving the room-bound authority model
implemented by [#82](82-project-repository-connections.md) and
[#129](129-room-bound-github-read.md).

## Decisions

1. **The server owns the GitHub connection.** OAuth tokens, refresh state,
   installation metadata, and the accessible repository catalog live at server
   scope.
2. **A project selects one repository.** The project stores a verified binding
   to an entry in the server catalog and to its local checkout. It does not own
   a token.
3. **A room inherits from its project.** A project-backed room cannot select a
   different repository or credential. A general room has no GitHub authority.
4. **Server membership is the human read-visibility trust boundary.** A person
   invited to the server may see private repository material that agents present
   in rooms they can access. Individual GitHub entitlement is not re-evaluated
   for each viewer.
5. **Agent fetch authority remains narrower than visibility.** A request must
   come through an accessible room with the effective GitHub-read capability and
   a valid project repository binding before the server may fetch from GitHub.
6. **Writes are a separate authority.** The initial integration supports the
   existing read-only `/gh` surface. Mutations require separate capabilities,
   confirmation, policy, and attribution design.
7. **The first credential provider is direct device flow.** The self-hosted
   server talks directly to GitHub and stores the resulting user access and
   refresh tokens locally. The public client ID is not treated as a server
   identity or secret. No managed broker is required.
8. **A future hosted broker is a provider substitution.** It may hold the GitHub
   App private key and mint short-lived installation tokens without changing the
   server/project/room contract.
9. **Webhooks are out of the initial path.** Read operations are request-driven;
   catalog refresh can be explicit or periodic. This avoids requiring an
   internet-reachable self-hosted callback endpoint.

## Containment model

```text
Server
├── durable principals and memberships
├── GitHub connection(s)
│   ├── encrypted token material
│   ├── installation/account metadata
│   └── accessible repository catalog
└── Projects
    └── Project repository binding (one initially)
        ├── selected GitHub repository identity
        ├── verified local checkout identity
        └── non-secret credential binding reference
            └── Rooms attached to the project
                ├── inherited repository status
                └── agent GitHub-read capability
```

Joining a server does not grant a room membership or permit a command in that
room. It does mean that server members are trusted with code or repository
context that agents legitimately include in rooms the member can access.

## Proposed domain model

The names below are descriptive, not locked API names.

### Server GitHub connection

```ts
interface GitHubConnection {
  id: string;
  authMode: "github-device-user" | "github-app-installation";
  state: "authorizing" | "ready" | "refreshing" | "degraded" | "revoked";
  githubUser: { id: number; login: string };
  secretReference: string; // vault identifier; never serialized to a client
  revision: number;
  connectedAt: string;
  lastValidatedAt?: string;
}
```

The direct device-flow provider's effective access is the intersection of the
GitHub App permissions, the app installation's repository selection, and the
configuring GitHub user's own access. Loss of any of the three must fail closed.
The app should opt into expiring user access tokens so normal operation uses
rotated access/refresh token pairs rather than an indefinitely valid user token.

### Repository catalog entry

```ts
interface GitHubRepositoryCatalogEntry {
  githubRepositoryId: number;
  installationId: number;
  owner: string;
  name: string;
  canonicalRemote: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  connectionId: string;
  observedAt: string;
}
```

The catalog contains metadata, not credentials. Entries disappear or become
unavailable when installation selection or user access changes.

### Project credential binding

```ts
interface ProjectGitHubBinding {
  id: string; // unique per project; safe to store as credentialReference
  projectId: string;
  connectionId: string;
  installationId: number;
  githubRepositoryId: number;
  revision: number;
}
```

The existing `ProjectRepositoryConnection.credentialReference` can point to the
binding ID. A server-side resolver follows the binding to the server GitHub
connection and finally to encrypted token material. This indirection preserves
the current rule that a credential reference is unique to one project while
allowing many projects to use the same server connection without copying a
secret.

The project's existing canonical remote, identity digest, checkout root,
sensitive-path policy, and revision checks remain authoritative. Selecting a
catalog entry does not automatically clone a repository or prove that an
existing local checkout matches it.

## Request path

```text
authenticated server principal
  -> accessible room and room membership
  -> effective GitHub-read capability
  -> immutable room project attachment
  -> verified project repository connection and current revision
  -> project GitHub binding
  -> healthy server GitHub connection
  -> allowlisted read-only GitHub adapter
  -> policy-filtered result/cache
  -> room transcript
```

The browser, room payload, prompt, and model never choose a credential reference,
installation ID, repository ID, or remote URL for a fetch. Those values are
resolved from server state after authorization.

The existing same-project cache-sharing rule remains valid. Cache identity must
include at least project ID, repository connection revision, policy revision,
operation, and normalized arguments. A rebind, disconnect, or catalog removal
must invalidate affected entries.

## Control plane and UI

### Server settings: Integrations / GitHub

- Connect, resume, reconnect, and disconnect through a device-flow UI.
- Show the configuring GitHub identity, app installation accounts, connection
  health, last validation, and repository catalog refresh state.
- Open GitHub's installation-management page to change selected repositories.
- Explain that server members may see private repository context presented by
  agents in rooms they can access.
- Never display access tokens, refresh tokens, or internal secret references.

### Project settings: Repository

- Choose one repository from the server catalog.
- Choose or confirm an existing local checkout.
- Verify the checkout's canonical remote against the selected catalog entry.
- Display connection revision, verification state, inherited GitHub connection
  health, and rebind consequences.
- Derive the project binding and credential reference on the server; do not
  accept either from the browser.

### Room settings

- Show the inherited project and repository as read-only context.
- Show whether the assigned agent has the GitHub-read capability.
- Offer no token, installation, repository-picker, or remote-URL fields.
- Explain that moving to another repository means attaching a new room to the
  appropriate project under the current one-project/one-repository rule.

## Proposed control-plane surface

Exact route names can follow the repository's API conventions, but responsibility
should be split as follows:

```text
GET    /api/control/integrations/github
POST   /api/control/integrations/github/device-authorizations
GET    /api/control/integrations/github/device-authorizations/:id
POST   /api/control/integrations/github/catalog-refreshes
DELETE /api/control/integrations/github/:connectionId
GET    /api/control/integrations/github/repositories
PUT    /api/control/projects/:projectId/repository
DELETE /api/control/projects/:projectId/repository
```

All mutations require an authenticated durable control-plane principal, CSRF
protection where applicable, revision preconditions, and audit events. Suggested
capabilities are `INTEGRATION_VIEW`, `INTEGRATION_CONFIGURE`, and
`PROJECT_REPOSITORY_CONFIGURE`; they should not be hidden inside provider/model
configuration capabilities.

The current in-memory human room session identifies a `humanId`, while the
control plane authorizes durable principals with `OWNER`, `ADMIN`, and `MEMBER`
roles. Before server membership can be the security boundary, those identities
must be bound durably or resolved through one canonical authorization service.

## Compatibility boundary

Credential resolution should sit behind a provider interface:

```ts
interface GitHubCredentialProvider {
  resolve(binding: ProjectGitHubBinding): Promise<ResolvedGitHubCredential>;
  health(connectionId: string): Promise<GitHubConnectionHealth>;
  revoke(connectionId: string): Promise<void>;
}
```

Initial providers:

- `legacy-pat`: compatibility only; reads the existing server-held PAT setup.
- `github-device-user`: target self-hosted experience.
- `github-app-installation`: later hosted-broker experience using short-lived
  installation tokens.

The room-bound GitHub service should depend on this interface, not environment
variables or OAuth details.

## Acceptance checks

- A server owner can connect GitHub from the UI without creating a PAT or editing
  per-room/per-project environment variables.
- The server can enumerate only repositories available through the effective
  app installation and configuring-user permissions.
- Two projects can bind different repositories through one GitHub connection
  without sharing a project credential reference or duplicating token material.
- A room cannot override its project's repository or GitHub connection.
- A general room cannot execute GitHub reads.
- A browser request cannot inject a repository, installation, remote, or secret
  reference into a room-bound GitHub operation.
- Disconnect, revocation, repository deselection, and project rebind fail closed
  and invalidate affected cached authority.
- No token or secret reference appears in API responses, logs, prompts,
  transcripts, audit payloads, or error messages.
- The existing allowlisted, read-only `/gh` operations continue to work through
  the new credential provider.

## Current state

- Project repository connections and immutable room project attachments already
  provide most of the required containment path.
- The `/gh` adapter is read-only and resolves repository authority from the
  room's project rather than caller input.
- `/gh` now resolves credentials through an asynchronous provider boundary; the
  existing environment-backed PAT behavior is isolated in a compatibility
  provider.
- A revisioned `GitHubIntegrationStore` persists non-secret server connection
  metadata and unique per-project bindings. A binding-aware provider proves that
  multiple projects can resolve through one server connection without copying a
  token. This store is not yet opened or selected by server startup.
- A fixed-origin GitHub App device-flow transport implements start, polling,
  refresh, bounded response parsing, and redacted failures. It is not yet joined
  to a repository catalog.
- An AES-256-GCM credential vault now persists device-user and installation-token
  records with compare-and-set rotation, encrypted tombstones, authenticated
  restart, restrictive permissions, and wrapping-key material required to live in
  a separate directory from encrypted data.
- A server-only authorization coordinator binds flows to durable control-plane
  principal IDs, enforces polling intervals, validates the GitHub user at a fixed
  API origin, commits the vault before public connection metadata, and compensates
  failed metadata commits by tombstoning the new secret.
- Dependency-injected control-plane routes now expose redacted connection and
  authorization projections behind dedicated integration view/configure
  capabilities and CSRF-protected mutations. Production startup does not register
  them until a real reusable GitHub App client ID can be bundled.
- Production credential registration is still memory-only and initialized from
  environment variables through the legacy provider.
- Repository configuration currently accepts a caller-supplied opaque credential
  reference through a developer-oriented API rather than a server-derived UI
  workflow.
- Current GitHub tests use fake credentials and mocked fetches; they prove
  containment behavior, not a live GitHub authentication path.
- Durable control-plane principals and ephemeral room human sessions are not yet
  one canonical membership identity.

## Next action

Register the reusable public GitHub App, bundle its public client ID, then register
the tested control-plane routes at production startup. The next backend slice is
installation/repository catalog discovery so project bindings cannot select a
repository outside the app installation. Promote accepted slices from
[the delivery plan](github-integration-delivery-plan.md) into GitHub Issues.

## Evidence

- `server/project-repository-connection.ts`
- `server/project-repository-api.ts`
- `server/room-lifecycle.ts`
- `server/room-lifecycle-api.ts`
- `server/human-session.ts`
- `server/control-plane.ts`
- `server/room-bound-github-read.ts`
- `server/room-bound-github-read.test.ts`
- `server/github-credential-provider.ts`
- `server/github-credential-provider.test.ts`
- `server/github-integration-store.ts`
- `server/github-integration-store.test.ts`
- `server/github-device-flow.ts`
- `server/github-device-flow.test.ts`
- `server/github-credential-vault.ts`
- `server/github-credential-vault.test.ts`
- `server/github-device-authorization.ts`
- `server/github-device-authorization.test.ts`
- `server/github-integration-api.ts`
- `server/github-integration-api.test.ts`
- `docs/planning/82-project-repository-connections.md`
- `docs/planning/129-room-bound-github-read.md`
- `docs/operations/capabilities-and-logging.md`
- [GitHub: Building a CLI with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-cli-with-a-github-app)
- [GitHub: Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub: Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub: Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)

## Open questions

- Is one configuring GitHub identity per server sufficient for the first release,
  or must a server support multiple connections immediately?
- Which local credential-vault backend is the first supported deployment target?
- Should repository catalog refresh be manual plus on-demand, or also periodic?
- When should managed clone/worktree provisioning be added beyond existing-local
  checkout verification?
- Should any GitHub mutation ship before the hosted installation-token provider?
