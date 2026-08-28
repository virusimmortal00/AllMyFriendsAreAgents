# Capabilities, audit, and structured logging

The server is the authority for agent capabilities. For every configured roster participant it resolves configured, runtime-available, and effective states plus a per-command gate record. Each command record reports whether the feature is compiled, required server configuration exists, the server ceiling includes it, the roster is enabled, the requested grant and command-catalog revision are current, and the provider session is fresh. It also includes effective commands, bounded lease issuance/expiry status, last manifest issuance, and the last bounded rejection. Stable exclusions include `missing-server-config`, `permission-not-granted`, `agent-disabled`, `catalog-revision-stale`, `provider-session-stale`, and `lease-expired`. The browser never receives tokens, credential paths, environment values, or provider responses.

## Capability model

`conversation` requires an enabled roster entry, a currently available selected OpenCode model, and an available OpenCode runtime. `github_read` additionally requires the server-only read binding, server ceiling, current catalog grant, and fresh provider-session binding. `project_write` is never effective in the room lane: writes require the existing exclusive, governed implementation-worker assignment and its confined worktree. Selecting a legacy writable participant does not turn a room generation into a writer.

The lease and manifest fields in this projection come from `RoomCommandToolBroker`, the component that issues the actual `room_command` lease. Its safe snapshot contains no token or provider session identity. It records bounded, deduplicated issued/refreshed/expired/revoked and accepted/rejected events with only a closed command name and, for `/gh`, a `recent`, `pr`, `issue`, or `ci` selector family—never arguments. It compares session identity internally and exposes only freshness and a stable reason.

The `/gh` contract is strictly read-only. The command grammar accepts only `recent`, `pr <positive number>`, `issue <positive number>`, and `ci [positive PR number]`. The server broker performs fixed GitHub GET requests against the configured repository. It does not expose a token, arbitrary URL, HTTP method, request body, ref, shell, `gh` CLI, contribution operation, merge, or deployment operation to an agent. Disabling the capability removes `/gh` from the issued room-command token and guide; recovery rechecks permission before execution.

For both humans and agents, GitHub reads are `gh` subcommands transported through the existing `room_command` tool; there is no separate GitHub tool. Checking the roster grant records requested intent only. It grants no authority by itself: server configuration, the server ceiling, current catalog revision, active roster entry, fresh provider session, and the current server-issued lease must still make the command effective.

Agent child environments remove all `ALL_MY_FRIENDS_ARE_AGENTS_*`, `AGENTWIRE_*`, database URLs, and names that look like tokens, secrets, passwords, API/private/access keys. This includes `GH_TOKEN`, `GITHUB_TOKEN`, and provider API keys. The room-history and room-command bearer values are minted per server-owned capability and are injected only when that capability is present; they are absent from prompts, API projections, diagnostics, audits, and logs.

## Configuration and launchd

Set these only in the repository root `.env`, which the installed `.allmyfriendsareagents/run-live-dev.zsh` launchd script sources before starting the server. Never put them in browser configuration or inline them beside the separate contribution credential in that script:

- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_TOKEN`: read-only GitHub credential.
- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_REPOSITORY`: exact `owner/repository` boundary.
- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_DEFAULT_BRANCH`: optional default branch (normally `main`).
- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_FAKE`: development/test fixture switch; leave empty for real operation.
- `ALL_MY_FRIENDS_ARE_AGENTS_CAPABILITY_AUDIT_LIMIT`: retained events, clamped to 10–5000 (default 500).
- `ALL_MY_FRIENDS_ARE_AGENTS_LOG_MAX_BYTES`: active structured-log size before rotation (default 5 MiB).
- `ALL_MY_FRIENDS_ARE_AGENTS_LOG_LOCAL_DEBUG_STACKS=true`: include redacted bounded stacks only on a loopback-bound server; stacks are absent by default.

Create a fine-grained token bound to exactly the configured repository with read-only Metadata, Actions, Checks, Contents, Issues, and Pull requests permissions. Grant no write or administration permission, and never reuse the contribution/mutation token (`ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_TOKEN`). Keep root `.env` mode `0600`. Presence-check configuration without printing values:

```zsh
cd /Users/virusimmortal00/src/virusimmortal00/AllMyFriendsAreAgents
chmod 600 .env
for name in ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_TOKEN ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_REPOSITORY ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_DEFAULT_BRANCH; do
  grep -q "^${name}=.\+" .env && print "${name}=present" || print "${name}=missing"
done
```

The installed job is `io.amfaa.live-dev`, whose server script is `.allmyfriendsareagents/run-live-dev.zsh`. It sources root `.env`; do not edit the job or script to echo secrets. Restart the existing job—never start a second process against the live SQLite/data directory—then verify readiness:

