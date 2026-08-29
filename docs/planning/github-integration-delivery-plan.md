---
id: github-integration-delivery-plan
status: proposed
issue:
owner: unclaimed
reviewers: []
depends_on: [82, 129]
reported_by: room-discussion
updated: 2026-08-28
---

# GitHub integration delivery plan

> Temporary issue-slicing note for the
> [reusable GitHub integration architecture](github-integration-architecture.md)
> and its [security contract](github-integration-security-and-lifecycle.md).
> GitHub Issues remain the source of truth after slices are accepted.

## Outcome

Deliver a UI-configurable, server-owned GitHub connection without breaking the
existing room→project→repository containment model or requiring a managed service
for self-hosted installations.

## Dependency-safe delivery waves

### Wave 0: canonical server identity

Bind room human sessions to durable control-plane principals and make deactivation
and role/membership checks flow through one authorization service.

Exit evidence:

- a room command can name the durable server principal that authorized it;
- a deactivated member immediately loses authorization for new requests; and
- existing local single-user behavior has an explicit bootstrap mapping.

### Wave 1: credential provider and vault foundation

Introduce `GitHubCredentialProvider`, `CredentialVault`, server GitHub connection
records, project binding records, revisions, redaction, and audit events. Add a
`legacy-pat` provider around the current environment-backed behavior so the
runtime can migrate before OAuth ships.

Exit evidence:

- current `/gh` tests pass through the provider interface;
- multiple project bindings can resolve through one server connection without
  duplicate token material;
- secret serialization and log-leak tests pass; and
- vault restart, atomic rotation, and deletion behavior is proven for the chosen
  backend.

### Wave 2: public GitHub App device authorization

Register the reusable public GitHub App with minimal read permissions and no
initial webhooks, enable device flow, and opt into expiring user access tokens.
Implement device-flow start/status/cancel, server-side polling, token refresh,
GitHub identity validation, phishing-resistant UI guidance, and connection health.

Exit evidence:

- a clean self-hosted server connects from the UI with only the bundled public
  client ID;
- no PAT, app manifest, private key, callback server, or token environment
  variable is required;
- denial, expiry, slow-down, restart, refresh, and revocation paths are tested;
  and
- one opt-in live canary proves authentication against a disposable GitHub
  account/repository without making live credentials a normal CI dependency.

### Wave 3: installation and repository catalog

Discover installations visible to the configuring user, enumerate repositories,
persist a metadata-only catalog, expose refresh/health, and handle installation
or selection changes.

Exit evidence:

- only effectively accessible repositories appear in the server settings UI;
- selected-repository and all-repository installations are distinguishable;
- removed repositories become unavailable and invalidate affected bindings; and
- catalog APIs reveal neither tokens nor vault references.

### Wave 4: project repository binding UI

Add an owner/admin project settings workflow that selects a catalog repository,
verifies an existing local checkout's canonical remote, creates a server-derived
project binding, and commits the project repository connection with revision
preconditions.

Exit evidence:

- the browser cannot supply a credential/binding reference;
- one server connection supports repositories bound to multiple projects;
- a mismatched local remote fails verification with actionable UI; and
- rebind reports affected rooms and invalidates cached authority.

### Wave 5: room inheritance and operator experience

Show inherited repository and connection health in room settings, show the
agent's effective GitHub-read capability, add integration health to diagnostics,
and place the code-visibility warning in invite/member flows.

Exit evidence:

- rooms have no repository picker or credential fields;
- general rooms clearly report GitHub as unavailable;
- project-backed rooms explain whether failure comes from capability, attachment,
  repository verification, vault, token, or catalog health; and
- server invitation requires an explicit acknowledgement of the private-code
  visibility boundary.

### Wave 6: runtime cutover and legacy retirement

Resolve all room-bound reads through project binding → server connection → device
credential provider, retain a guarded rollback to `legacy-pat`, publish migration
instructions, and then deprecate the environment-token path after evidence from
real self-hosted installations.

Exit evidence:

- all issue #129 containment, sensitive-path, caching, and read-only tests pass;
- disconnect/revoke/deselect/rebind behavior is covered end to end;
- operators can migrate and roll back without editing rooms; and
- warnings and documentation identify a dated removal path for legacy PAT setup.

### Later wave: hosted integration broker

Add `github-app-installation` as a provider that exchanges a self-hosted server's
broker session for short-lived installation tokens. Preserve project binding IDs,
room behavior, repository catalog semantics, and audit contracts. This wave is
not a prerequisite for the self-hosted device-flow release.

## Recommended issue boundaries

Each bullet is intended to become a separate GitHub Issue only after architecture
review:

1. Canonical principal binding for room and control-plane authorization.
2. Credential-vault backend selection and implementation.
3. GitHub credential-provider and project-binding indirection.
4. Device-flow backend state machine and refresh lifecycle.
5. Server GitHub integration settings UI.
6. Installation/repository catalog and refresh behavior.
7. Project repository binding API and settings UI.
8. Room inherited-repository UI and invite trust warning.
9. `/gh` provider cutover, invalidation, diagnostics, and migration.
10. Opt-in live GitHub canary and operator runbook.

