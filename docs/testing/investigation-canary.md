# Investigation canary and smoke testing

The investigation canary runs a real room server and a deterministic loopback executor against disposable state under `.runtime/investigation-canary/`. It does not invoke a model provider.

```bash
pnpm run canary:investigations
```

The command validates the default-off and authentication gates, evidence confinement, public projections, read-only capability payload, inbox-only completion and closure, per-agent and global concurrency, room-activity independence, checkpoint/restart recovery, uncheckpointed shutdown, project-identity revocation, provider-session collision, budget exhaustion, failed or malformed providers, policy revocation, emergency stop, forged-checkpoint rejection, and production reopening of the durable audit chain. A JSON report and the isolated durable state remain in the printed run directory.

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