```zsh
launchctl kickstart -k "gui/$(id -u)/io.amfaa.live-dev"
curl -fsS http://127.0.0.1:53147/api/ready >/dev/null && print ready
```

Sign in as the owner, open Manage Agents, explicitly check the requested `/gh` grant, and save. The UI shows requested and effective state separately. Start a fresh agent turn so the server issues a fresh `room_command` lease, use `/help` to confirm `/gh` is listed, then run `/gh recent` against the real repository. The owner Diagnostics inspector should show no exclusion; otherwise use its stable code (`missing-server-config`, `permission-not-granted`, `agent-disabled`, `catalog-revision-stale`, `provider-session-stale`, or `lease-expired`) rather than inspecting credentials.

Structured records are written to `.allmyfriendsareagents/server.jsonl` under the configured data directory and rotate through `.1`–`.3`; foreground/launchd output remains in `.allmyfriendsareagents/live-dev.log`. Copy the response `traceparent` trace ID or `x-request-id`, then search only correlated JSONL records, for example `rg '"requestId":"<request-id>"' .allmyfriendsareagents/server.jsonl*`. Identical records are limited to 20 for an identical payload/context in a 10-second window. Further copies are suppressed; the next identical record after the window emits one `logging.identical.coalesced` summary with the bounded suppressed count.

To disable or roll back, uncheck the roster `/gh` grant, remove the four `GITHUB_READ_*` values from root `.env`, restart the same launchd job, and confirm `missing-server-config` and absence from `/help`. Removing these settings does not delete the room database, transcript, roster, or audit. A restart may deliberately start a fresh provider session and cold GitHub read cache; that is cold-cache/session behavior, not data loss. Restore the prior application revision and restart the same job for code rollback.

## Diagnostics and audit

Manage Agents displays each effective state, the bounded reason, and remediation guidance. The existing Diagnostics screen contains an explicit-refresh Owner capability inspector. Only the durable control-plane owner can read `/api/control/capabilities?limit=100`; the limit is clamped to 1–200. The response contains policy revision, per-agent safe projections, and recent bounded audit events.

Capability audit outcomes are `configured`, `attempted`, `allowed`, `denied`, `failed`, and `completed`. Records contain only an event ID, timestamp, agent/caller identifier, capability name, outcome, optional correlation ID, and a short redacted reason. Raw command input, selectors, prompts, responses, headers, credentials, and environment are excluded. The durable file retains only the configured maximum.

## Structured logs and correlation

Every JSON line has schema version, service name/version, instance ID, deployment commit/epoch (nullable before deployment discovery), environment, timestamp, level, and event. Outcome and reason are included for decision events. HTTP records also carry `traceId`, `spanId`, and `requestId`, plus bounded method, path, status, and duration. A valid incoming W3C `traceparent` keeps its trace ID and creates a new server span; absent or invalid context creates both. Responses return `traceparent` and `x-request-id`. Agent/capability operations use their generation, submission, or audit correlation IDs.

Serialization is centralized, recursive, allowlisted, and default-deny: arbitrary object keys and all prompt, instruction, raw response, visible-message, stdout, and stderr payload fields are omitted. Credential-shaped strings and serialized errors are scrubbed and length/depth bounded. Stacks are absent unless explicit loopback-only local debugging is enabled. The generation journal applies the same policy and drops content payloads before serialization. Console and file-sink failures never block or fail the server operation; the serialized file queue recovers for later writes. The active `server.jsonl` rotates to `.1` through `.3` before its configured bound, while each JSON line is still emitted to stdout for launchd and foreground operation.

The structured facade emits startup/shutdown and HTTP boundary events; provider generation and actual room-command lease/tool decisions; assignment reconciliation, lease, manifest, and tool-policy decisions; GitHub store/adapter and read-cache lifecycle; and storage/migration checks. Startup manifest, lease, tool-policy, and GitHub read-cache snapshots are emitted even when no agent or command is invoked. Direct console output remains only in standalone import and confined Git-broker CLI helpers where stdout/stderr is their user/protocol surface; the server runtime uses the facade.

## Troubleshooting and agent-visible behavior

- `model_unavailable`: refresh discovery and select a listed provider/model/variant.
- `runtime_unavailable`: verify `opencode --version` and server-user PATH/authentication.
- `missing-server-config` for `/gh`: keep or set the requested grant, configure the read-only server binding, then restart and begin a fresh turn/lease.
- `agent_disabled`: reactivate the roster participant.
- `governed_worker_only` or `exclusive_writer_elsewhere`: use an explicit governed implementation handoff; do not try to alter room-agent mode.

Agents see only commands currently effective for them. They never see a disabled command, credential, or hidden reason payload. Humans receive the same bounded denial semantics, and ordinary conversation behavior remains read-only and otherwise unchanged.
