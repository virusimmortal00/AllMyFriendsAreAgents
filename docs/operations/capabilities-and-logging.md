# Capabilities, audit, and structured logging

The server is the authority for agent capabilities. For every configured roster participant it resolves configured, runtime-available, and effective states plus a per-command gate record. Each command record reports whether the feature is compiled, required server configuration exists, the server ceiling includes it, the roster is enabled, the requested grant and command-catalog revision are current, and the provider session is fresh. It also includes effective commands, bounded lease issuance/expiry status, last manifest issuance, and the last bounded rejection. Stable exclusions include `missing-server-config`, `permission-not-granted`, `agent-disabled`, `catalog-revision-stale`, `provider-session-stale`, and `lease-expired`. The browser never receives tokens, credential paths, environment values, or provider responses.

## Capability model

`conversation` requires an enabled roster entry, a currently available selected OpenCode model, and an available OpenCode runtime. `github_read` additionally requires the server-only read binding, server ceiling, current catalog grant, and fresh provider-session binding. `project_write` is never effective in the room lane: writes require the existing exclusive, governed implementation-worker assignment and its confined worktree. Selecting a legacy writable participant does not turn a room generation into a writer.

The lease and manifest fields in this projection come from `RoomCommandToolBroker`, the component that issues the actual `room_command` lease. Its safe snapshot contains no token or provider session identity. It records bounded, deduplicated issued/refreshed/expired/revoked and accepted/rejected events with only a closed command name and, for `/gh`, a `recent`, `pr`, `issue`, or `ci` selector family—never arguments. It compares session identity internally and exposes only freshness and a stable reason.

The `/gh` contract is strictly read-only. The command grammar accepts only `recent`, `pr <positive number>`, `issue <positive number>`, and `ci [positive PR number]`. The server broker performs fixed GitHub GET requests against the configured repository. It does not expose a token, arbitrary URL, HTTP method, request body, ref, shell, `gh` CLI, contribution operation, merge, or deployment operation to an agent. Disabling the capability removes `/gh` from the issued room-command token and guide; recovery rechecks permission before execution.

Device-user credentials refresh on demand when the access token expires. The vault serializes reads, refreshes, and mutations within the server process, reloads the encrypted record, and persists the replacement access/refresh pair before releasing a token. Expired installation tokens, expired refresh tokens, and failed refreshes never fall back to an expired access token. Project authority is checked again after credential resolution. Reconnect GitHub when the existing authorization can no longer be refreshed. This uses the [GitHub device-flow refresh contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens); it does not require disabling token expiration or adding a client secret.

The production runtime emits `github.credential.refresh` to the `security-audit` stream for each attempted refresh and its completed or failed outcome. A generated correlation ID pairs these events; they include only the credential revision and a closed failure reason (`upstream`, `invalid-response`, or `storage-failed`). Tokens, vault references, response bodies, and raw errors are excluded. Completion means the replacement pair was persisted. Audit delivery uses the existing logging system's buffering and failure handling; a sink failure does not change credential resolution.

Failed `/gh` reads retain `httpStatus` and a bounded, validated `githubRequestId` in execution diagnostics and the `github.read-cache` log event when an HTTP response exists. HTTP 401 explicitly identifies credential rejection. Response bodies and authentication headers are excluded. These are optional additions to existing diagnostic JSON: older records remain readable and unchanged, with missing fields meaning unknown, not a successful HTTP response. Restart and round-trip coverage includes both old and new records; no database schema rewrite is needed.

For both humans and agents, GitHub reads are `gh` subcommands transported through the existing `room_command` tool; there is no separate GitHub tool. Checking the roster grant records requested intent only. It grants no authority by itself: server configuration, the server ceiling, current catalog revision, active roster entry, fresh provider session, and the current server-issued lease must still make the command effective.

