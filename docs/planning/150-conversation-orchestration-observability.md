---
id: conversation-orchestration-observability
status: done
issue: 150
updated: 2026-09-01
---

# Conversation orchestration observability

Canonical issue: [#150](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/150).
This is the adopted, experimentally checked implementation design, not a
replacement tracker. All four implementation slices are complete.
Research baseline inspected: commit
`e1c5b9cf5b3371c27f2784b59b3fdd7c1153d7fc`.

## Outcome

An authorized operator can explain a conversation round from structured decision
records, then follow the same trace to the existing full generation and process
evidence when deeper investigation is necessary. Logs preserve useful diagnostic
detail; credentials remain excluded and access remains scoped.

Extend the existing six-stream logging foundation. Do not introduce another
logging backend, external collector, model call, transcript store, or routing
policy. This issue observes decisions; [#147](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/147)
owns address classification and [#149](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/149)
owns changes to termination semantics and participant-facing activity.

The recommended order is: fix queue context and admission evidence; establish
typed interpretation, delivery, and terminal facts; observe those facts through
the existing logger; then add whole-trace navigation. Keep detailed raw evidence
in its existing authorized streams. Do not add a scheduler race fix, an access
bypass, or a new participant-facing diagnostics surface without evidence and a
separate scope decision.

## Acceptance checks

- Each started round attempts exactly one start and one completion record on
  normal return, cancellation, or handled failure, including empty candidate sets.
  Both conversation runners are covered. Process crashes can leave incomplete
  traces; the system must not fabricate completion.
- Slice 1 fixes enqueue-time context isolation, including absence of a request
  context. Accepted, coalesced, and closed-queue admissions are recorded under
  the incoming context before a callback can be discarded or dispatched. A
  rejected callback must not acquire a fictional run or turn.
- Decisions identify their source, target, selection rule, queue state, budget,
  pair cap, action, and stable reason. Deferred work has a recorded disposition
  when the run ends. No routing decision contains message text.
- Parsing records distinguish protocol disposition, declared state, effective
  orchestration inputs, removed content categories, and message-limit omissions.
  Delivery records distinguish eligible output, confirmed delivery, known
  non-delivery, and unconfirmed writes. Finalization covers zero-message,
  cancellation, and thrown delivery paths without changing persistence behavior.
- A multi-participant provider-free fixture reconstructs a yielded turn, a
  dropped duplicate follow-up, a truncated burst, and the terminal reason without
  examining prompts, raw output, or interpreted message text.
- The full trace joins run, turn, generation, provider, OpenCode, and delivery
  evidence, including queued jobs, retries, and concurrent completions. Queued
  and consumed activity/message revisions are distinguishable. Evidence without
  a corresponding decision record remains discoverable.
- Both engines supply typed terminal summaries with branch-derived reasons and
  actual counters. An existing settled flag is not promoted into proof of
  semantic settlement; legacy absence remains unknown.
- Empty or whitespace-only stderr produces no stderr event. Non-empty evidence
  survives redaction; severity follows known process outcome, not stream name.
- Existing local OWNER authorization, visibility, pagination, chunking, and
  storage bounds are preserved. Authorized raw evidence remains available.
- Tests cover useful-data preservation as well as secret removal, independent
  rotation, serialization, coalescing, drops, sink failure, restart, and recovery.
  Slow sinks and throwing observers cannot delay scheduling by awaiting logging
  I/O or alter routing, RNG use, delivery, or cancellation.

## Current state

Slice 1 now captures enqueue-time context and emits versioned admission,
dispatch, coalescing, rejection, shutdown-drop, and snapshot-consumption evidence.
Both HTTP message paths and explicit room actions use the same tested boundary.
No raw-evidence visibility, routing policy, or provider behavior changed.

Slice 2 adds measured parser diagnostics, guarded delivery accounting, additive
branch-derived terminal summaries, and run/turn/attempt correlation. Slice 3 now
consumes these facts in bounded, non-awaiting runtime event adapters. Existing energy
settlement flags, prose pause reasons, follow-up policy, and raw evidence remain.

Slice 3 records branch-owned decisions, turn outcomes, run start/completion, and
pending-entry disposition; stderr severity follows known outcomes. A provider-free
fixture reconstructs a complete structured round through the existing OWNER query.
Slice 4 adds exact whole-trace navigation, incomplete/unpaired evidence summaries,
and responsive result/detail presentation while preserving the existing OWNER
boundary and exact correlation queries. The findings below describe the
**research baseline before slice 1**, verified by source inspection unless
otherwise noted:

| Surface | Implemented behavior and gap |
| --- | --- |
| `server/conversation.ts` | `runEnergyConversation` and `runAgentConversation` both schedule turns. Neither emits decision records. The first returns `settled` and optional prose `pauseReason`; the second returns no summary. |
| `parseAgentTurn` and `shared/message-format.ts` | Parse disposition, state, explicit burst separators, and visible text. Early suppression loses declared-state evidence; filtering and slicing lose removal provenance. Agent name occurrences are not distinguished from direct addresses. |
| `server/index.ts` | Emits interpreted text and delivery counts, but omits disposition/state/continuation/limit evidence and discards the energy runner result. Cancellation can lose committed counts in the returned turn result; a thrown delivery bypasses the later delivery journal append. |
| `server/generation-journal.ts` | Routes evidence to its existing owners; sets generation correlation IDs. Supplied run/turn fields survive generation records but are omitted from separately constructed harness/provider payloads. Emits warning-level stderr whenever the value is defined, including an empty string. |
| `server/authoritative-logging.ts` | Six independently drained/rotated Pino streams; redaction and observable drops/coalescing/failures. Identical-event signatures exclude several envelope identities. |
| `server/diagnostics-query.ts` | Already supports exact trace/request/correlation/generation selectors and bounded chunked evidence. Event-specific fields survive in `content`. An authorized OWNER query can already combine operator and lower-scope evidence without room/project membership or an access bypass. |
| `src/diagnostics.tsx` | Existing cross-stream button queries `correlationId`, not `traceId`; generation correlation alone does not retrieve an entire multi-generation round. |
| `server/job-queue.ts` | Stores callbacks without capturing enqueue-time async context. A provider-free experiment reproduced a second request's job running under the first request's logging context. |

Two accounting cautions matter for instrumentation. The energy runner's
`responseTurns` counts turns with visible output, not all generation attempts.
Its effective ceilings can scale with whole-room participation. Log actual
counters and effective limits, not values inferred from the energy label.
Likewise, `settled: true` can currently mean no explicit unresolved state was
observed; experiments returned the same `{ settled: true }` for all-yielded and
all-failed rounds. The legacy runner returned no result. Neither is a sufficient
terminal explanation by itself.

The proposed parallel hard-message-ceiling overshoot did not reproduce in 1,536
provider-free scheduler scenarios. Current concurrent openings use a one-message
per-turn limit when there is more than one opening; later multi-message turns
are sequential. Keep ceiling and completion-order tests, but do not characterize
overshoot as expected behavior or introduce a speculative reservation system.

### Diagnostic detail and data handling

Keep the evidence-preserving policy documented in
[`capabilities-and-logging.md`](../operations/capabilities-and-logging.md).
Do not add blanket removal of prompt/output fields, participant IDs, model IDs,
or ordinary error messages in the name of privacy.

| Information | Proposed treatment |
| --- | --- |
| Run/turn/generation/message IDs, source/target IDs, rule revisions, thresholds, counters, timing, outcome and reason | Preserve as structured operational evidence. These are necessary to explain decisions. |
| Assembled prompts, raw model output, interpreted visible messages, stdout/stderr, tool results, provider errors/usage/cost | Preserve in existing authorized owner streams. Reference by identity from decision records; do not make extra transcript copies. |
| Authorization headers, complete cookies, credentials, secret environment values, scoped tool tokens/endpoints | Continue centralized and exact-value redaction. No unsafe-debug bypass. |
| Public issue, export, screenshot, or external telemetry | Separate disclosure boundary. Local authorized evidence is not automatically publishable; retain the repository's sanitization and publication requirements. |

New structured records need no private transcript text. That is a schema design
choice, not an instruction to remove the full evidence already retained. Use
fictional fixtures with preservation sentinels for diagnostic detail and separate
secret sentinels. A test must fail if either a credential survives or useful
non-secret evidence disappears. Do not attempt to infer hidden model reasoning.

## Proposed architecture

### 1. Explicit event ownership and contracts

Add a small typed observer to each existing conversation runner. It receives
facts at the decision branch; it does not re-parse output or decide what the
scheduler should do. A server-side adapter writes through the existing
`AuthoritativeLogging` instance. No new destination or competing logger.

Put event payloads and bounded enums used by diagnostics in
`shared/conversation-observability.ts`; keep sink wiring and run-local counters
server-side, for example `server/conversation-observability.ts`. Use a
discriminated union, not a generic spread of `RoomState`, `ConversationTurn`,
instructions, or provider results. Observers synchronously enqueue bounded facts;
they never await sink writes or flushes. Observer exceptions must not alter
routing. Keep the callback contract synchronous; defensively contain accidental
promise rejection without awaiting it if an adapter violates that contract.

| Event | Semantic owner | Stream | Essential payload |
| --- | --- | --- | --- |
| `conversation.job.decision` | Conversation-job queue admission boundary | `generations` | Admission identity, incoming request/trace, action/reason, queued activity/message revision, accepted job identity or retained-job link for coalescing |
| `conversation.job.consumed` | Accepted job's snapshot-read boundary | `generations` | Admission/job identity, original trigger, queued snapshot evidence, and the snapshot actually passed to conversation work |
| `conversation.run.started` | `performConversation` orchestration boundary | `generations` | Mode, effective policy/revision, bounded candidate IDs/count, broadcast flags, concurrency, initial counters |
| `conversation.turn.decision` | Branch in the active runner | `generations` | Decision/turn/source identities, selection family, action/reason, queue/active/pair/budget state |
| `conversation.turn.finished` | Runner's turn accounting boundary | `generations` | Turn and generation link if allocated, status, confirmed delivery and uncertainty counts, effective continuation/state, elapsed time, stable failure/skip category |
| `conversation.run.completed` | Same boundary as run start | `generations` | Engine result, terminal reason/phase, attempted/response/yield/failure counts, visible delivery total, pending-work disposition, duration |
| `generation.interpreted` | Existing parser caller through `GenerationJournal` | `generations` | Existing evidence plus structured interpretation diagnostics |
| `generation.delivery` | Existing delivery owner, one guarded finalizer | `generations` | Retained, confirmed-delivered, confirmed-undelivered, and unconfirmed counts, acknowledged message IDs, stable delivery reason |
| Existing provider and OpenCode events | `GenerationJournal`'s current routing | Existing provider/harness streams | Existing raw evidence and matching context; no second copy in run records |

Run completion is the authoritative terminal event; do not also emit the same
terminal decision from `runJob`. Generation completion means model/process
completion, not successful room delivery. A turn summary references that evidence
and records the orchestration outcome without duplicating provider error text.
The runner supplies its effective policy and counters to the boundary's observer;
the adapter must not independently recalculate scheduling rules for logging.
Queue admission is separate from in-run participant scheduling: a coalesced
conversation job is not a deduplicated participant turn. Exactly-once refers to
one emission attempt by the semantic owner, not guaranteed durable log delivery.

Use `eventVersion: 1` and separate `policyRevision`/`parserRevision` fields.
The existing envelope `schemaVersion` describes infrastructure and is normalized
by the query layer; it must not silently become the parser version. Old records
remain readable with absent new fields treated as unknown, not zero or success.

### 2. Correlation that survives queues and concurrency

- Capture context when a job is enqueued, using a bound callback or a small
  captured-context wrapper around the existing queue. `AsyncLocalStorage.bind`
  is available on the supported Node baseline and passed the isolation probe.
  Preserve the absence of context as well as populated context: merging an empty
  object into the draining request's context does not clear it. Preserve queue
  ordering and coalescing behavior; do not add work to manufacture a trace.
- Give accepted jobs a stable `jobId` and give each admission attempt a decision
  identity. Emit admission at the decision branch, under the incoming context,
  before dispatch or return. A duplicate links to the retained pending job and
  records the coalescing reason; its discarded closure will never log anything.
  A closed queue also records its rejection. Link the accepted job to the actual
  run when execution starts; no run ID is needed for suppressed work.
- Allocate a server-owned `runId` for each actual `performConversation` invocation,
  with a run span under the request trace. Non-HTTP entry points create a trace
  once at their boundary. Keep the request ID when one exists; do not invent a
  request for background work. If a request can launch multiple rounds, `runId`
  distinguishes them within the shared trace.
- Carry `runId`, `turnId`, source turn/decision identity, and a monotonic
  `runEventSequence` through per-turn contexts. Include the run ID and sequence in
  payloads of the new semantic events so distinct decisions are not collapsed by
  the foundation's envelope-independent identical-event signature. Do not globally
  disable coalescing or add random noise to every existing event.
- Preserve existing generation IDs and generation-level `correlationId` behavior.
  Run events may use `runId` as their correlation ID; a whole-round lookup uses
  the already-supported `traceId` selector. Do not overload an existing assignment
  `operationId` or repurpose W3C IDs as domain identifiers.
- Bind the generation ID as soon as the existing generation-start callback makes
  it available, including failed/cancelled attempts. Ensure journaling copies
  run/turn metadata into each destination's payload, not just the generation
  record. Audit retry context and independently arriving tool requests; identities
  absent from a boundary must be linked explicitly, not assumed to propagate.
  Include semantic run/turn/attempt identity in correlated raw-event payloads too:
  envelope-only identity is currently insufficient to prevent cross-attempt
  coalescing of otherwise identical evidence.
- Keep process retry number distinct from logical turn number. The existing
  missing-session retry remains the same generation and turn, with a new attempt
  ordinal. Do not count it as a new conversation response. A later invocation
  resuming a provider session gets a new run/turn, with an explicit continuation
  link if known; session reuse must not silently reuse a finished run's identity.

An enqueue-time trace identifies the triggering request. A queued callback can
read a newer room snapshot. Record queued-at trigger message/activity revision at
admission and consumed message/activity revision at execution. Label unavailable
values unknown; do not infer durable revisions from an unrelated counter.
Context capture alone must not imply the run processed the original request's
exact message. The queue probe observed revision 0 at admission and 1 when
callbacks consumed work.

Source/target identities and sequence establish causality when concurrent turns
finish in a different order from their start. Timestamps alone are insufficient.
Run completion occurs after in-flight turns drain. Emit it in a guarded finalizer
without swallowing or changing the original failure.

### 3. Record the actual selection rule

Keep three dimensions separate:

- `selectionFamily`: `initial-candidate`, `structured-mention`,
  `direct-vocative`, `legacy-name-match`, `ambient-continuation`,
  `fresh-candidate`, `conversation-floor`, `synthesis`, `objection`,
  `reconciliation`.
- `action`: `queued`, `started`, `deferred`, `deduplicated`, `dropped`, `blocked`.
- `reason`: bounded codes such as `eligible`, `target-active`, `target-queued`,
  `target-already-responded`, `pair-cap-reached`, `secondary-chance-missed`,
  `soft-budget-exhausted`, `no-fresh-candidate`, `source-already-used`,
  `hard-message-ceiling`, `hard-turn-ceiling`, `follow-up-allowance-exhausted`,
  `run-cancelled`, and `run-ended`.

Include source/target IDs; source generation/turn and message references when
available; stable pending-decision identity; target-active/queued flags; queue
depth; pair count and limit; response/attempt/delivery totals; remaining message
budget; and the relevant effective threshold. For random selection, record the
draw actually consumed and its threshold/result. Instrumentation must never call
the RNG again. Initial candidate order and preflight decision IDs remain visible
without copying preflight policy into the logger.

Observe both queue admission and eventual consumption, replacement, or discard.
If a deferred entry is overwritten, link the superseding decision. Record why a
candidate was rejected, not only successful launches. At termination, account for
unconsumed entries using bounded per-entry records and/or category totals with an
explicit omitted-detail count; never silently lose pending-work evidence.

At this baseline, agent follow-ups use `legacy-name-match`. Do not label them
`structured-mention` or `direct-vocative`. #147 must supply the real provenance
when it introduces those classifiers. The schema can reserve their vocabulary
now, but #150 alone cannot prove their production emission without that work.
Likewise, observation must not add deduplication policy merely to satisfy a log
fixture: test an existing dropped-repeat branch first.

### 4. Interpretation and delivery accounting

Instrument the existing transformation pipeline, preserving its order and output.
Return an additive diagnostic object from `parseAgentTurn`; do not run a second
parser in the logger. Extend the shared text helpers with measured transformations
while preserving their existing string-returning entry points.

Capture:

- `dispositionStatus`: `missing`, `valid`, or `malformed`;
  `dispositionAction`: `speak`, `yield`, or null; the existing `YieldReason` enum;
  and a separate suppression reason for legacy `NO_RESPONSE_NEEDED`.
- `declaredConversationState` separately from the effective `conversationState`
  returned to orchestration. A suppressed turn may contain a state declaration
  that the current engine never consumes. Logging it must not change that behavior.
- Effective `continuationWorthy`, requested/effective `visibleMessageLimit`,
  and the limit's provenance: default burst cap, remaining room budget, or a
  single-message phase such as opening/synthesis/objection/reconciliation.
- `parsedBurstCount`: number of candidate units after protocol/preface processing
  and splitting explicit `<<<NEXT>>>` separators, before empty filtering and the
  visible limit. This is not the number of OpenCode text parts or model choices.
- `eligibleBurstCount`, `retainedBurstCount`, `truncatedBurstCount`, and categorized
  removed counts. For early whole-turn suppression, mark burst accounting as
  not evaluated rather than claiming there were zero source bursts.

Use a small stable removal vocabulary: `protocol-directive`,
`leading-workflow-preface`, `current-speaker-label`, `unsupported-emoji`,
`empty-burst`, `legacy-no-response`, `structured-yield`,
`malformed-disposition`, and `visible-message-limit`. Track units explicitly
(characters, paragraphs, directives, or bursts); do not sum unlike units. Count
character removal at the transformation that performs it, avoiding overlapping
before/after estimates. Preserve the existing aggregate field for compatibility
but document that it is not a reliable explanation of removal categories.

Where burst accounting is evaluated:

```text
parsedBurstCount = removedBurstCount + eligibleBurstCount
eligibleBurstCount = retainedBurstCount + truncatedBurstCount
retainedBurstCount = confirmedDeliveredBurstCount
                  + confirmedUndeliveredBurstCount
                  + unconfirmedBurstCount
```

The delivery equation is finalized after delivery stops. An unattempted retained
unit is confirmed undelivered by this operation. An acknowledged write is
confirmed delivered; an attempted write that throws without a reliable commit
outcome is unconfirmed, not automatically undelivered. If uncertainty is zero,
this reduces to the ordinary delivered-plus-undelivered equation. Do not retry
writes or change persistence semantics merely to make a log total look complete.

Keep `generation.interpreted` immutable; `generation.delivery` supplies final
counts and reason. Join by generation/turn ID, rather than writing a second
interpreted event or guessing delivery in advance. Use one guarded finalizer for
every interpreted generation's delivery, including zero retained units, partial
cancellation, disabled-agent stops, and thrown persistence paths. Preserve the
original error if logging also fails. A pre-generation gate produces a turn
completion with no generation link; it must not fabricate an interpretation or
delivery event. Generation failure before interpretation remains distinguishable.

Carry confirmed counts and uncertainty through returned failed/cancelled turn
results to the run summary without changing scheduling or cancellation policy.
Record acknowledged message IDs from existing write results. Idempotent command
delivery can return an already-existing message: record its identity and replay
disposition, count each logical delivery unit once, and do not label every call
as a newly inserted room message. New-insertion totals require actual repository
evidence; use unknown rather than inventing it when the API cannot establish it.

### 5. Terminal reasons and severity

Add a typed terminal summary to both engines before wiring terminal observers.
Keep existing caller-visible behavior compatible; preserve the energy runner's
existing fields and add a summary to the legacy runner, whose callers currently
ignore its return. Capture a stable reason at the branch, not by parsing prose
`pauseReason` or reconstructing policy in the logging adapter.

Use terminal families with specific reason codes. Initially describe the branches
that actually exist: cancellation, no visible output, broadcast-settled response,
no explicit unresolved state, open without a second responder, synthesis or
reconciliation yield/settlement, blocked input, no material objection, ceiling,
and unresolved reconciliation. Log the terminal phase and individual ceiling
flags, not only a generic safety-limit string.

Keep `engineSettled` distinct from explicit settlement evidence, failed-turn
counts, and `messageCeilingReached`/`turnCeilingReached`. This exposes ambiguous
outcomes without rewriting policy. Use `engineSettled: null` for legacy absence,
not a fabricated `true`. Summaries include attempted turns, responses, yields,
failures, skips/cancellations, confirmed delivery, uncertainty, pending-work
disposition, and terminal phase. Preserve a "no explicit unresolved state"
branch as such, even when all attempts failed; observed failure counts explain
the ambiguity without silently redefining settlement. A turn failure does not
necessarily terminate the run because the engine can try another participant. An uncaught
run failure receives a failed terminal record with the known error category;
do not call every health gate or internal exception a provider failure.

Align the eventual terminal vocabulary with #149, but do not emit human-handoff
or semantic-settlement evidence until the engine actually supports that decision.
Consume the new additive summary for logging; leave participant-facing status
changes to #149. Prefer one finalized result path over duplicated logging on
every return, with regression tests ensuring policy and turn order are unchanged.

Severity proposal:

- `info`: ordinary selection, queuing, valid yield, duplicate/pair-cap suppression,
  normal cancellation, settlement, blocked-on-human-input state.
- `warn`: malformed disposition, unresolved safety-ceiling stop, recoverable
  process failure/retry, or a known subprocess warning.
- `error`: actual generation/process failure or an unhandled orchestration error.

For stderr, use `typeof value === "string" && value.trim().length > 0` to decide
whether an event exists, but retain the original non-empty text through existing
redaction. Successful process with unclassified stderr: `info`; failed attempt
being retried: `warn`; final process failure: `error`; expected cancellation:
`info`. A structured diagnostic level can override the unclassified case when
available. Do not keyword-classify arbitrary stderr prose or repeat its text in
an extra warning. Existing stream/queue/query bounds still apply; do not introduce
a short text cap that discards the only useful failure evidence.

### 6. Boundedness and honest completeness

New decision records should contain only bounded IDs, enums, scalars, and
roster-limited arrays. Use a proposed 8 KiB serialized ceiling for these new
structured records, verified against maximum-roster fixtures. Retain scalar totals
and an explicit omitted-detail count if optional detail exceeds that limit. This
does not impose an 8 KiB cap on existing raw evidence records.

Do not sample the new bounded decision events in normal operation. Preserve
foundation backpressure and observable drops; distinguish scheduler `dropped`
decisions from logging transport drops. Flush at existing shutdown/test boundaries,
not after every turn. Serialization still consumes CPU before asynchronous writes,
so verify bounded record construction as well as nonblocking I/O.
Test a sink that remains backpressured until after the conversation completes,
not only a sink that throws. The existing logger passed this probe; future
observers must preserve that property and must not accumulate an unbounded
promise queue. No participant-visible transport-counter expansion is required.

Sequence gaps, a missing start/end, sink failures, and outstanding pagination mean
the trace can be incomplete. A sequence plus final attempted-event total can detect
missing structured decisions; global stream drop counters cannot prove loss for a
specific run. Independent stream retention can also leave referenced raw evidence
unavailable. Report that explicitly instead of inventing a result. Exactly-once
emission by one owner is not a crash-proof durability guarantee.

### 7. Owner diagnostics and visibility

Use `operator` visibility for the new decision/run records initially, with
existing raw generation visibility unchanged. This is an initial audience choice,
not a reason to reduce retained detail. Room/project terminal projections remain
an explicit follow-up decision under #149; access to related raw evidence does
not automatically grant access to new operator-only decision records.
The current OWNER query already retrieves operator and lower-scope records with
the same trace ID, even without room/project membership. Use that real authorized
path in fixtures; no special combined visibility or authorization bypass is needed.

Reuse the query service unchanged where possible. Add a trace-ID selection mode
and a whole-trace action to the existing Owner inspector, while preserving the
current correlation-ID search for old records. Query all six streams with the
existing trace selector and unchanged authorization. Persist selector kind/value,
time window, scope, and stream selection across pages and chunks. Never silently
broaden an exact correlation-ID query into a trace search.

Support investigation in both directions: decision-to-generation/raw evidence
and raw-generation-to-run/decisions. Raw evidence with no matching decision must
remain visible, marked unpaired or incomplete rather than filtered out by an
inner join. Missing evidence can mean independent retention, transport loss,
legacy schema, or unfinished work; do not guess which without evidence.

No dedicated timeline UI is required for the first slice: structured JSON and
bounded trace navigation can meet the issue. Before eventual interface edits,
follow the design standards and register evidence for the existing
`ownerDiagnosticsQuery` and `ownerDiagnosticsResults` view-registry entries at
all required responsive checkpoints.

## Next action

The dependency-ordered implementation is complete:

1. **Queue-context fix and admission evidence (implemented).** Fix the reproduced
   defect where a queued job inherits the preceding request's logging context:
   capture context at enqueue time and restore it when that job executes. This
   slice is not complete with a reproduction test alone. Require a provider-free
   regression proving that jobs enqueued under distinct request/trace contexts
   retain their own identities, including a job enqueued without request context,
   while preserving queue ordering, coalescing, and shutdown behavior. Add the
   queue admission event, retained-job links for coalesced requests, and
   queued-versus-consumed activity/message evidence. Establish shared versioned
   event/reason contracts and regression fixtures for semantic coalescing. Do not
   postpone the actual context fix to a later instrumentation slice.
2. **Canonical facts and correlation (implemented).** Thread run/turn/attempt identity into
   generation, harness, and provider payloads. Measure the existing parser's
   transformations. Implement the delivery ledger and guarded finalization;
   return actual delivery facts on cancellation/failure. Add compatible typed
   terminal summaries for both engines before observers depend on them. Freeze
   current routing, turn order, transcript output, and RNG invocation counts.
   Pin the OpenCode source contract before editing mapped integration surfaces.
3. **Structured observation and severity (implemented).** Consume canonical facts at each
   scheduling and terminal branch. Cover both engines, deferred/replaced/dropped
   work, pre-generation gates, concurrent draining, and exceptional exits. Route
   through the existing logger with bounded, non-awaiting observers; fix empty
   stderr emission and outcome-based levels. Verify no useful evidence is lost.
   Keep #147 classification and #149 termination-policy changes separate.
4. **Owner workflow and reconstruction (implemented).** Add the bounded whole-trace selector
   to the existing inspector, preserving exact correlation queries. Verify
   structured-only reconstruction, forward/reverse raw-evidence links, unpaired
   records, real OWNER authorization, pagination, retention gaps, and recovery.
   Update operator documentation and perform the required responsive checks.

The integration inspection command for a likely mapped edit is:

```bash
pnpm check:integration-contracts -- --inspect-files server/agent-runner.ts
```

Inspect every reported upstream path at the pinned commit, update its review
record, and run the reported tests before changing that surface. This proposal
does not need to change the OpenCode transport or redo text-part assembly.

### Verification plan

- Focused contract tests: `server/conversation.test.ts`,
  `src/message-format.test.ts`, `server/generation-journal.test.ts`,
  `server/job-queue.test.ts`, and new event-schema/observer tests.
- Fixture round: concurrent openings; a valid yield; a legacy name-derived
  follow-up; an existing dropped-repeat branch; one four-unit burst with limit
  two; then a stable terminal branch. Assert the exact structured causal sequence,
  actual delivered counts, and unchanged transcript behavior. Separate fixtures
  cover #147 classifications once implemented and both hard ceilings.
- Reconstruction must use a projection that excludes prompt/raw/visible text.
  Separately assert that the authorized evidence still contains that text and
  excludes secret sentinels. Join provider/harness events to the same run and
  reverse-join from raw evidence. Keep an intentionally unpaired raw record
  visible. Test through the current OWNER query, without bypasses.
- Cancellation before generation, during a burst, after session save; failed
  health/capacity gates versus provider failure; missing-session retry and
  session continuation; failure before write and uncertain acknowledgement after
  write; idempotent replay; sink throw, prolonged backpressure, record loss,
  observer exception/rejection, simultaneous completion, and restart with an
  unfinished trace. Require exactly one finalizer attempt, not a guarantee of
  log durability.
- Query/API tests: new operator-only records, denied room/project access, exact
  selectors, old-schema coexistence, rotation overlap, large raw evidence followed
  by older decision records, empty bounded pages, and cursor substitution.
- Final implementation gate: `pnpm run check:quality`,
  `pnpm check:planning-docs -- --self-check`, `git diff --check`, and required
  browser checkpoints. No live provider or paid canary is needed.

## Evidence

### Slice 1 implementation verification

The context-isolation tests failed against the baseline and passed after binding
accepted callbacks at enqueue time. Queue tests cover FIFO order, duplicate
admission, original-context shutdown drops, closed-queue rejection, and observer
throw/rejection/stall. Integration fixtures use the production observation boundary
and logger to verify newer consumed snapshots, preserved background identity,
semantic coalescing isolation, slow sinks, original job errors, serialized-size
bounds (including JSON-escaped IDs), and failed snapshot reads without fabricated
consumption. A fresh query reader round-trips real files through OWNER and denied
project access while preserving useful raw evidence and removing a secret sentinel.

On 2026-08-31, all 21 focused queue/observation tests passed. The full quality gate
passed integration guardrails, UI checks, the production build, and 164 test files
with 1,119 passing tests and one skipped test. The standalone server type check,
planning self-check, active frontmatter/section validation, and whitespace checks
also passed. Re-running the research probe retained zero ceiling violations over
1,536 scenarios and now observed correct unwrapped queue contexts.

```bash
pnpm exec vitest run server/job-queue.test.ts server/conversation-observability.test.ts
pnpm exec tsc -p tsconfig.node.json --noEmit
pnpm run check:quality
pnpm check:planning-docs -- --self-check
git diff --check
```

No mapped OpenCode integration surface or visible interface was changed in this
slice. No live provider call, deployment, or real-room mutation was required.

### Slice 2 implementation verification

The canonical parser now returns versioned diagnostics alongside unchanged
visible/routing results. It measures the actual normalization, filtering, and
truncation pipeline; early suppression uses null/not-evaluated burst counts.
Declared state remains separate from effective state, including a SETTLED marker
on a yielded turn. Removal character counts use UTF-16 code units; emoji grapheme
and burst counts are separate units, not interchangeable totals.

`server/generation-delivery.ts` observes existing persistence calls without
retrying or suppressing them. Each post-interpretation exit attempts one final
record, including thrown writes and later cursor/disposition failures. Counts
partition retained output into acknowledged, unattempted, and unconfirmed units.
Cancellation returns actual delivery facts without changing the scheduler's
visible-message count. A run-local evidence channel preserves facts on thrown
paths without replacing the original error. Acknowledged IDs do not prove new
insertion: the command repository may return an existing message, and its current
API cannot distinguish insertion from replay. No insertion total is invented.

Both engines expose branch-derived summaries. The energy engine's existing
settled flag remains distinct from declared/effective settlement, failures,
cancellation, actual delivery, and individual ceiling flags. Tests retain even
the existing settled-on-cancelled-objection behavior. Legacy semantic settlement
is null. Failure summaries include completed concurrent work after the engine's
existing drain, and pending candidates remain visible. Skipped-turn counts in
this slice cover explicit energy mention suppression; detailed admission and
deferred-work decisions were added in slice 3.

Run/turn scopes preserve enqueue-time job/request/trace identity. OpenCode
subprocess attempts share a turn and generation during missing-session retry;
the failed resume is attempt 1 and the fresh invocation is attempt 2. Ordinals
do not describe retries internal to the provider. Generation, provider, harness,
and tool records retain the same domain identities in their semantic payloads,
preventing identical-log coalescing across distinct work. Older records without
these identities remain readable as unknown rather than synthesized.

Before editing `server/agent-runner.ts`, all reported CLI and permission/tool
source paths were inspected at OpenCode commit
`cb7d8b2f5e44876ef98b661dc10590c915af3a9f` (v1.18.25). Review revision 3 records
the unchanged transport contract. The synthetic subprocess fixture verifies the
actual missing-session recovery path, scoped-tool reminting, identity continuity,
and credential filtering without invoking a live provider.

Focused commands:

```bash
pnpm exec vitest run server/conversation-interpretation.test.ts server/generation-delivery.test.ts server/conversation-run-summary.test.ts server/conversation-context.test.ts
pnpm exec vitest run server/conversation.test.ts server/agent-runner.test.ts server/authoritative-logging.test.ts server/generation-journal.test.ts
pnpm exec tsc -p tsconfig.node.json --noEmit
pnpm run check:quality
pnpm check:planning-docs -- --self-check
git diff --check
```

On 2026-08-31, the full quality gate passed the OpenCode contract tests, UI
guardrails, production build, and 168 test files: 1,157 passing tests and one
skipped test. This slice adds 38 tests. Server type checking and the planning
self-check also passed. The provider-free scheduler probe still covers 1,536
scenarios without a message-ceiling violation; convergence tests additionally
freeze turn order, visible limits, and RNG call counts.

No interface layout, authorization rule, storage schema, provider CLI argument,
or routing policy changes are included. No live-provider or real-room mutation
was required. Structured-only causal reconstruction was not established by these
canonical facts alone; the slice 3 verification below exercises that path.

### Slice 3 implementation verification

Both engines now emit typed configuration, decision, turn-finished, and summary
facts. The orchestration boundary publishes one run start and completion attempt
through the existing generations stream. Each semantic event has a monotonic
`runEventSequence`; completion includes `attemptedEventCount`. A preparation
failure before engine initialization has null configuration/summary, not invented
policy or success. Its start record retains the boundary's actual start time.

Scheduling facts retain pending-entry identity, source turn/generation/message
links where known, preflight decision IDs, actual consumed random draws and
thresholds, pair caps, queue/active state, and effective budgets. Current mentions
remain labeled `legacy-name-match`. Deferred replacement links the old and new
pending identities; residual entries receive terminal drop reasons. Observer
copies prevent a callback from mutating engine-owned facts. No observer reads
prompts or selects a participant.

Turn records distinguish health/capacity refusals, provider or preparation
failure, cancellation, malformed disposition, valid yield, visible output, and
uncertain delivery. Pre-invocation gates do not invent a generation or delivery.
Once a generation ID exists, a refused start reservation is a typed cancellation,
with `invocationStarted: false`; the run-local actual attempt remains absent.
OpenCode's pinned source paths were re-inspected before this mapped runner change,
and review revision 4 records the unchanged transport/permission contract.

An exceptional legacy callback path was also reproduced: a synchronous throw
could bypass the existing rejected-promise drain. The finalizer now waits for
already-started peers, emits their outcomes before the run summary, starts no
additional work, and rethrows the original error. Normal scheduling, transcript
output, settlement semantics, and RNG use remain unchanged.

New metadata records stay within the 8 KiB serialized test budget at the maximum
32-participant roster, including JSON-escaped identities. Optional identity
detail is omitted with explicit counts; existing raw evidence has no new cap.
Backpressure and observer throw/rejection/stall do not block the run. A transport
loss fixture verifies sequence gaps and a final attempted-event total without
mistaking dropped logs for scheduler decisions.

The real-file OWNER query fixture uses pagination and a newly constructed reader
to reconstruct a yield, four parsed bursts capped to three, the existing pair-cap
drop, and the terminal reason using only structured events. It separately proves
that useful prompts/output remain available, a credential sentinel is removed,
generation/provider/harness identities join, and a project-only caller cannot
read operator events. At that stage this established server-side reconstruction,
before slice 4 added the whole-trace interface and its responsive/browser
acceptance.

On 2026-08-31, the final local quality gate passed the pinned integration tests,
UI guardrails, production build, and 170 test files: 1,191 passing tests and one
skipped test. This slice adds 34 tests. Server type checking, planning self-check,
and whitespace validation passed. The 1,536-scenario provider-free scheduler
probe again reported no ceiling violations and preserved queue-context isolation.
No visible interface or storage-schema change required a manual browser or
migration check; no live provider, deployment, or real-room mutation was used.

```bash
pnpm exec vitest run server/conversation-decisions.test.ts server/conversation-run-observer.test.ts server/generation-journal.test.ts
pnpm exec vitest run server/conversation.test.ts server/conversation-run-summary.test.ts server/agent-runner.test.ts
pnpm run check:quality
pnpm check:planning-docs -- --self-check
pnpm exec tsx scripts/research-conversation-observability.ts
git diff --check
```

### Slice 4 implementation verification

The existing OWNER diagnostics workspace now has distinct correlation-ID and
trace-ID selector modes. Correlation queries remain exact. Whole-trace mode sends
only the exact `traceId`, always queries all six authoritative streams, and keeps
the original selector, time window, visibility, stream set, and cursor together
across bounded pages. Selecting either a structured conversation record or raw
generation/provider/harness evidence exposes the same explicit **Open whole
trace** action; it uses the existing local OWNER operator scope rather than a new
authorization path.

Once all pages are loaded, the client reconstructs run completeness from
`runEventSequence`, the start/completion pair, and `attemptedEventCount`. It also
joins `conversation.turn.finished` to raw evidence by `generationId`. Raw records
without a matching decision remain visible and are marked unpaired; decisions
without loaded raw evidence are counted separately. Outstanding pagination is
always incomplete. The interface states that the cause of missing evidence is
unknown rather than choosing among retention, transport loss, legacy schema, or
unfinished work.

Focused tests cover exact selector separation, correlation and trace pagination,
cursor-context preservation, both navigation directions, complete reconstruction,
sequence gaps, missing raw links, unpaired evidence, large-record assembly, local
OWNER authorization, and cross-visibility trace retrieval. The pre-existing query
contract continues to cover selector rejection, cursor substitution, empty scan
pages, old-schema coexistence, rotation overlap, and large raw evidence followed
by older records.

Browser verification used an isolated temporary JSON backend with synthetic,
redacted-safe evidence and no live provider. WORK-10 and WORK-11 passed Phone
(390×844), Tablet (768×1024), Short laptop (1024×600), and Desktop (1440×900).
Phone controls wrapped without introducing viewport-specific height overrides,
and the trace summary used two columns. Tablet, Short laptop, and Desktop retained
the shared adjacent result/detail composition whenever the diagnostics container
was at least 640px wide; narrower containers stacked the panes. Short laptop kept
the close action visible while the workspace body owned vertical scrolling, and
large-screen content remained centered within the shared 1100px bound. Commands
and fields continued to use the application-wide pointer-capability density
tokens. No checkpoint produced document-level horizontal overflow, and the
browser console reported no warnings or errors.

```bash
pnpm exec vitest run src/diagnostics.test.tsx server/owner-diagnostics-api.test.ts server/diagnostics-query.contract.test.ts server/conversation-run-observer.test.ts
pnpm run check:ui-standards
pnpm run check:quality
pnpm check:planning-docs -- --self-check
git diff --check
```

### Tested design findings

The provider-free probe uses the actual queue, async-context helpers, conversation
engines, parser, burst delivery, logger, journal, and diagnostics query service.
It creates isolated temporary evidence files and synthetic identities; no live
room, provider call, credentials, or persistent developer state is used.

```bash
pnpm exec tsx scripts/research-conversation-observability.ts
```

Source: [`research-conversation-observability.ts`](../../scripts/research-conversation-observability.ts).
This is a research harness reporting current behavior, not a regression suite
requiring known defects to remain. Implementation must add assertions for the
desired behavior beside the affected production modules.

| Theory or concern | Observed result | Design consequence |
| --- | --- | --- |
| Pending jobs inherit the draining request's context. | Reproduced: request B and a context-free job both observed A. Binding at enqueue restored B and absence of context respectively. | Ship the actual context fix in slice 1. |
| Capturing accepted callbacks is sufficient for coalescing evidence. | False: duplicate C's callback never ran. Admission inspection retained C's identity; accepted work later consumed a newer activity revision. | Record admission before dispatch/rejection, link retained work, and record queued and consumed revisions separately. |
| Concurrent openings can each deliver three messages and overshoot the ceiling. | No violations across 1,536 scenarios; current multi-opening turns are limited to one message. | Preserve ceiling invariants; do not add a speculative race fix or bless overshoot. |
| The current terminal return explains why a round ended. | All-yielded and all-failed energy rounds both returned `{ settled: true }`; legacy returned no summary. | Add branch-derived typed summaries and separate flags from actual evidence. |
| A partial burst has a simple delivered/undelivered total after any error. | Cancellation retained one acknowledged message. A thrown callback bypassed later completion; simulated persist-then-throw left two stored units but only one acknowledgement. | Finalize on handled paths, retain confirmed counts, and represent unknown commit outcomes explicitly. |
| Retry identities already reach every evidence stream. | Synthetic retry/completion journal entries kept request/trace/generation correlation, but omitted supplied run/turn fields from harness/provider payloads. Empty and whitespace stderr emitted warnings. | Propagate domain identities/attempt ordinals across streams and correct stderr emission/severity. |
| Envelope identity prevents distinct evidence from coalescing. | Two otherwise identical records with different trace/generation envelope IDs collapsed to one; semantic run/sequence payloads retained two. | Include meaningful event identity in signatures/payloads, without globally disabling coalescing. |
| Existing sink backpressure blocks the conversation. | Conversation completed while the generation sink awaited drain; no transport drops in the fixture. | Preserve this property in the new observer, with explicit slow-sink tests. |
| Operator visibility prevents a real OWNER from joining raw evidence. | OWNER retrieved operator decisions plus project raw evidence without membership. A project caller saw raw evidence but not decisions. Unpaired raw evidence remained visible; secret sentinel was redacted and useful text preserved. | Reuse existing scopes/query authority, preserve unpaired records, and avoid an access bypass. |

The ceiling matrix covers four energy levels, candidate counts 1/2/3/5,
concurrency limits 1/2/3/5, whole-room invitation on/off, RNG draws 0/0.99,
plain/open-with-mentions/yield responses, and forward/reverse microtask completion
ordering. It recorded 1,212 overlapping turn starts. It is not exhaustive proof
over arbitrary timing, every policy combination, or a turn executor that ignores
its message limit.

The persist-then-throw case is synthetic fault injection demonstrating ambiguous
acknowledgement, not a reproduced storage durability defect. Journal retry probes
exercise routing, not a live OpenCode missing-session retry; source inspection
established that the existing retry reuses the generation ID. Typed observers,
terminal events, and structured-only reconstruction were absent from that research
baseline; their later implementation evidence is recorded above.

### Local verification of the baseline

On 2026-08-31, dependencies installed with `pnpm install --frozen-lockfile` without
lockfile changes. Node 26.7.0 and pnpm 11.22.0 were available; CI's pnpm 10 matrix
was not run. The following existing baseline suite passed: 14 files, 229 tests.
This verifies the inspected foundation, not the proposed new feature.

```bash
pnpm exec vitest run server/conversation.test.ts server/job-queue.test.ts server/burst-delivery.test.ts server/room-activity.test.ts server/agent-runner.test.ts server/generation-journal.test.ts server/authoritative-logging.test.ts server/structured-logger.test.ts server/diagnostics-query.contract.test.ts server/owner-diagnostics-api.test.ts server/room-diagnostics-tool.test.ts src/message-format.test.ts src/diagnostics.test.tsx server/storage/command-repository.contract.test.ts
```

The research script also passed a standalone strict type check using the
repository's ambient declaration for `pino-roll`:

```bash
pnpm exec tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ESNext --skipLibCheck --strict scripts/research-conversation-observability.ts server/pino-roll.d.ts
```

The planning guardrail self-check, direct validation of this draft's frontmatter
and required sections, and whitespace checks passed. The full quality gate and
browser checkpoints were not run: this change adds a proposal and isolated
research script, not runtime or interface behavior. The future implementation
checks above remain required; passing baseline tests does not satisfy the new
feature's acceptance.

### Primary-source guidance

- [OpenTelemetry log data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/):
  structured event identity, trace/span correlation, and severity based on event
  meaning support the proposed envelope and stderr treatment. This proposal does
  not require adopting an OpenTelemetry SDK or replacing Pino.
- [Node async context documentation](https://nodejs.org/api/async_context.html#static-method-asynclocalstoragebindfn):
  binding callbacks captures the current execution context; use it at deferred
  job boundaries and test isolation rather than assuming queue propagation.
- [Pino asynchronous logging](https://github.com/pinojs/pino/blob/main/docs/asynchronous.md):
  buffering lowers write overhead but may lose recent records on failure.
  Therefore completion is best-effort evidence, not a durable transactional fact.
- [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html):
  retain enough context for analysis, protect secrets and access, and test logging
  failures and resource exhaustion. This informs bounded structured decisions and
  preservation/redaction tests rather than indiscriminate removal of evidence.
- [OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md#capturing-instructions-inputs-and-outputs):
  content capture is configurable and can use separate storage/references with
  different access controls. Generic instrumentation should not capture it by
  default. This application's existing authorized local evidence policy is a
  deliberate application-level choice, not permission for automatic export.
  The conventions are marked Development and have
  [moved repositories](https://opentelemetry.io/docs/specs/semconv/gen-ai/);
  keep internal domain contracts versioned rather than binding them to changing
  GenAI attribute names. The two-level evidence design is an application-specific
  recommendation, not a claim of standards compliance.

## Open questions

- **Cross-issue sequencing:** can #147 provide classification provenance before
  final #150 acceptance? If not, ship honest legacy provenance and explicitly leave
  the new-classifier emission check pending rather than claim it is satisfied.
- **Terminal contract:** agree the shared family/reason vocabulary with #149 before
  freezing version 1. Until policy changes land, expose observed branch reasons
  and the engine's settled flag separately.

No open question requires deleting diagnostic content, changing retention defaults,
adding a cloud service, or broadening publication permission.
