# Investigation canary and smoke testing

The investigation canary runs a real room server and a deterministic loopback executor against disposable state under `.runtime/investigation-canary/`. It does not invoke a model provider.

```bash
pnpm run canary:investigations
```

The command validates the default-off and authentication gates, evidence confinement, public projections, read-only capability payload, inbox-only completion and closure, per-agent and global concurrency, room-activity independence, checkpoint/restart recovery, uncheckpointed shutdown, project-identity revocation, provider-session collision, budget exhaustion, failed or malformed providers, policy revocation, emergency stop, forged-checkpoint rejection, and production reopening of the durable audit chain. A JSON report and the isolated durable state remain in the printed run directory.

## Durable recovery checks

```bash
pnpm exec vitest run server/investigation-recovery.test.ts server/investigation-service.test.ts server/investigation-api.test.ts
```

Recovery tests close and reopen both the room repository and investigation store
for JSON and SQLite. They verify retained checkpoints, one accepted concurrent
resume, rejected old callbacks, one durable inbox result, and denial after scope
or policy changes. The canary seeds its collision session through the room store
with an enabled fixture participant and verifies that reopening preserves it.

New investigations persist a server-only read-only admission in the audited job.
This admission is checked on dispatch, progress, completion, and resume; it never
grants implementation or source-write authority. Legacy jobs without admission
remain readable, but cannot resume automatically. Preserve their checkpoints and
create a fresh explicitly authorized request. Moving JSON state to another
canonical directory or migrating to another backend also requires fresh admission.
Explicit reconciliation denials, policy changes, project changes, and emergency
stop continue to prevent execution.

These checks cover the autonomous investigation lane. Protected participation has
additional application tests using the real authenticated CLI, a disposable room
server, and deterministic loopback worker/model fixtures:

```bash
pnpm exec vitest run server/protected-work-application.test.ts server/protected-work-service.test.ts server/protected-work-store.test.ts server/protected-return.test.ts
pnpm exec playwright test --config tests/visual/playwright.config.ts protected-work.visual.ts
```

The application tests exercise ordinary action/task/mention exclusion, automatic
return without another human message, stop acknowledgement, and restart on JSON
and SQLite. The service tests cover concurrent admission, stale callbacks,
configuration/policy revocation, return interruption budgets, and message delivery
before acknowledgement. Browser interaction checks supplement the independent
screenshot review required by `docs/testing/visual-review.md`.

## Protected work controls and executor termination

In the canonical room, choose **Window → Investigations**, select a participant,
and enter a bounded objective. Who’s Here and participant status show its work
phase and elapsed execution time. **Stop and return to chat** preserves partial
findings and waits for confirmed worker termination before catch-up. A blocked
return retains its package and offers retry or an explicit no-update disposition.

The CLI uses the same room-scoped API:

```bash
pnpm room:tool work list --room=<room-id>
pnpm room:tool work start "Review the navigation tests" --room=<room-id> --agent=<participant-id> --request-id=<stable-request-id>
pnpm room:tool work stop --room=<room-id> --work-id=<work-id> --request-id=<stable-stop-id>
pnpm room:tool work retry-return --room=<room-id> --work-id=<work-id> --request-id=<stable-retry-id>
pnpm room:tool work dismiss --room=<room-id> --work-id=<work-id> --request-id=<stable-dismiss-id>
```

Configure `ALL_MY_FRIENDS_ARE_AGENTS_DEVELOPER_TOKEN` locally from a developer-team
member with `ROOM_READ` for listing and `COMMAND_RUN` for mutations. The legacy
room read/chat token does not gain command authority. Reuse the start request ID
with the same objective when retrying an uncertain response. Mutations target the
exact work identity; an old stop cannot affect a replacement request.

For interrupted attempts the executor must implement
`DELETE <INVESTIGATION_EXECUTOR_URL>/<investigation-id>/attempts/<attempt>` using
the same bearer authentication as dispatch. Return `{ "terminated": true }` only
after that exact worker has stopped. Request abort, a missing endpoint, an error,
or an unconfirmed response leaves participation blocked. The server waits at
most two seconds per acknowledgement request; the operator can retry Stop when
the executor is reachable. Late results cannot overwrite retained findings.
The deterministic canary executor acknowledges its held fixtures; its optional
real-provider mode deliberately does not claim termination acknowledgement.

Completed reports use a separate context-aware read-only chat turn. Catch-up is
bounded to three 60-second attempts, with current-context revalidation before
idempotent delivery. Further worker execution needs a new protected request;
the ordinary investigation Resume control cannot bypass the return boundary.