Agent child environments remove all `ALL_MY_FRIENDS_ARE_AGENTS_*`, `AGENTWIRE_*`, database URLs, and names that look like tokens, secrets, passwords, API/private/access keys. This includes `GH_TOKEN`, `GITHUB_TOKEN`, and provider API keys. The room-command, room-history, and room-diagnostics endpoint/token family plus the room-command manifest can enter the subprocess only through an exact-key, server-owned scoped channel; values supplied through the ordinary process environment are removed. These ephemeral broker values are injected only when that capability is present and remain absent from prompts, API projections, diagnostics, audits, and logs. Captured OpenCode stdout and stderr are exact-value redacted for the injected endpoint and token values before protocol parsing or generation journaling.

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

Join the room, open Manage Agents, explicitly check the requested `/gh` grant, and save. Joined human members can manage the canonical-room roster without an owner credential; mutations require the member's room-session CSRF token. Server-only GitHub configuration and the owner Diagnostics inspector retain their existing administrator checks. Successful roster mutations emit an operator-visible `room.roster.audit.changed` event with the server-resolved actor kind/ID, room ID, and previous/next revisions, including before owner bootstrap; no names, prompts, model credentials, or CSRF tokens are included. The UI shows requested and effective state separately. Start a fresh agent turn so the server issues a fresh `room_command` lease, use `/help` to confirm `/gh` is listed, then run `/gh recent` against the real repository. The owner Diagnostics inspector should show no exclusion; otherwise use its stable code (`missing-server-config`, `permission-not-granted`, `agent-disabled`, `catalog-revision-stale`, `provider-session-stale`, or `lease-expired`) rather than inspecting credentials.

Structured records are written beneath `.allmyfriendsareagents/logs/authoritative-v1/` in exactly six subsystem-owned JSONL streams: `server-service-lifecycle`, `opencode-harness`, `openrouter-provider`, `generations`, `capability-decisions`, and `security-audit`. Each event has one owner; shared correlation connects related evidence without copying the same event across files. Copy a `correlationId`, response trace ID, or `x-request-id`, then search correlated records, for example `rg '"requestId":"<request-id>"' .allmyfriendsareagents/logs/authoritative-v1/*.jsonl`. Identical records are limited to 20 for an identical payload/scope in a 10-second window. Further copies are suppressed; the next identical record after the window emits one `logging.identical.coalesced` summary. Drop, coalescing, and sink-failure counters are available from the logging foundation without writing the affected payload recursively.

On first Wave 1 startup, former `server.jsonl`, `generations.jsonl`, and `live-dev.log` files (including numbered rotations) are moved deterministically into `.allmyfriendsareagents/logs/legacy-v1/`. A cumulative `migration.json` receipt describes the retired files. `pnpm service:start` and the checked-in supervisor example eliminate creation of a replacement launch-output log.

To disable or roll back, uncheck the roster `/gh` grant, remove the four `GITHUB_READ_*` values from root `.env`, restart the same service instance, and confirm `missing-server-config` and absence from `/help`. Removing these settings does not delete the room database, transcript, roster, or audit. A restart may deliberately start a fresh provider session and cold GitHub read cache; that is cold-cache/session behavior, not data loss. Restore the prior application revision and restart the same service for code rollback.

## Diagnostics and audit

### Local owner diagnostics

The Owner diagnostics view is a Wave 1, explicit-query surface. It uses the durable control-plane OWNER session and CSRF protection; it never asks for, stores, or sends a diagnostic bearer token. The server accepts `/api/control/diagnostics/query` only from a direct loopback transport peer and an authenticated OWNER. Forwarded, real-IP, host, and origin headers cannot turn a remote peer into a local one. Responses use `Cache-Control: no-store` and fail closed without returning diagnostic evidence.

Use **Window → Server Administration** or the **Server administration** card in your profile to sign in. A denied Diagnostics request offers **Sign in to server administration** and returns here after owner authentication. Sessions expire eight hours after sign-in and end on server restart. Signing out preserves the claimed owner and room membership.

The view starts empty and queries through the same bounded diagnostics contract used by room tooling. An OWNER can inspect self-, room-, project-, and operator-visible records without impersonating another agent or joining every room; this operator override does not alter ordinary project membership, room membership, self identity, lease, capability, or record-visibility checks. Choose a visibility ceiling and one of the six authoritative streams, optionally enter a correlation ID, and explicitly query. The service retains the existing time, selector, result (max 200), scan (max 8 MiB), serialized-response (max 1 MiB), cursor, and fixed-file bounds. Pagination preserves the original query context and a bounded backend scan position, so older evidence remains reachable after a large newest record. Oversized evidence is reassembled from bounded redacted chunks.

