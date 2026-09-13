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
invocation runs the interactive setup flow, collects provider authorization through Consolio, saves credentials through
the bundled OpenCode runtime, and then starts the
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

## Native setup presentation

The native wizard starts with a full-screen rainbow ASCII amfaa banner with Consolio, one line
of welcome, and “Press any key to continue.” Setup explanations follow it. The five letters use an Apple-inspired
green, yellow, orange, red, and purple palette; `NO_COLOR` retains the artwork
without color.
An ordinary key continues; Ctrl-C/Ctrl-D or EOF exits before runtime checks or
saving setup state. Non-interactive input uses Enter for this first screen.
Consolio blinks in place while the welcome waits; the
loop stops on selection, cancellation, or stream failure. The splash redraws
and recenters on resize; ordinary setup pages retain their reading width. It remains
static when the face would be outside the viewport, for non-interactive input,
or when `ALL_MY_FRIENDS_ARE_AGENTS_NO_ANIMATION=1`.

Connection offers browser authorization, masked key entry, and manual configuration.
Browser authorization uses OpenRouter's S256 PKCE flow with an ephemeral loopback
callback on a random path. The listener checks the request method, Host, callback
path, and single-use code; it closes on success, cancellation, or timeout. SSH and
container users can select the one-time-code flow without a local callback.
See [OpenRouter's PKCE contract](https://openrouter.ai/docs/guides/overview/auth/oauth).

Consolio saves keys using `PUT /auth/openrouter` on a temporary, password-protected
loopback OpenCode server. Credentials never enter command arguments or wizard logs.
Runtime output is not forwarded to the terminal. The server is stopped after use.
`GET /provider` detects recognized existing configuration; this does not verify a
live model request. Manual setup records onboarding completion without claiming a
connection and explains direct global OpenCode configuration. Environment-only
keys and config environment interpolation are not supported for room conversations.
Automatic `.env` loading is not part of this launcher. Preview neither checks
existing configuration nor opens browsers, reads keys, saves state, or starts services.

The borderless presentation uses neutral body text, green guide/selection accents,
OpenRouter lime (`#c8ff00`), and OpenCode editor blue (`#82aaff`). Arrow keys move a
visible marker; Enter confirms and Esc exits. Non-interactive preview uses numbered
choices. Interactive sections reserve room for wrapped questions, choices, and
keyboard hints before dividing text into pages. Sure, go on and Previous page
navigate explanations; final actions appear only on the last page. Very short
terminals omit decorative headings. `NO_COLOR` disables color.
Full-screen pages keep their question and choices near the bottom of the terminal,
using empty space between the explanation and actions for a consistent height.

Consolio speaks in first person with conversational phrasing, retro wordplay,
and occasional playful asides. That voice continues through key help, credential
handoff, recovery, and completion. Keep action labels direct and billing,
credential storage, project access, and completion claims precise. The opening
splash stays minimal; the guide introduces itself on the OpenRouter page.

The explicit `amfaa auth` command retains OpenCode's provider-specific CLI entry
point; first-time setup uses the API instead. The `native-setup-auth` integration
contract records exact upstream sources and tests. Provider-free verification
against upstream OpenCode 1.18.25 confirmed credential round trips, preservation
of other providers, 0600 file permissions, and recognition after restart. The
same isolated check recognized an environment key and a global configuration
key, while an otherwise empty project with only `.env` was not recognized. The
admitted downstream diff does not modify these auth paths. Live OpenRouter
browser approval and the packaged downstream binary remain separate manual checks.

### Disposable real setup test

With Docker running, run `pnpm test:setup` from the repository. This builds the
current working tree (including unpublished edits), packages the native Linux
application with its pinned Node runtime and audited OpenCode fork, and starts
an interactive container. The first build can take several minutes; subsequent
builds reuse Docker's cache. Use `pnpm test:setup --build-only` to build without
opening setup.

This is real setup, so a key entered or obtained through browser authorization
is saved inside the container. Select **Use another browser (SSH)** for browser
sign-in: open the displayed URL on your computer and paste the one-time code
back into the terminal. Once setup launches the application, open
`http://127.0.0.1:54147`. Model requests use the connected account normally.

The container has a fresh home and empty `/workspace`, no host mounts, and no
persistent volumes. It does not receive the host's environment credentials or
use the development server's ports. Run `exit` or press Ctrl+D in the sandbox
shell to remove the container and its saved keys, configuration, and room data.
Detaching also triggers this wrapper's cleanup, as described below. Each run
starts fresh. Docker
retains the image and build cache; `docker image rm amfaa-setup-sandbox:local`
removes the named image when it is no longer needed. A key created at OpenRouter
remains in that account until revoked there.

This exercises the production bundle, setup, and runtime on Linux. It does not
exercise the public installer's GitHub download/provenance path or native macOS
behavior. Bundle metadata records the checkout's base commit; the sandbox image
also includes any working-tree edits and must not be published as a release.

### Native background service

Completing setup with **Start in the background**, or running `amfaa start`
from a configured installation, starts one background service per data directory.
The CLI waits until the application is listening before displaying its URL.
The native service survives closing the terminal; it does not install an operating
system login item or restart automatically after a reboot.

- `amfaa status` reports whether the managed service is running and its URL.
- `amfaa stop` shuts it down while retaining room data and provider configuration.
- `amfaa start` starts it again from the current project folder; repeated starts
  report the existing service without creating another one.
- `amfaa start --foreground` runs in the terminal for diagnostics.

Stop the managed service before updating or uninstalling. Control uses a random
per-run token in owner-only metadata and a loopback HTTP endpoint. A stale saved
PID is never used to stop a process. A failed start reports a diagnostic command
instead of claiming readiness. Unreachable control endpoints report an unknown
state and preserve their credentials. Stale metadata is removed only when its
recorded process is confirmed absent; elapsed time alone never proves shutdown.

Start, stop, update, uninstall, and service metadata replacement share a lifecycle
lock beside the data directory (`<data-directory>.lifecycle-lock`). If a CLI
process crashes while holding this lock, commands fail closed. Before manually
removing that lock directory, verify the owner PID in `owner.json` has exited
and no lifecycle command is still running. Do not delete the service metadata
or provider credentials to recover a lock.

In the disposable Docker sandbox, background startup returns to `sandbox>`.
Use the same status/stop/start commands there. Keep the container terminal open:
`exit` or Ctrl+D in the sandbox shell removes the container, including all its
data. Ctrl+P followed by Ctrl+Q detaches Docker; this test wrapper then exits
and its cleanup trap forcibly removes its disposable container. It is not a way
to retain this sandbox in the background.
This lifetime restriction belongs to the disposable sandbox, not a native install.

Setup ends with Consolio's farewell and a final keypress before saving and
launching. Local desktop setup attempts to open the ready room in a browser.
SSH/headless sessions display the URL and an SSH port-forward example instead;
the sandbox uses the published host URL. No network bind or authentication
settings are relaxed. Set `ALL_MY_FRIENDS_ARE_AGENTS_NO_BROWSER=1` to opt out.
Later `amfaa start` commands print the URL without reopening the browser.