Final review regression coverage also verifies concurrent and durable replay of
rejected admission, inbox closure before reservation release, serialization of
dismissal against delivery, and preservation of an already delivered disposition
after acknowledgement failure. The browser tests retain action identities after
lost responses and exclude unassessed protected findings from the autonomous
inbox. Durable history retention and archival are defined in
[`docs/operations/protected-work-retention.md`](../operations/protected-work-retention.md)
and tracked in [#176](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/176).
Do not truncate active receipts or audit chains to enforce an ad hoc storage
limit; new admission fails before the recovery reserve is consumed. Regression
coverage also verifies that crossing the detailed archive deletion boundary
removes only terminal backing investigation state and permits the retired request
identity to be admitted again.

### Protected browser smoke evidence

On 2026-09-09, a fresh production build was exercised in desktop Chromium using
the real application API, isolated JSON storage, and the deterministic executor
and model fixtures from `server/protected-work-application.test.ts`. Browser
requests were not intercepted or mocked. The manual smoke verified:

1. Join, open Window → Investigations, and start protected work.
2. Return to Chat and mention the busy participant: the objective and elapsed
   timer remain visible, and no foreground model dispatch occurs.
3. Complete the held worker: one return report appears automatically and the
   participant becomes available.
4. Start another job, refuse executor termination, and press Stop: the participant
   remains blocked and no return assessment runs.
5. Confirm termination and press Stop again: one report appears for that job;
   a later mention receives an ordinary reply.

Server-side assertions checked one stable report identity per job, exactly two
fresh read-only return assessments without command tools, and ordinary dispatch
resumption. The browser reported no uncaught errors. A temporary harness reused
the application-test fixture; this manual desktop check complements the committed
JSON/SQLite CLI tests and the separate responsive browser matrix.

No intended live investigation executor was configured for this check. Its
completion and exact-attempt termination remain unverified. Before enabling this
experimental lane against a deployed executor, run one bounded completion and
one confirmed-cancellation case with that executor using disposable state, verify
worker termination independently, and confirm that refusal or timeout preserves
busy exclusion. The optional real-provider canary below does not establish this
termination contract. Keep the policy disabled until those checks pass.

## Automated limited real-provider canary

Run this only after the deterministic canary passes and only when two provider calls are acceptable:

```bash
AMFAA_CANARY_ALLOW_REAL_PROVIDER=true pnpm run canary:investigations:real
```

The command creates a disposable Git project and isolated room state under `.runtime/investigation-real-canary/`. It makes one bounded, read-only Codex investigation call and one later foreground Codex turn. It verifies the exact local evidence marker, read-only capability and exclusion payloads, inbox-only delivery, byte-for-byte project immutability, bounded summary reinjection in the generation journal, raw-session non-disclosure, distinct foreground and investigation sessions, inbox closure, and a persisted disabled policy. The live call uses the explicit 96,000-token hard ceiling because Codex CLI accounting includes repeated provider/runtime context across tool turns; the normal default remains 6,000 tokens. `AMFAA_CANARY_REAL_MODEL` can override the investigation model; the foreground turn uses the room's configured Codex Sol profile.

The real executor mode refuses to start unless `AMFAA_CANARY_ALLOW_REAL_PROVIDER=true`. Its prompt prohibits network, MCP, credential, and mutation access; the CLI also runs with an ephemeral session and a read-only sandbox. The resulting JSON report retains process diagnostics but does not include the provider's raw response.

To additionally require a live foreground agent to initiate the job through an `AGENT_DECISION` before the isolated provider call, run:

```bash
AMFAA_CANARY_ALLOW_REAL_PROVIDER=true AMFAA_CANARY_AUTONOMOUS_INITIATION=true pnpm run canary:investigations:real
```

This strict mode adds one provider call. Model behavior is intentionally part of the smoke test: failure to emit the private bounded request fails the run rather than silently substituting a human-created job.

For further manual observation after these canaries pass:

1. Use a fresh data directory and disposable local project. Configure the real investigation executor, set global investigation concurrency to `1`, and leave the persisted policy disabled.
2. Join as the canary operator, enable the policy, and give one agent a credible but harmless local anomaly with a narrow objective and minimum budget.
3. Confirm the agent emits a private investigation request, the executor receives a fresh provider session with only `READ_PROJECT`, `READ_OBSERVABILITY`, and `RUN_READ_ONLY_TESTS`, and no result is posted into the transcript.
4. While the executor is held, change the room topic or send a superseding room message. Confirm stale foreground work is cancelled while the investigation continues.
5. Complete the investigation, invoke a later foreground turn, and confirm only the bounded inbox summary is reinjected. The raw provider session, private context snapshot, and opaque checkpoint must never appear.
6. Acknowledge and close the result. Disable the policy and stop the executor.

## Staged production rollout

The repository has no committed deployment target or secret store, so production executor credentials must be installed by the deployment operator. Deploy the application revision first with the persisted policy disabled and these settings:

```dotenv
ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATIONS_ENABLED=false
ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_CONCURRENCY=1
ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_DEFAULT_TOKEN_LIMIT=6000
ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_EXECUTOR_URL=https://executor.example.test/v1/investigations
ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_EXECUTOR_TOKEN=<secret-store-reference>
ALL_MY_FRIENDS_ARE_AGENTS_INVESTIGATION_PROGRESS_BASE_URL=https://room.example.test
```

The default token-limit setting initializes new policy state only; existing durable policy remains authoritative. Tune it to measured executor accounting before first initialization, never above 96,000. Do not commit the token value. Restrict the executor to the room service, authenticate both dispatch and progress paths, and keep executor-side network and mutation capabilities disabled.

Roll out in this order:

1. Verify `/api/ready`, executor health, a clean restart against the same durable directory, and zero dispatches while the policy is disabled.
2. Run the deterministic canary, then the strict autonomous real-provider canary in a pre-production environment using a disposable project.
3. Enable the persisted policy through an authenticated room session. Keep global concurrency at `1` for the initial observation window.
4. Monitor dispatch counts, terminal status, elapsed/token/tool usage, provider-session collisions, blocked jobs, inbox depth, and emergency-stop state. Treat unexpected public summaries or project changes as immediate rollback conditions.
5. Acknowledge and close the canary result before expanding concurrency. Raise concurrency only through a separately reviewed configuration change.

Promotion requires passing reports, no public-field leakage, no concurrency overshoot, no project mutation, distinct provider sessions, and zero dispatches caused by unauthenticated requests. Roll back by disabling the policy, activating the emergency stop if work remains, stopping the executor, preserving `investigations.json` and generation journals for audit, rotating the executor token if compromise is suspected, and reverting the application revision.