Authorized content can include assembled prompts, raw and interpreted provider output, OpenCode stdout/stderr, tool outcomes, provider errors, usage, cost, routing, rate-limit, and cooldown evidence after centralized authentication-secret redaction. Ordinary model output is evidence and is never presented as hidden chain-of-thought. No remote, automatic, third-party, or Wave 2 diagnostics path is enabled by this surface.

Manage Agents displays each effective state, the bounded reason, and remediation guidance. The existing Diagnostics screen contains an explicit-refresh Owner capability inspector. Only the durable control-plane owner can read `/api/control/capabilities?limit=100`; the limit is clamped to 1–200. The response contains policy revision, per-agent safe projections, and recent bounded audit events.

Capability audit outcomes are `configured`, `attempted`, `allowed`, `denied`, `failed`, and `completed`. Records contain only an event ID, timestamp, agent/caller identifier, capability name, outcome, optional correlation ID, and a short redacted reason. Raw command input, selectors, prompts, responses, headers, credentials, and environment are excluded. The durable file retains only the configured maximum.

## Structured logs and correlation

Every JSON line has envelope version, schema version, service name/version, instance ID, deployment commit/epoch (nullable before deployment discovery), environment, timestamp, severity, event, stream, project identity, trace/span/request/operation/generation IDs, an explicit `correlationId`, visibility scope, explicit nullable agent/self/room/operator identities, and bounded nullable outcome/reason fields. A valid incoming W3C `traceparent` keeps its trace ID and creates a new server span; absent or invalid context creates both. Responses return `traceparent` and `x-request-id`, and the same context crosses generation, provider, agent, tool, and subprocess boundaries.

Serialization is centralized, recursive, and evidence-preserving. Authorized assembled prompts, raw and interpreted provider output, subprocess output, tool outcomes, provider errors, usage, cost, routing, rate-limit, and cooldown evidence are retained by their single subsystem owner. Authentication-secret keys, credential-shaped strings, and complete Cookie/Set-Cookie header values are redacted everywhere, including prefixed multi-cookie diagnostic text. Cycles, throwing getters, unsupported values, and depth bounds are represented in place without losing the surrounding event. Ordinary model output is never relabeled as hidden chain-of-thought. Each Pino/pino-roll destination has independent size, time, and retained-count bounds, `0700` directory/`0600` file permissions, and a bounded queue. A single complete record may exceed the ordinary queue capacity when the queue is otherwise empty; concurrent backlog remains bounded, and a full queue drops records observably. Sink failures never fail the served operation.

The structured facade emits startup/shutdown and HTTP boundary events; provider generation and actual room-command lease/tool decisions; assignment reconciliation, lease, manifest, and tool-policy decisions; GitHub store/adapter and read-cache lifecycle; and storage/migration checks. Before each OpenCode subprocess starts, `agent.tool-policy.environment` records only `ready`, `missing`, or `not-configured` for room command, history, and diagnostics. A `scoped-tool-environment-missing` reason identifies failures that occur before a broker request, without recording an endpoint, token, manifest, or other environment value. If OpenCode reports a missing persisted session, the server clears it, remints scoped command and diagnostics leases against the fresh attempt, and retries once without `--session`. Startup manifest, lease, tool-policy, and GitHub read-cache snapshots are emitted even when no agent or command is invoked. Direct console output remains only in standalone import and confined Git-broker CLI helpers where stdout/stderr is their user/protocol surface; the server runtime uses the facade.

### Conversation queue evidence

The `generations` stream includes two operator-visible, version-1 event types for
room-message, developer-message, and explicit room-action jobs:

| Event | Meaning |
| --- | --- |
| `conversation.job.decision` | `queued`/`eligible`, `started`/`queue-ready`, `coalesced`/`key-already-pending`, or `rejected`/`dropped` with `queue-closed`. Admission precedes dispatch or rejection; shutdown records pending-job drops. |
| `conversation.job.consumed` | An accepted job read the snapshot passed to conversation work. This is not a run-completion or delivery-success event. |

