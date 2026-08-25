# Investigation canary and smoke testing

The investigation canary runs a real room server and a deterministic loopback executor against disposable state under `.runtime/investigation-canary/`. It does not invoke a model provider.

```bash
pnpm run canary:investigations
```

The command validates the default-off and authentication gates, evidence confinement, public projections, read-only capability payload, inbox-only completion and closure, per-agent and global concurrency, room-activity independence, checkpoint/restart recovery, uncheckpointed shutdown, provider-session collision, budget exhaustion, failed or malformed providers, policy revocation, emergency stop, and production reopening of the durable audit chain. A JSON report and the isolated durable state remain in the printed run directory.

## Limited real-provider canary

Run this only after the deterministic canary passes:

1. Use a fresh data directory and disposable local project. Configure the real investigation executor, set global investigation concurrency to `1`, and leave the persisted policy disabled.
2. Join as the canary operator, enable the policy, and give one agent a credible but harmless local anomaly with a narrow objective and minimum budget.
3. Confirm the agent emits a private investigation request, the executor receives a fresh provider session with only `READ_PROJECT`, `READ_OBSERVABILITY`, and `RUN_READ_ONLY_TESTS`, and no result is posted into the transcript.
4. While the executor is held, change the room topic or send a superseding room message. Confirm stale foreground work is cancelled while the investigation continues.
5. Complete the investigation, invoke a later foreground turn, and confirm only the bounded inbox summary is reinjected. The raw provider session, private context snapshot, and opaque checkpoint must never appear.
6. Acknowledge and close the result. Disable the policy and stop the executor.

Promotion requires a passing deterministic report, a clean server restart using the same durable directory, no public-field leakage, no concurrency overshoot, and zero provider dispatches caused by unauthenticated requests. Roll back by disabling the policy, activating the emergency stop if work remains, stopping the executor, preserving `investigations.json`, and reverting the application revision.
