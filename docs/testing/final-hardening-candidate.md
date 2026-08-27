# Final hardening candidate (#106–#112)

This candidate integrates current `origin/main` with the universal room MCP and
consultation stack while preserving room commands, polls, private messages, and
GitHub-read recovery.

## Issue mapping

- #106: keeps explicit opaque room identity, authenticated room scoping,
  cursor isolation, bounded message idempotency state, and operation-specific
  401/403 authorization.
- #107: hardens the durable consultation domain and JSON/SQLite repositories
  with member-scoped idempotency, strict stored-schema validation, atomic
  affinity writes, immutable keyset pagination, and upgrade-safe migration 0024.
- #108: persists requested dialogue limits before execution initialization,
  restores duties after restart, journals provider dispatch before invocation,
  and fails terminally rather than repeat an uncertain external effect.
- #109: enforces the shared generation ceiling for production consultation
  turns and synthesis and retains sanitized, authority-free prompts.
- #110: enforces consultation read/write/cancel capabilities independently and
  caps polling deltas at the requested `event_limit` in fallback and negotiated
  task projections.
- #111: preserves one canonical room-consultation skill with thin Codex,
  Claude Code, Cursor, and OpenCode adapters and credential-neutral manifests.
- #112: covers fallback and MCP 2026-07-28 Tasks/input negotiation, two-room
  isolation, restart uncertainty, cancellation races, member-scoped replay,
  write-only/cancel-only credentials, and deterministic restart synchronization.

## Independent-review dispositions

PostgreSQL was configurable even though the complete room startup repository
did not exist. The runtime now advertises only JSON and SQLite. PostgreSQL
migration 0018 remains a forward schema artifact with corrected numbering,
member-scoped uniqueness, and deletion-consistent foreign keys; it is not a
runtime support claim.

Cross-process exactly-once completion cannot be promised across SQLite/JSON and
independent provider CLIs. The runner therefore implements a durable
at-most-once external-dispatch contract: it commits a stable operation key and
`started` claim before every turn or synthesis call, commits output and
`completed` atomically with the corresponding domain effect, and never invokes
a `started` operation after restart. An uncertain crash becomes one explicit
terminal failure instead of duplicate provider execution.

The reported lockfile mismatch and credential-neutral canonical `mcp.json`
remain non-findings: dependencies are locked and installed, and all credentials
are intentionally supplied by users outside the package.

## Verification

- `pnpm exec vitest run shared/consultation-domain.test.ts server/storage/consultation-storage.test.ts server/storage/consultation-repository.contract.test.ts server/storage/sqlite-migrations.test.ts server/consultation-service.test.ts server/consultation-mcp.test.ts server/consultation-e2e.test.ts server/room-mcp.test.ts server/universal-plugin-package.test.ts` — 9 files, 57 tests passed.
- `pnpm test` — 125 files passed; 840 tests passed and 1 intentional platform skip.
- `pnpm build` — TypeScript project build and Vite production build passed.
- `pnpm check:planning-docs` — planning documents are synchronized.
- `python validate_plugin.py plugins/all-my-friends-are-agents` under the bundled validator virtualenv — passed.
- `python quick_validate.py plugins/all-my-friends-are-agents/skills/room-consultation` under the bundled validator virtualenv — passed.
- `git diff --check` — passed.