Every admission has an `admissionId`, every decision has a `decisionId`, and only
accepted jobs get a `jobId`. A coalesced admission has `jobId: null` and a
`retainedJobId` linking to the pending job it did not replace. `pendingCount`
excludes the active job. Distinct decisions retain their semantic identity even
when request envelopes or other payload fields otherwise match.

`triggerMessageId` identifies the actual submitted message when known; explicit
actions leave it null. `queued` and `consumed` each contain the latest message ID,
latest human-message ID, and process-local activity revision at that boundary.
They can differ: a pending job can consume messages newer than its trigger.
The activity revision is not a durable database version or a message count.
Absent evidence is null. Optional identity strings exceeding 256 characters are
omitted with an explicit `omittedDetailCount`; generated admission/job/decision
identities remain intact. These fixed-shape records fit the 8 KiB structured-event
budget and contain no message text. Existing raw-evidence bounds are unchanged.

Queued callbacks and shutdown disposition preserve their enqueue-time trace,
including absence of a request ID for background work. New background conversation
admissions establish a trace without fabricating an HTTP request. Observers enqueue
without awaiting destination writes; a failed observer cannot replace a job error.
Existing log drops, independent retention, or a crash can leave evidence incomplete.

Select operator visibility in OWNER diagnostics to include these records alongside
authorized raw evidence. Queue admission or consumption does not prove delivery
or completion.

### Conversation interpretation, delivery, and identity

`generation.interpreted.interpretation` contains versioned parser diagnostics:
disposition validity/action, suppression reason, declared and effective state,
continuation, effective message limit/source, actual filtering counts, and burst
truncation. Early suppressed output has null burst counts with
`burstAccounting: "not-evaluated"`, not fictional zero parsed units. Character
counts use UTF-16 code units; emoji graphemes and bursts are counted separately.
Existing interpreted text and authorized raw evidence are retained.

`generation.delivery` attempts one guarded final record after interpretation,
including empty output, partial cancellation, and thrown persistence or later
state-update paths. `retainedBurstCount` equals the sum of
`confirmedDeliveredBurstCount`, `confirmedUndeliveredBurstCount`, and
`unconfirmedBurstCount`. An unconfirmed write may have committed before rejecting;
do not treat it as definite non-delivery. `acknowledgedMessageIds` identify returned
room messages, including idempotent replay results. They do not establish how many
new messages were inserted. `deliveredMessageCount` remains a compatibility alias
for confirmed logical delivery units. A crash or failed sink can still leave a
missing final record; an attempted finalization is not a durability guarantee.

Conversation jobs now carry a fresh `runId`, each attempted turn has a `turnId`,
and subprocess evidence carries `attemptOrdinal` alongside `generationId`.
Pre-generation gates have no generation/attempt identity. A missing-session
retry keeps its turn and generation IDs, with ordinal 1 on failed-resume evidence
and 2 on the fresh invocation. These are local subprocess attempts, not
provider-internal retry counts. Later runs and turns receive new IDs even when
the provider session is reused. Payload identities survive projection into the
generation, provider, and harness/tool streams and distinguish otherwise identical
records for coalescing. Missing identities on older records remain unknown.

Both scheduling engines also return typed terminal summaries for runtime
instrumentation. `engineSettled` is the existing engine flag, not proof of
consensus; legacy absence is null. Separate counters report failed/cancelled
turns, explicit settlement, confirmed delivery, and uncertainty. These summaries
now feed the runtime records below.

### Conversation decisions and completion

The generations stream now includes operator-visible `conversation.run.started`,
`conversation.turn.decision`, `conversation.turn.finished`, and
`conversation.run.completed` records. `runId` is their correlation ID; `traceId`
also links the queued job and the existing generation/provider/harness evidence.
Raw records keep generation-level correlation IDs. No exact query is silently
broadened to a whole-trace search.

