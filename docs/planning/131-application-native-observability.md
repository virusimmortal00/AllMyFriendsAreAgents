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

Active implementation wave after completed issue #126. Alloy, Loki, Prometheus/OpenMetrics, Grafana, and deployment are excluded and tracked separately in #132.

## Next action

Implement the canonical issue in focused streams and prepare an independent consolidated review before publication.

## Evidence

- Merged PR [#128](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/128) supplies the completed baseline without making #131 a continuation of #126.
