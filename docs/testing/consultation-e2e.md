# Consultation end-to-end compatibility proof

Issue #112 is verified by `server/consultation-e2e.test.ts`. The harness starts a
real Streamable HTTP MCP server, connects the published MCP client SDK, uses a
durable JSON consultation repository, closes and reopens that repository for
restart coverage, and drives the same public tools shipped by the universal
plugin package.

## Reproduce the proof

Run from the repository root with Node.js 24 or newer and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run server/consultation-e2e.test.ts
```

The harness is hermetic. It binds an ephemeral loopback port, creates its state
under the operating system's temporary directory, uses only fake credentials
and deterministic room IDs, and removes the state after each test. It does not
need a provider account or a running application server.

## Compatibility matrix

The first scenario loads each shipped client manifest and executes the complete
start, poll, input, and completion flow twice per package:

| Package | Explicit-tool fallback | Negotiated Tasks + `input_required` |
| --- | --- | --- |
| Codex | polling plus explicit response | task projection plus form elicitation |
| Claude Code | polling plus explicit response | task projection plus form elicitation |
| Cursor | polling plus explicit response | task projection plus form elicitation |
| OpenCode | polling plus explicit response | task projection plus form elicitation |

Every row proves that start returns a durable queued ID before asynchronous
work, exact start replay returns the same acknowledgement, polling exposes
bounded revision events, the blocking question is sanitized, stale and
cross-room input are rejected, valid input resumes work, and completion returns
an explicitly room-attributed structured artifact with synthesis,
recommendations, and preserved dissent. Default starts also prove that no agent
dialogue is invoked.

The same two-room fixture covers sorted discovery, room reads, room-scoped
cursors, message replay and conflicting key reuse, consultation lookup, input,
and cancellation. Attempts to move a cursor, consultation ID, or input across
the room boundary fail without exposing the other room's state.

## Restart, ceilings, and races

The restart scenario opts into dialogue with two participants and explicit
ceilings of two turns, one round, one concurrent call, and ten seconds. It
stops after both turns are durable and synthesis is claimed, reopens the JSON
repository, reconciles the unrelated room and then the owning room, and polls
through the durable uncertainty failure. It asserts the original consultation
ID and synthesis key, exactly two unique turns, no second synthesis dispatch,
and exactly one terminal failure. This is an explicit at-most-once provider
boundary: a persisted `started` claim is never re-invoked after a crash because
the external effect may already have happened.

The cancellation scenario dispatches cancellation while synthesis is in
flight. It proves one terminal winner, exact cancellation replay, rejection of
conflicting reuse of the cancellation key, and no late completion artifact.

## Candidate verification record

The integrated candidate was checked on 2026-08-27 with these commands:

| Check | Command | Result |
| --- | --- | --- |
| Focused E2E | `pnpm exec vitest run server/consultation-e2e.test.ts` | passed: 1 file, 3 tests |
| Consultation/restart regression | `pnpm exec vitest run shared/consultation-domain.test.ts server/storage/consultation-storage.test.ts server/storage/consultation-repository.contract.test.ts server/storage/sqlite-migrations.test.ts server/consultation-service.test.ts server/consultation-mcp.test.ts server/consultation-e2e.test.ts server/room-mcp.test.ts server/universal-plugin-package.test.ts` | passed: 9 files, 57 tests |
| Full suite | `pnpm test` | passed: 125 files, 843 tests; 1 intentional skip |
| Typecheck | `pnpm exec tsc -b --force` | passed |
| Production build | `pnpm build` | passed |
| Plugin package contract | `pnpm exec vitest run server/universal-plugin-package.test.ts` | passed |
| Codex plugin validator | `/Users/virusimmortal00/.codex/venvs/skill-validator/bin/python /Users/virusimmortal00/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/all-my-friends-are-agents` | passed |
| Canonical skill validator | `/Users/virusimmortal00/.codex/venvs/skill-validator/bin/python /Users/virusimmortal00/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/all-my-friends-are-agents/skills/room-consultation` | passed |
| Planning guard | `pnpm check:planning-docs` | passed |
| Patch whitespace | `git diff --check` | passed |

The absolute validator paths above are Codex desktop runtime paths. On another
host, use the corresponding `plugin-creator/scripts/validate_plugin.py` and
`skill-creator/scripts/quick_validate.py` from that Codex installation.
