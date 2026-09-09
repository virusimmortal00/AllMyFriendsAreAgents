---
id: protected-participation
status: active
issue: 154
updated: 2026-09-08
---

# Outcome

A participant explicitly assigned bounded read-only review or research leaves
ordinary chat scheduling until it has caught up and delivered a relevant update
or recorded that no update is needed. Autonomous anomaly investigations retain
their existing concurrent lane.

# Acceptance checks

- Protected admission and foreground dispatch share a server-owned exclusion
  boundary scoped to room, participant, and work identity.
- Work survives ordinary messages and topic changes. Cancellation requests and
  confirmed termination are distinct; retained checkpoints survive both.
- Return processing persists its inputs before attempting generation, checks the
  latest conversation context, and records delivery exactly once across restart.
- Owner-visible status and authenticated CLI controls consume the same contract.
- Recovery preserves read-only authority and never invents implementation jobs or
  grants source-write capabilities.

# Current state

Protected work uses the existing bounded investigation executor and a durable
`protected-work.json` participation/return ledger for both room backends. New records
carry an audited read-only admission bound to their storage scope. SQLite uses
server/room/project/reference identity and the room attachment revision. The
single-room JSON backend uses its canonical room ID and canonical state directory.
The persisted record also binds the participant, work ID, project-path hash,
policy revision, and bounded capabilities through the existing audit projection.

Execution and resume require the same scope and current policy, project, and
emergency-stop checks. Explicit source-work reconciliation denials remain
mandatory. Read-only admission does not grant implementation-job authority or
modify source-work authorization for other services.

The admission field is additive. Legacy records and their audit chains remain
readable without rewriting historical events. Missing admission is not inferred
from a checkpoint or restored from a former boot-local grant. Such work remains
ineligible for execution; its evidence is retained, and a fresh explicit request
is required. JSON directory relocation or switching storage backends similarly
requires fresh admission. No existing job is silently rebound.

Explicit initiation is available in Window → Investigations and through the
authenticated `room:tool work` CLI. Who’s Here and participant status show the
objective, phase, and elapsed execution time. Queued time is not execution time.
The existing investigation API remains the autonomous concurrent lane.

# Next action

Validate the integrated flow and review its rendered states before promotion.
Protected admission shares the canonical room generation gate; ordinary review,
mentions, commands, and foreground tasks cannot dispatch the reserved participant.
Other rooms are rejected by the protected API until their investigation runtime
is supported; an explicit room ID never silently selects the canonical room.

| Participation state | Entry condition | Exit condition |
| --- | --- | --- |
| Available | No outstanding protected work or return | Atomic protected admission succeeds |
| Queued | Participant reserved; executor capacity pending | Worker dispatch or stop request |
| Busy | Worker dispatch confirmed; execution timestamp set | Completion, stop request, failure, or blocked work |
| Stopping | Human requests stop for this exact work identity | Worker termination confirmed; late callbacks discarded |
| Catching up | Durable return package exists and worker is no longer running | Relevance decision and bounded report persisted |
| Report pending | Report prepared against an identified conversation cursor | Idempotent delivery acknowledged, or context change requires reassessment |
| Blocked | Authority, provider, budget, or recovery prevents progress | Explicit authorized recovery or terminal no-update disposition |

Reservation covers asynchronous admission as well as active execution. Every
canonical participant-dispatch path honors it; queued mentions are rechecked and dropped
rather than accumulated for replay. Existing foreground execution must finish or
be explicitly stopped before protected execution begins. Other participants keep
using normal capacity.

The return package contains a bounded findings summary, evidence references,
unresolved questions, completion/interruption status, timestamps, and departure
cursor. It contains neither hidden reasoning nor raw provider-session state.
Stopped work with no checkpoint says that partial findings are unavailable.

Return work is scheduled on completion or confirmed termination without waiting
for another human message. It uses participant deltas, cached summaries, recent
messages, and the existing exact-history tool. It classifies findings as relevant,
superseded, or requiring qualification. A changed conversation cursor before
posting requires reassessment. Delivery uses a stable work-bound identity so a
crash between message persistence and acknowledgement cannot duplicate a report.
Ordinary participation resumes only after delivery or an explicit no-update
record. This contract does not change room settlement policy tracked in #149.

# Evidence

- [Issue #154](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/154)
- `server/investigation-authority.ts`: scoped read-only admission and revalidation.
- `server/investigation-recovery.test.ts`: both repositories reopened on JSON and
  SQLite; checkpoint resume, concurrent retries, old callbacks, durable inbox,
  legacy admission, scope/policy changes, and reconciliation denial.
- `scripts/investigation-canary.ts`: provider-free application smoke including
  checkpoint/restart recovery and a validated foreground-session collision fixture.
- `server/protected-work-service.test.ts`: admission, cancellation, revocation,
  interrupted return, and delivery acknowledgement recovery.
- `server/protected-work-application.test.ts`: real authenticated CLI and isolated
  application, dispatch exclusion, stop acknowledgement, JSON/SQLite restart.
- `tests/visual/protected-work.visual.ts`: initiation and return controls across
  the Chromium/WebKit viewport matrix.
- `docs/testing/investigation-canary.md`: commands and recovery limits.

# Open questions

None for this slice. Stopped protected workers require a fresh explicit request
for further execution; the legacy Resume endpoint rejects them. Return processing
is checked every second, with three attempts of at most 60 seconds each before
blocking visibly. Waiting for shared generation capacity does not consume an
assessment attempt. Explicit retry resets this return budget; replaying the same
authenticated retry identity does not reset it again. A confirmed stopped
worker may be released through a durable no-update disposition. Executor
termination must be acknowledged for interrupted attempts; aborting an HTTP
request alone is insufficient.

The existing canonical-room investigation scope is retained. Extending this lane
to additional room runtimes requires their own room-scoped reservations and
executor lifecycle, rather than sharing the canonical participant gate.
