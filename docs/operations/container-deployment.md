# Container images and operator-managed upgrades

The application runs on Node.js 24 with pnpm 10. The image also contains a Linux
build of the audited OpenCode downstream source, commit
`6883ca5bd35a5494fb2759018373308911c79e01`, version `1.18.25-amfaa.2`.
Bun is pinned and used only in the disposable OpenCode build stage; this is not
an application migration to Bun. The Dockerfile fetches the exact source commit,
not a moving downstream branch.

The native source build uses the frozen dependency install and the downstream
build script's `--skip-install` option, avoiding a second all-platform dependency
resolution. This is source-pinned, not a claim of byte-for-byte reproducibility:
Debian package indexes and the embedded models.dev catalog remain network inputs.
Retain the tested image digest and its provenance; do not substitute a rebuild.

## Release status and boundaries

The container pipeline is gated by fresh-install and preserved-volume acceptance
under [#163](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/163).
The fresh empty-roster requirement currently depends on
[#162](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/162).
Do not bypass that gate to publish an image or interpret a locally tagged image
as proof that anonymous registry pulls work.

Portable image creation belongs in this repository. Host-specific rollout
controllers, schedules, tunnels, environment secrets, backups, and resource-study
schedules belong in an operator-managed repository or workspace. Merging code or
publishing an image does **not** deploy an operator's server.

The publisher signs only when the candidate SHA matches the triggering workflow
SHA; overriding checkout alone cannot change GitHub's signed source claim. It
also rechecks exact-revision quality immediately before pushing an image.

## Local build and fresh installation

```bash
cp .env.compose.example .env
cp .env.container.example .env.container
chmod 600 .env .env.container
# Select a dedicated standalone checkout in AMFAA_PROJECT_PATH.
# Configure server settings deliberately; do not replace existing env files.
docker compose build amfaa
docker compose up --detach --wait amfaa
curl --fail http://127.0.0.1:53147/api/ready
```

The API is published only on loopback ports 53147 and 4173. The container can bind
its own network interface without exposing a host port to the LAN. Keep host
bindings on `127.0.0.1`; protected remote access additionally requires HTTPS,
explicit allowed-host configuration and the application's authentication boundary.
Use a fictional hostname such as `agents.example.test` when sharing examples.

`.env` supplies Compose interpolation inputs. `.env.container` supplies application
configuration and is not included in the image. Preserve credential handling and
do not print expanded Compose configuration. To authenticate a provider explicitly,
use `docker compose run --rm amfaa opencode auth login`; provider state belongs in
its volume, not in the image or a committed file.

The project is mounted read-only at `/workspace`. Use a standalone checkout with
its own accessible Git metadata, not a linked worktree pointing at a host-only
path. Plain directories provide read-only context without repository features.
Writable assignment execution requires a separately verified repository boundary;
do not turn this mount read-write to evade it.

## Durable storage contract

### Repository readiness and checkout preparation

Container startup is not proof of repository access. The Compose health check
requires both `/api/ready` and `/api/ready/repositories` to return HTTP 200 with
`ready: true`. The second endpoint revalidates every enabled saved repository
against its actual filesystem and branch. It returns only an aggregate boolean;
it exposes no paths, identities, or credentials. An empty or explicitly disabled
repository setup does not fail health. This is a local authority check, not a
GitHub network or credential test; verify a fresh room-scoped `/gh` read after
repair. The application remains reachable when repository health fails so an
administrator can repair it.

Operator-managed rollout controllers must check both endpoints after startup
and restart, reject missing/invalid responses, and treat failed repository
readiness as requiring attention. Do not automatically replace saved paths,
reconnect accounts, or roll back persisted state to clear the failure.

Before initially mounting or deliberately relocating a standalone checkout,
stop its writers and prepare the saved default branch explicitly:

```bash
node scripts/prepare-container-checkout.mjs /path/to/standalone-checkout main
```

Use the repository's actual saved default branch instead of assuming `main`.
For a detached checkout, preparation attaches that branch at the same commit
only when its existing reference can fast-forward. It refuses dirty files,
linked worktrees, a different checked-out branch, and divergent history. It
never fetches or changes the selected source revision. Keep this preparation
separate from routine image upgrades; upgrades must retain the project's mount
and branch. After relocation, use **Room → GitHub integration... → Repair
repository paths** to validate and save the new paths with owner authorization.

Keep `/workspace`, `/worktrees`, and all existing volume identities stable
across normal upgrades. Repeated health checks detect later branch/path drift.

| Mount | Contents |
| --- | --- |
| `/data` | SQLite database, WAL/SHM, room/control/integration sidecars and encrypted credential envelope |
| `/worktrees` | Governed assignment worktrees |
| `/home/node/.allmyfriendsareagents` | Vault wrapping key, paired with its original encrypted envelope |
| `/home/node/.cache` | OpenCode cache |
| `/home/node/.config/opencode` | OpenCode configuration |
| `/home/node/.local/share/opencode` | OpenCode authentication and persistent runtime data |

The public Compose example creates volumes for a genuinely new installation.
An existing deployment should declare its exact volume identities as external,
so a missing volume fails instead of silently creating empty replacement state.
A new volume is **not** a migration of settings or conversation history.

Before replacing an existing instance:

1. Resolve and verify the candidate's immutable digest and source provenance.
2. Check current environment, volume identities, project mount and host bindings.
3. Stop writers, then privately archive all six volumes and applicable historical
   host state. Include SQLite sidecars and non-database control/settings files.
4. Verify archives and SQLite integrity on a consistent writable extraction or
   SQLite backup. Keep source archives immutable, and preserve the envelope/key
   pair together. Record original message/settings/roster metadata without
   printing transcript or credential contents.
5. Recreate only the application with the chosen digest; never build on an
   unattended operator update. Do not rewrite the selected project implicitly.
6. Verify readiness, authenticated OpenCode health, exact runtime version, readable
   credentials and original durable metadata. Check browser connection and the
   configured external MCP host: unauthenticated requests should return 401, not
   invalid-host 403. Verify restart persistence as part of first operator adoption.

Retain the previous image and a complete backup. If candidate startup has written
to durable state, image-only rollback may be unsafe. Stop further unattended
updates and use a separately verified recovery procedure; do not automatically
restore over newer data. Never use `docker compose down --volumes` for an upgrade.

An already-claimed owner does not need a replacement bootstrap secret. Existing
vault-backed repository reads do not enable the legacy contribution broker:
that separate capability requires its own configured repository and write token.
Do not borrow a read-only credential or broaden grants during deployment.

## Reset a forgotten owner password

From a source checkout on the Docker host, identify the existing application
container with `docker ps`, then run:

```bash
pnpm control:owner:container <container-name>
```

The command prompts twice without echoing the password. It requires Docker-host
access, stops the container, and uses its exact image and existing writable data
mount in an offline temporary container. It calls the canonical owner recovery
method with a process-local proof, records the recovery audit event, and restores
the original running state even when recovery fails. No configured bootstrap
secret or recovery script inside the image is required. Keep external rollout
controllers paused during recovery so they cannot restart a concurrent writer.
All administrator sessions end when the server stops; sign in again using the
existing owner username. Accounts and room history are preserved.

On macOS, append `--generate-clipboard` to generate a random password and copy it
to the clipboard without printing it. Save it in a password manager before
replacing the clipboard contents. No password is passed in Docker arguments or
written to a plaintext file. Docker-host access already permits changing the
mounted account store; this command does not add a browser recovery endpoint.

## Publication gates

The publisher accepts a successful main `Quality gates` completion, an explicit
dispatch from main, or a `vMAJOR.MINOR.PATCH` tag whose exact commit passed main
quality checks. Fork/PR builds receive no publication permissions. Every trigger
must pass the image-level acceptance checks before the publish job can run.

The pipeline builds and loads one multi-platform image index with AMD64/ARM64
content, provenance and SBOMs, tests it, then transfers and publishes that exact
image rather than rebuilding after tests. It creates a full `sha-<40-character
commit>` tag, refuses to overwrite revision/version tags, and signs the registry
digest with GitHub artifact attestation. The single serialized publisher rechecks
current main before promoting `main`; an older queued build cannot replace a newer
published main. Release tags do not update moving main or semver aliases.

Build arguments are public provenance inputs: never pass secrets as build args.
GitHub initially creates packages with restricted visibility; an owner must verify
the desired public package visibility and test anonymous pulls. That step is not
implied by a successful push.

Operator controllers should verify the immutable digest with `gh attestation
verify`, requiring this repository, the publisher workflow identity, expected
source commit/ref and hosted runner, alongside image labels and exact source
quality checks. Missing signatures or mismatches must block rollout. Attestation
availability and registry authentication are operator prerequisites, not reasons
to disable verification.

See the [GitHub workflow-event security notes](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[concurrency semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
and [Docker provenance/SBOM documentation](https://docs.docker.com/build/ci/github-actions/attestations/).

## Image acceptance checks

Run these only from an isolated, disposable copy of the source. `context` creates
fictional private-state sentinels and intentionally refuses to overwrite existing
files. It tests the actual Docker context exporter, not a regex approximation of
ignore rules. `layers` checks every saved image layer for those same sentinels.

```bash
node scripts/container-image-check.mjs context
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -t amfaa:test .
node scripts/container-image-check.mjs layers amfaa:test
EXPECTED_APP_REVISION="$(git rev-parse HEAD)" \
  node scripts/container-image-check.mjs runtime amfaa:test linux/arm64
```

The runtime check uses fresh test-only volumes, no host project/credential mounts,
no published ports, and no network. It verifies fresh state, restart, explicit
fictional history/settings/auth state, and replacement with an intentionally empty
roster. Its temporary Docker objects are removed afterward. Repeat on AMD64 in the
multi-platform pipeline. Production `procps` supports process-tree cancellation;
the release pipeline also runs the eight descendant-cancellation regressions.

The optional Docker `test` target includes full source fixtures and bubblewrap.
Nested Linux confinement tests may need test-only seccomp relaxation in an isolated,
network-disabled test container. Never apply that exception to the service.
