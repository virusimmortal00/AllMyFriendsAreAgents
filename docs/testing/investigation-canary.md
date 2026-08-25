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

The command creates a disposable Git project and isolated room state under `.runtime/investigation-real-canary/`. It makes one bounded, read-only Codex investigation call and one later foreground Codex turn. It verifies the exact local evidence marker, read-only capability and exclusion payloads, inbox-only delivery, byte-for-byte project immutability, bounded summary reinjection in the generation journal, raw-session non-disclosure, distinct foreground and investigation sessions, inbox closure, and a persisted disabled policy. The live call uses the explicit 64,000-token hard ceiling because Codex CLI accounting includes its provider/runtime context; the normal default remains 6,000 tokens. `AMFAA_CANARY_REAL_MODEL` can override the investigation model; the foreground turn uses the room's configured Codex Sol profile.

The real executor mode refuses to start unless `AMFAA_CANARY_ALLOW_REAL_PROVIDER=true`. Its prompt prohibits network, MCP, credential, and mutation access; the CLI also runs with an ephemeral session and a read-only sandbox. The resulting JSON report retains process diagnostics but does not include the provider's raw response.

For a manual autonomous-initiation observation after this required canary passes:

1. Use a fresh data directory and disposable local project. Configure the real investigation executor, set global investigation concurrency to `1`, and leave the persisted policy disabled.
2. Join as the canary operator, enable the policy, and give one agent a credible but harmless local anomaly with a narrow objective and minimum budget.
3. Confirm the agent emits a private investigation request, the executor receives a fresh provider session with only `READ_PROJECT`, `READ_OBSERVABILITY`, and `RUN_READ_ONLY_TESTS`, and no result is posted into the transcript.
4. While the executor is held, change the room topic or send a superseding room message. Confirm stale foreground work is cancelled while the investigation continues.
5. Complete the investigation, invoke a later foreground turn, and confirm only the bounded inbox summary is reinjected. The raw provider session, private context snapshot, and opaque checkpoint must never appear.
6. Acknowledge and close the result. Disable the policy and stop the executor.

Promotion requires a passing deterministic report, a clean server restart using the same durable directory, no public-field leakage, no concurrency overshoot, and zero provider dispatches caused by unauthenticated requests. Roll back by disabling the policy, activating the emergency stop if work remains, stopping the executor, preserving `investigations.json`, and reverting the application revision.
