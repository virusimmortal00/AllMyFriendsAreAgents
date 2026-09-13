# Native release publication and installation

Native releases are self-contained application bundles for macOS ARM64/x64,
Linux ARM64/x64, and Windows x64. Each bundle includes the application, Node.js,
and the audited downstream OpenCode runtime. Windows ARM64 remains explicitly
deferred in `release/native-target-policy.json`.

This runbook separates candidate acceptance from public release publication. A
candidate is built once, tested on its target hosts, attested, and retained as a
short-lived workflow artifact. Promotion re-verifies and publishes those exact
bytes; it never rebuilds them.

## Trust and artifact contract

`release/native-target-policy.json` is the target and repository policy.
`integration-contracts/opencode.json` records the downstream source identity.
The generated `native-release-manifest.json` binds one application version and
commit to the downstream repository, commit, version, SDK/plugin versions, target
archives, sizes, SHA-256 digests, SPDX SBOMs, and Sigstore provenance bundles.

The moving `releases/latest/download/native-release-manifest.json` URL is only a
convenience selector. The manifest is strictly validated and may select artifacts
only beneath its immutable `releases/download/v<version>/` URL. Installers verify
size, SHA-256, provenance subject binding, archive confinement, release identity,
and the installed inventory before activation.

## Produce an accepted candidate

Merge the intended release commit to `main`, with `package.json` carrying the
version that will be published. The **Build self-contained native applications**
workflow runs for relevant changes on canonical `main`. Its final
`retain-evidence` job runs only after all target builds, exact-set checks,
standalone installer tests, and provider-free application lanes pass.

Record the successful workflow run ID and attempt before its seven-day retention
window expires. The retained artifact is named
`native-release-evidence-<run-id>-<run-attempt>`.

## Promote the exact accepted bytes

From the Actions page, manually dispatch **Publish accepted native release** on
`main` with:

- `candidate_run_id`: the successful candidate workflow run ID;
- `version`: the exact `package.json` version, without a leading `v`.

The promotion workflow reads the candidate run through the GitHub API and fails
closed unless it completed successfully in this repository from `main`, using
`.github/workflows/build-native-opencode.yml`. It checks the run ID, attempt,
source commit, requested version, evidence manifest, attestation binding, and
complete publication projection before creating `v<version>`.

GitHub CLI creates the release as a draft while uploading its assets and publishes
it only after uploads succeed. A failed upload can leave a draft that must be
inspected and removed before a retry; never use asset clobbering to repair a
published release. After publication, the workflow downloads every versioned
asset over HTTPS with GitHub credentials removed and byte-compares it with the
accepted projection.

Creating or dispatching this workflow is a public release action and requires
explicit maintainer authorization. Do not dispatch it as part of an ordinary test
or pull-request review.

## Activate the native README path

Do not make a `latest/download` command the primary README path until the first
promotion succeeds and its anonymous download verification is green. Then test
the public commands on clean supported hosts before replacing the source-checkout
quick start:

```bash
curl -fsSL https://amfaa.sayers.io/install.sh | sh
"$HOME/.local/bin/amfaa"
```

The installer places an installer-owned launcher in `~/.local/bin` and adds that
directory to the appropriate user shell profile when needed. Pass
`--no-modify-path` to a downloaded installer to opt out. The first bare `amfaa`
invocation runs the interactive setup flow, delegates provider authentication to
the bundled OpenCode runtime, records no credentials itself, and then starts the
loopback application for the current directory. Later invocations start directly.
Run `amfaa setup` to repeat provider setup.

Before publishing a candidate, walk through the exact setup presentation without
authentication, filesystem writes, or service startup:

```bash
pnpm preview:setup
```

The packaged equivalent is `amfaa setup --preview`. Preview and real setup share
the same state machine; preview replaces side effects with labeled descriptions.
An incomplete or cancelled setup remains resumable. A first launch without an
interactive terminal fails with instructions instead of waiting for input.

On Windows x64, download `install-windows.ps1` from the same release URL, inspect
it, and run it in PowerShell. The Windows installer adds its per-user installation
directory to the user `PATH` by default; `-NoPath` disables that change. The POSIX
installer also updates the appropriate user shell profile by default;
`--no-modify-path` disables that change.

Keep source setup as a contributor alternative after cutover:

```bash
pnpm install --frozen-lockfile
pnpm setup
pnpm run auth
pnpm run dev
```

`pnpm setup` installs the manifest-selected application-owned OpenCode runtime in
the Git-ignored `.runtime/` tree. It is idempotent and never selects a global
OpenCode executable. `pnpm run auth` launches provider authentication through the
same preflighted runtime used by the server. An explicit
`ALL_MY_FRIENDS_ARE_AGENTS_OPENCODE_COMMAND` remains available for operator and
development overrides.

## Update, rollback, and uninstall

The POSIX installer supports `update`, `rollback`, and `uninstall` subcommands.
The Windows installer uses the default invocation to update, `-Rollback` to swap
back to the retained prior version, and `-Uninstall` to remove application files.
Both installers preserve room data, provider state, credentials, logs, and
assignment worktrees. The native launcher also reports sanitized application and
downstream identities through `amfaa version` and runtime readiness through
`amfaa doctor`.