Each decision has a `decisionId`; `pendingDecisionId` persists from queue/defer
through start, replacement, or drop. `relatedDecisionId` links a replaced pending
entry to its successor's pending identity. A turn ID is allocated on start, not
for discarded work. Source turn/generation/message IDs are retained when known.
Current name-based mentions are labeled `legacy-name-match`, not a new address
classifier. Target flags reflect the runner's scheduling sets, not the presence
of a live OS process. Random-draw fields report the draw actually consumed; no
additional draw is made for logging.

`conversation.turn.finished` records parser and delivery facts without copying
message text. Health/capacity gates have outcome `blocked` while preserving the
engine's original failure flag separately; they are not provider failures.
Confirmed delivery and uncertain acknowledgement remain visible even when the
turn or subsequent state update fails. Expected cancellation and valid yield are
informational; malformed disposition is a warning; actual failures are errors.

`conversation.run.completed` is the sole authoritative terminal emission attempt.
It follows active-turn draining and pending-entry disposition. Its summary keeps
the original settlement flag distinct from evidence. A preparation exception
before engine initialization records null configuration/summary and a bounded
error category; it does not invent a provider failure. Full errors remain in
their existing diagnostic owner stream.

`runEventSequence` is monotonic within a run, and the final
`attemptedEventCount` includes the completion event. Missing sequences, an absent
start/end, unfinished pagination, or unavailable retained raw records indicate an
incomplete view. Counts describe emission attempts, not guaranteed persistence.
Do not confuse a scheduler `dropped` decision with the logging transport's drop
counter. New structured metadata is bounded with `omittedDetailCount`; there is
no new truncation cap on existing prompts or process output.

Empty or whitespace-only stderr emits no event. Non-empty stderr keeps its
original redacted text: successful/unclassified output is `info`, a retried
failure is `warn`, final process failure is `error`, and expected cancellation is
`info`. Explicit structured diagnostic levels can classify otherwise-unclassified
output; words such as "error" in arbitrary stderr do not set severity. A refused
generation-start reservation is cancellation with `invocationStarted: false`,
not a failed subprocess.

### Owner whole-trace workflow

Open **Window → Diagnostics** from a loopback browser signed in to a local OWNER
session. Queries remain explicit and bounded to the last hour; the page does not
load log evidence automatically.

- Choose **Correlation ID** to preserve an exact legacy or generation-level
  lookup. This selector is never silently converted into a trace query.
- Choose **Trace ID (whole trace)** to query all six authoritative streams with
  the exact trace selector. The stream control is disabled in this mode because
  excluding a stream would make the label misleading.
- From either a structured conversation decision or a raw generation/provider/
  harness record, choose **Open whole trace**. This explicit action switches to
  operator visibility and all streams so an OWNER can investigate in either
  direction without changing the query service's authorization rules.
- Use **Load next bounded page** until no cursor remains. Selector kind/value,
  time window, visibility, and streams are retained by the cursor-bound query;
  editing the visible controls does not substitute a different selector into an
  outstanding cursor.

The trace summary reports structured runs, detected sequence gaps, unpaired raw
records, and decision links whose raw evidence is not loaded. A trace remains
incomplete while pages remain. After the final page, raw evidence without a
matching decision stays in the result list and is marked **Unpaired**. Missing
evidence can result from independent retention, transport loss, legacy schema,
or unfinished work; the inspector reports the cause as unknown unless the loaded
records establish it. Existing recursive authentication-material redaction still
applies, while useful prompts, output, parser facts, usage, cost, and routing
evidence retain their established visibility and bounds.

## Troubleshooting and agent-visible behavior

- `model_unavailable`: refresh discovery and select a listed provider/model/variant.
- `runtime_unavailable`: verify `opencode --version` and server-user PATH/authentication.
- `missing-server-config` for `/gh`: keep or set the requested grant, configure the read-only server binding, then restart and begin a fresh turn/lease.
- `agent_disabled`: reactivate the roster participant.
- `governed_worker_only` or `exclusive_writer_elsewhere`: use an explicit governed implementation handoff; do not try to alter room-agent mode.

Agents see only commands currently effective for them. They never see a disabled command, credential, or hidden reason payload. Humans receive the same bounded denial semantics, and ordinary conversation behavior remains read-only and otherwise unchanged.
