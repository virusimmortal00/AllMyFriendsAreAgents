# Capabilities, audit, and structured logging

The server is the authority for agent capabilities. For every configured roster participant it resolves configured, runtime-available, and effective states plus a per-command gate record. Each command record reports whether the feature is compiled, required server configuration exists, the server ceiling includes it, the roster is enabled, the requested grant and command-catalog revision are current, and the provider session is fresh. It also includes effective commands, bounded lease issuance/expiry status, last manifest issuance, and the last bounded rejection. Stable exclusions include `missing-server-config`, `permission-not-granted`, `agent-disabled`, `catalog-revision-stale`, `provider-session-stale`, and `lease-expired`. The browser never receives tokens, credential paths, environment values, or provider responses.

## Capability model

`conversation` requires an enabled roster entry, a currently available selected OpenCode model, and an available OpenCode runtime. `github_read` additionally requires the server-only read binding, server ceiling, current catalog grant, and fresh provider-session binding. `project_write` is never effective in the room lane: writes require the existing exclusive, governed implementation-worker assignment and its confined worktree. Selecting a legacy writable participant does not turn a room generation into a writer.

The lease and manifest fields in this projection come from `RoomCommandToolBroker`, the component that issues the actual `room_command` lease. Its safe snapshot contains no token or provider session identity. It records bounded, deduplicated issued/refreshed/expired/revoked and accepted/rejected events with only a closed command name and, for `/gh`, a `recent`, `pr`, `issue`, or `ci` selector family—never arguments. It compares session identity internally and exposes only freshness and a stable reason.

The `/gh` contract is strictly read-only. The command grammar accepts only `recent`, `pr <positive number>`, `issue <positive number>`, and `ci [positive PR number]`. The server broker performs fixed GitHub GET requests against the configured repository. It does not expose a token, arbitrary URL, HTTP method, request body, ref, shell, `gh` CLI, contribution operation, merge, or deployment operation to an agent. Disabling the capability removes `/gh` from the issued room-command token and guide; recovery rechecks permission before execution.

For both humans and agents, GitHub reads are `gh` subcommands transported through the existing `room_command` tool; there is no separate GitHub tool. Checking the roster grant records requested intent only. It grants no authority by itself: server configuration, the server ceiling, current catalog revision, active roster entry, fresh provider session, and the current server-issued lease must still make the command effective.

Agent child environments remove all `ALL_MY_FRIENDS_ARE_AGENTS_*`, `AGENTWIRE_*`, database URLs, and names that look like tokens, secrets, passwords, API/private/access keys. This includes `GH_TOKEN`, `GITHUB_TOKEN`, and provider API keys. The room-command, room-history, and room-diagnostics endpoint/token family plus the room-command manifest can enter the subprocess only through an exact-key, server-owned scoped channel; values supplied through the ordinary process environment are removed. These ephemeral broker values are injected only when that capability is present and remain absent from prompts, API projections, diagnostics, audits, and logs.

## Configuration and service launch

Set these only in the repository root `.env`, which `pnpm service:start` sources before starting the server. Never put them in browser configuration or print them from a supervisor:

- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_TOKEN`: read-only GitHub credential.
- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_REPOSITORY`: exact `owner/repository` boundary.
- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_DEFAULT_BRANCH`: optional default branch (normally `main`).
- `ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_FAKE`: development/test fixture switch; leave empty for real operation.
- `ALL_MY_FRIENDS_ARE_AGENTS_CAPABILITY_AUDIT_LIMIT`: retained events, clamped to 10–5000 (default 500).
- `ALL_MY_FRIENDS_ARE_AGENTS_LOG_<STREAM>_MAX_BYTES`: per-stream size bound.
- `ALL_MY_FRIENDS_ARE_AGENTS_LOG_<STREAM>_FREQUENCY_MS`: per-stream time bound.
- `ALL_MY_FRIENDS_ARE_AGENTS_LOG_<STREAM>_RETENTION`: per-stream retained-file count.
- `ALL_MY_FRIENDS_ARE_AGENTS_LOG_MAX_BUFFERED_BYTES`: maximum application buffer for each independently drained stream.
- `ALL_MY_FRIENDS_ARE_AGENTS_LOG_LOCAL_DEBUG_STACKS=true`: include redacted bounded stacks only on a loopback-bound server; stacks are absent by default.

Create a fine-grained token bound to exactly the configured repository with read-only Metadata, Actions, Checks, Contents, Issues, and Pull requests permissions. Grant no write or administration permission, and never reuse the contribution/mutation token (`ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_TOKEN`). Keep root `.env` mode `0600`. Presence-check configuration without printing values:

```zsh
cd /path/to/AllMyFriendsAreAgents
chmod 600 .env
for name in ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_TOKEN ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_REPOSITORY ALL_MY_FRIENDS_ARE_AGENTS_GITHUB_READ_DEFAULT_BRANCH; do
  raw=$(grep -E "^${name}=" .env | tail -n 1)
  value=${raw#*=}
  value=${value//[[:space:]]/}
  value=${value#\"}; value=${value%\"}
  value=${value#\'}; value=${value%\'}
  [[ -n ${value} ]] && print "${name}=present" || print "${name}=missing"
done
```

Production supervisors should invoke `pnpm service:start`. The repository-owned launcher redirects inherited stdin/stdout/stderr to `/dev/null`, because Pino's bounded local files are the only authoritative application diagnostics. The launchd example at `config/launchd/io.allmyfriendsareagents.server.plist.example` also sets both supervisor output paths to `/dev/null`; replace its path placeholders before installation. Verify readiness after starting the one configured service instance:

```zsh
curl -fsS http://127.0.0.1:53147/api/ready >/dev/null && print ready
```

Sign in as the owner, open Manage Agents, explicitly check the requested `/gh` grant, and save. The UI shows requested and effective state separately. Start a fresh agent turn so the server issues a fresh `room_command` lease, use `/help` to confirm `/gh` is listed, then run `/gh recent` against the real repository. The owner Diagnostics inspector should show no exclusion; otherwise use its stable code (`missing-server-config`, `permission-not-granted`, `agent-disabled`, `catalog-revision-stale`, `provider-session-stale`, or `lease-expired`) rather than inspecting credentials.

Structured records are written beneath `.allmyfriendsareagents/logs/authoritative-v1/` in exactly six subsystem-owned JSONL streams: `server-service-lifecycle`, `opencode-harness`, `openrouter-provider`, `generations`, `capability-decisions`, and `security-audit`. Each event has one owner; shared correlation connects related evidence without copying the same event across files. Copy a `correlationId`, response trace ID, or `x-request-id`, then search correlated records, for example `rg '"requestId":"<request-id>"' .allmyfriendsareagents/logs/authoritative-v1/*.jsonl`. Identical records are limited to 20 for an identical payload/scope in a 10-second window. Further copies are suppressed; the next identical record after the window emits one `logging.identical.coalesced` summary. Drop, coalescing, and sink-failure counters are available from the logging foundation without writing the affected payload recursively.

On first Wave 1 startup, former `server.jsonl`, `generations.jsonl`, and `live-dev.log` files (including numbered rotations) are moved deterministically into `.allmyfriendsareagents/logs/legacy-v1/`. A cumulative `migration.json` receipt describes the retired files. `pnpm service:start` and the checked-in supervisor example eliminate creation of a replacement launch-output log.

To disable or roll back, uncheck the roster `/gh` grant, remove the four `GITHUB_READ_*` values from root `.env`, restart the same service instance, and confirm `missing-server-config` and absence from `/help`. Removing these settings does not delete the room database, transcript, roster, or audit. A restart may deliberately start a fresh provider session and cold GitHub read cache; that is cold-cache/session behavior, not data loss. Restore the prior application revision and restart the same service for code rollback.

## Diagnostics and audit

### Local owner diagnostics

The Owner diagnostics view is a Wave 1, explicit-query surface. It uses the durable control-plane OWNER session and CSRF protection; it never asks for, stores, or sends a diagnostic bearer token. The server accepts `/api/control/diagnostics/query` only from a direct loopback transport peer and an authenticated OWNER. Forwarded, real-IP, host, and origin headers cannot turn a remote peer into a local one. Responses use `Cache-Control: no-store` and fail closed without returning diagnostic evidence.

The view starts empty and queries through the same bounded diagnostics contract used by room tooling. An OWNER can inspect self-, room-, project-, and operator-visible records without impersonating another agent or joining every room; this operator override does not alter ordinary project membership, room membership, self identity, lease, capability, or record-visibility checks. Choose a visibility ceiling and one of the six authoritative streams, optionally enter a correlation ID, and explicitly query. The service retains the existing time, selector, result (max 200), scan (max 8 MiB), serialized-response (max 1 MiB), cursor, and fixed-file bounds. Pagination preserves the original query context and a bounded backend scan position, so older evidence remains reachable after a large newest record. Oversized evidence is reassembled from bounded redacted chunks.

Authorized content can include assembled prompts, raw and interpreted provider output, OpenCode stdout/stderr, tool outcomes, provider errors, usage, cost, routing, rate-limit, and cooldown evidence after centralized authentication-secret redaction. Ordinary model output is evidence and is never presented as hidden chain-of-thought. No remote, automatic, third-party, or Wave 2 diagnostics path is enabled by this surface.

Manage Agents displays each effective state, the bounded reason, and remediation guidance. The existing Diagnostics screen contains an explicit-refresh Owner capability inspector. Only the durable control-plane owner can read `/api/control/capabilities?limit=100`; the limit is clamped to 1–200. The response contains policy revision, per-agent safe projections, and recent bounded audit events.

Capability audit outcomes are `configured`, `attempted`, `allowed`, `denied`, `failed`, and `completed`. Records contain only an event ID, timestamp, agent/caller identifier, capability name, outcome, optional correlation ID, and a short redacted reason. Raw command input, selectors, prompts, responses, headers, credentials, and environment are excluded. The durable file retains only the configured maximum.

## Structured logs and correlation

Every JSON line has envelope version, schema version, service name/version, instance ID, deployment commit/epoch (nullable before deployment discovery), environment, timestamp, severity, event, stream, project identity, trace/span/request/operation/generation IDs, an explicit `correlationId`, visibility scope, explicit nullable agent/self/room/operator identities, and bounded nullable outcome/reason fields. A valid incoming W3C `traceparent` keeps its trace ID and creates a new server span; absent or invalid context creates both. Responses return `traceparent` and `x-request-id`, and the same context crosses generation, provider, agent, tool, and subprocess boundaries.

Serialization is centralized, recursive, and evidence-preserving. Authorized assembled prompts, raw and interpreted provider output, subprocess output, tool outcomes, provider errors, usage, cost, routing, rate-limit, and cooldown evidence are retained by their single subsystem owner. Authentication-secret keys, credential-shaped strings, and complete Cookie/Set-Cookie header values are redacted everywhere, including prefixed multi-cookie diagnostic text. Cycles, throwing getters, unsupported values, and depth bounds are represented in place without losing the surrounding event. Ordinary model output is never relabeled as hidden chain-of-thought. Each Pino/pino-roll destination has independent size, time, and retained-count bounds, `0700` directory/`0600` file permissions, and a bounded queue. A single complete record may exceed the ordinary queue capacity when the queue is otherwise empty; concurrent backlog remains bounded, and a full queue drops records observably. Sink failures never fail the served operation.

The structured facade emits startup/shutdown and HTTP boundary events; provider generation and actual room-command lease/tool decisions; assignment reconciliation, lease, manifest, and tool-policy decisions; GitHub store/adapter and read-cache lifecycle; and storage/migration checks. Before each OpenCode subprocess starts, `agent.tool-policy.environment` records only `ready`, `missing`, or `not-configured` for room command, history, and diagnostics. A `scoped-tool-environment-missing` reason identifies failures that occur before a broker request, without recording an endpoint, token, manifest, or other environment value. Startup manifest, lease, tool-policy, and GitHub read-cache snapshots are emitted even when no agent or command is invoked. Direct console output remains only in standalone import and confined Git-broker CLI helpers where stdout/stderr is their user/protocol surface; the server runtime uses the facade.

## Troubleshooting and agent-visible behavior

- `model_unavailable`: refresh discovery and select a listed provider/model/variant.
- `runtime_unavailable`: verify `opencode --version` and server-user PATH/authentication.
- `missing-server-config` for `/gh`: keep or set the requested grant, configure the read-only server binding, then restart and begin a fresh turn/lease.
- `agent_disabled`: reactivate the roster participant.
- `governed_worker_only` or `exclusive_writer_elsewhere`: use an explicit governed implementation handoff; do not try to alter room-agent mode.

Agents see only commands currently effective for them. They never see a disabled command, credential, or hidden reason payload. Humans receive the same bounded denial semantics, and ordinary conversation behavior remains read-only and otherwise unchanged.