Avoid combining the hosted broker or GitHub writes into these issues. They have
different deployment, attribution, and threat models.

## Migration and rollback

1. Ship the provider interface with `legacy-pat` behavior unchanged.
2. Migrate existing project connections to unique project binding records that
   resolve to the legacy server credential.
3. Let an owner connect the device-flow provider and preview its repository
   catalog without changing active projects.
4. Rebind projects individually with a revisioned, audited operation.
5. Keep the previous binding metadata long enough for an explicit rollback, but
   never retain a revoked token merely for rollback.
6. Remove environment-token guidance only after device-flow restart, refresh,
   revocation, and self-hosted upgrade paths have production evidence.

Rollback changes the project's binding/provider, not the room. Existing room
attachments remain stable.

## Verification matrix

| Layer | Required evidence |
| --- | --- |
| Unit | Device-flow transitions, refresh single-flight, vault revisions, redaction, canonical remote matching, binding resolution |
| API | Role/capability checks, CSRF, stale preconditions, caller-field rejection, redacted responses |
| Integration | Server connection → catalog → project binding → room `/gh` read, plus disconnect and repository deselection |
| Security | Token/log/prompt leak tests, arbitrary-host rejection, stale-session deactivation, read-only enforcement |
| Persistence | Restart during authorization, after token exchange, during refresh, and after disconnect |
| UI | Connect/reconnect/disconnect, catalog selection, checkout mismatch, inherited room status, invite warning |
| Live canary | Disposable private repository read through the public app; opt-in and never required for contributor CI |

## Acceptance checks

- The plan can be converted into small GitHub Issues without making temporary
  Markdown a second tracker.
- Every delivery wave has a rollback or failure-containment story.
- No wave introduces a room-owned or project-owned token.
- The self-hosted release does not depend on an internet-facing service controlled
  by this project.
- The hosted broker can be introduced later without changing room semantics.
- Existing issue #82 and #129 behavior remains the compatibility baseline.

## Current state

Foundation work now includes the credential-provider runtime seam, revisioned
non-secret server connection/project binding storage, a vault-reader boundary,
the fixed-origin device-flow/refresh transport, durable encrypted credential
storage, principal-bound authorization orchestration, dedicated integration
capabilities, dependency-injected control-plane routes, fixed-origin installation
discovery, revisioned catalog snapshots, catalog refresh/read APIs, and
catalog-enforced project binding authority. A canonical public-App registration
template and prefilled registration URL now define the permission-minimized App,
and an exact-field loader accepts only its public name, slug, and Client ID. When
that config exists, production startup opens the durable store/vault, registers
the integration and project-binding APIs, and gives room reads a binding-first,
legacy-PAT-fallback provider for incremental project migration. The owner/admin
project-binding backend now derives repository,
installation, default-branch, and opaque credential authority from the current
catalog, verifies the local checkout, compensates a failed repository commit by
revoking the binding, and exposes a CSRF-protected request-allowlisted control API.
The public App is now registered and its GitHub-generated Client ID is bundled.
The effective GitHub configuration is public, device-flow enabled, webhook-free,
and limited to the planned read-only repository permissions. The Room menu now
opens an authenticated server/project settings UI that can claim or sign in the
server owner, link to App installation management, complete device flow, refresh
the redacted repository catalog, and verify one catalog repository against the
server-derived current project checkout. A live canary completed device
authorization against the public App, discovered its real installation and
repository, and verified the project binding in the browser; every attached room
is shown as inheriting that binding without credentials. Scheduled token refresh,
disconnect/reconnect lifecycle, canonical room-principal binding, and rebind
impact/cache invalidation remain unimplemented; none of these temporary notes is
a substitute for accepted Issues.

## Next action

Implement scheduled refresh and authority invalidation for expired credentials,
repository deselection, disconnect, and rebind. Then complete the canonical
room-principal and invite-trust surfaces before removing the legacy PAT fallback.

## Evidence

- `docs/planning/github-integration-architecture.md`
- `docs/planning/github-integration-security-and-lifecycle.md`
- `docs/planning/82-project-repository-connections.md`
- `docs/planning/129-room-bound-github-read.md`
- `docs/operations/github-app-registration.md`
- `config/github-app-registration.template.json`
- `server/github-app-configuration.ts`
- `server/github-integration-runtime.ts`

## Open questions

- Which supported deployment shape should drive the first credential-vault
  backend: desktop, headless Linux service, or container?
- Is one server GitHub connection enough for v1?
- Who may bind a project repository: owner only, or owner and admin?
- Is an invite-time acknowledgement sufficient for the server-wide code trust
  model, or should existing members acknowledge it on upgrade?
- What production evidence is required before legacy PAT configuration is
  deprecated and removed?
