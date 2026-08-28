---
id: application-native-observability
status: active
issue: 131
owner: unclaimed
reviewers: []
depends_on: []
reported_by: roadmap-reconciliation
updated: 2026-08-28
---

# Wave 1 Pino logging and project-scoped diagnostics

Canonical issue: [#131](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/131)

## Outcome

Replace the custom logger with `pino` and independently bounded `pino-roll` streams, then expose their evidence through one backend-neutral query service, a lease-bound `room_diagnostics` tool, and owner Diagnostics. The feature works fully from local rotated files.

## Acceptance checks

- Authoritative versioned streams cover service lifecycle, OpenCode, provider, generation, capability, and security/audit events with one shared correlation envelope and unambiguous ownership.
- Rotation replaces unbounded logging, uses safe modes, recovers after restart, remains nonblocking, and reports dropped/coalesced events; existing `server.jsonl` and `generations.jsonl` have compatible access or a documented migration.
- The query service and tool provide bounded generation, event, provider-health, and correlation operations with `self`, `room`, `project`, and `operator` scopes; owner Diagnostics uses the same contract.
- Authorized project diagnostics preserve assembled prompts, provider input/output evidence, OpenCode stdout/stderr, tool outcomes, errors, usage, cost, routing, and throttling evidence. Central redaction removes authentication material; unavailable hidden provider reasoning is never claimed.
- Domain, API/tool, isolation, redaction, visibility, rotation, recovery, concurrency, query, UI/mobile, and regression tests plus public operator/agent documentation cover the contract.
- Verification uses fixtures, tests, sentinel scans, and local builds; it requires no private credential, deployment, external collector, or live-service canary.

## Current state

Wave 1 is implemented as a local-file candidate after completed issue #126. Alloy, Loki, Prometheus/OpenMetrics, Grafana, and deployment are excluded and tracked separately in #132.

## Next action

Run an independent consolidated review of the immutable Wave 1 candidate before publication.

## Evidence

- Merged PR [#128](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/128) supplies the completed baseline without making #131 a continuation of #126.

## Implementation verification trace

- Six-stream ownership, correlation, rotation, migration, queue metrics, and complete large-record preservation map to `server/authoritative-logging.ts`, `server/structured-logger.ts`, and `server/generation-journal.ts`; focused coverage is in `server/authoritative-logging.test.ts`, `server/structured-logger.test.ts`, and `server/generation-journal.test.ts`.
- Bounded local-file selection, correlation, visibility enforcement, redacted chunking, rotation overlap, and scan continuation map to `server/diagnostics-query.ts`; the reusable backend contract and oversized-record/older-evidence regressions are in `server/diagnostics-query.contract.test.ts`.
- Lease-bound self/room/project access maps to `server/room-diagnostics-tool.ts`, with scope, substitution, expiry, result-bound, redaction, and transcript-isolation coverage in `server/room-diagnostics-tool.test.ts`.
- Direct-loopback OWNER, session, CSRF, no-store, and fail-closed behavior maps to `server/owner-diagnostics-api.ts`, with route coverage in `server/owner-diagnostics-api.test.ts`. Explicit-query UI parity, preserved pagination context, chunk reassembly, and client-side defense-in-depth redaction map to `src/diagnostics.tsx` and `src/diagnostics.test.tsx`.
- Central authentication-material redaction maps to `shared/diagnostic-redaction.ts` through `sanitizeLogValue`; regression coverage includes prefixed multi-cookie text so no secondary cookie value survives. Authorized diagnostic evidence remains intact.
- Public operation, migration, configuration, query bounds, redaction, and evidence semantics are documented in `docs/operations/capabilities-and-logging.md`. Verification is repository-local: focused tests, the full test suite, planning-document synchronization, and the production build; it needs no credential, deployment, collector, or live-service canary.
