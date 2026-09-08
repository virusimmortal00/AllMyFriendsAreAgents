# Room-tool application smoke

Run the provider-free application smoke for the generation-attempt lease contract
tracked in [#143](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/143):

```bash
pnpm exec vitest run server/room-tool-application.test.ts
```

The test boots `server/index.ts` against disposable JSON and SQLite storage and a
clean fixture Git repository. A human joins through HTTP and submits `/task`.
The real runner invokes a fake OpenCode executable that calls the actual
`room_command` and `room_diagnostics` HTTP endpoints using the server-issued
subprocess environment. The brokers, command runtime, local diagnostics service,
persistence, cancellation, and session save/restart paths are not mocked.

Each backend exercises:

1. A first turn with successful tool calls and idempotent replay while active.
2. A resumed provider session reported missing by the fake executable, followed
   by one fresh-session retry. The retry's tools work while old tokens fail.
3. Completion retiring both leases, including cached-result requests.
4. Topic-change cancellation during an active subprocess, rejection of cancelled
   tokens, and absence of a late result in the transcript.
5. A subsequent turn receiving usable independent leases.
6. Application restart rejecting old tokens while a new turn resumes the saved
   provider session with new leases.
7. Generation/attempt audit correlation across retry, with no tool credentials or
   complete tool endpoint URLs in application logs.

Ports are ephemeral; state, keys, and the project checkout are temporary. The
application uses the existing test-only home-directory isolation and rejects
outbound fetches. The fake executable only contacts loopback endpoints. Opaque
fixture leases stay in memory and are excluded from assertion output. Cleanup
stops child processes and removes fixture storage.

This is an application/backend smoke, not a model or browser test. It exercises
the stock CLI lane with a deterministic executable, not the downstream SDK server,
real OpenCode tool discovery, a live model provider, or browser interactions.
The complementary `server/room-tool-attempt.test.ts` covers the injected structured
transport and additional failure/revocation cases. No production credentials,
provider quota, real repository writes, or deployment are required.

## Opt-in live CLI check

With explicit authorization to consume provider quota, run:

```bash
AMFAA_CANARY_ALLOW_REAL_PROVIDER=true \
AMFAA_CANARY_ROOM_MODEL=openrouter/anthropic/claude-haiku-4.5 \
pnpm exec tsx scripts/room-tool-live-canary.ts
```

This separate canary requires the audited stock OpenCode 1.18.25 binary and an
existing OpenRouter credential in OpenCode's credential store. The model is
explicit; other OpenRouter selections can be supplied. It is never
run by the normal test suite or quality gate.

Two live generations discover and call the actual `room_command` help and
`room_diagnostics` self-scope tools. The second generation runs after an
application restart and must resume the provider session. Server audit records
must show accepted calls for both tools under each distinct generation, and the
model must deliver the requested completion marker. The fixture project must
remain clean. Each generation has a two-minute polling deadline; cleanup stops
the room process and removes temporary room state, CLI sessions, and the private
credential-store copy. Only sanitized pass/fail output is printed.

The application remains loopback-only, uses isolated JSON storage, and disables
its external fetch transport. The real CLI can contact the selected provider;
its prompt restricts work to the two read-only tools. These are two bounded
generations, not a hard token or monetary cap. The live canary does not inject a
missing-session error or exercise cancellation, SQLite, the downstream SDK lane,
or a browser; the provider-free tests above cover the deterministic lifecycle
failures and both storage backends.

The September 8, 2026 live investigation reproduced two separate failures:

- GPT-4.1 mini supplied an invented cursor on its initial diagnostics query.
  The HTTP boundary returned `400 invalid-cursor`, correctly enforcing cursor
  provenance. Omission guidance alone did not resolve the behavior. The adapter
  now allows null for unused optional selectors, removes nulls before calling
  the server, and provides a bounded recovery message for invalid cursors.
- Haiku delivered successful tool results and a completion marker with extra
  text. The canary now checks for the marker in an agent-authored message, rather
  than requiring the entire response to match byte-for-byte. Human command text
  cannot satisfy this check, and both accepted tool audits remain mandatory.

After these changes, both GPT-4.1 mini and Claude Haiku 4.5 passed the initial and
restart phases through OpenRouter on stock OpenCode 1.18.25. These are bounded
smoke observations, not a reliability estimate. The canary also checks model
availability before submitting work so discovery failures do not appear as
provider execution timeouts. A test-only HTTP observer retains only selector
presence, HTTP status, and allowlisted error codes; all temporary evidence is
removed during cleanup.

## Regression proof

The September 8, 2026 pre-PR check copied the current source into a disposable
directory and ran `room-tool-attempt.test.ts`, `room-diagnostics-tool.test.ts`,
`room-diagnostics-adapter.test.ts`, and `live-canary-cleanup.test.ts`: all 30 tests
passed. Each of the following
changes was then applied independently and produced assertion failures:

- Make attempt authority remain active after cancellation or completion.
- Reuse old scoped tools during the structured missing-session retry.
- Remove the authority recheck after queued command-runtime resolution.
- Remove the diagnostics stale-attempt check.
- Remove lease retirement when preparation fails before generation activation.
- Remove null-selector normalization in the diagnostics adapter.
- Remove the invalid-cursor recovery message.
- Retain empty identity/correlation objects after null normalization.
- Remove the canary's SIGINT/SIGTERM handling.

Restoring the original source returned all 30 tests to green. These are targeted
mutation controls, not a checkout of the complete previous implementation. No
provider calls were made, and the disposable copy was removed afterward.
