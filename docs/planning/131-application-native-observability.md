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

# Wave 1 application-native observability

Canonical issue: [#131](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/131)

## Outcome

Stabilize application-native structured logging and the authenticated owner diagnostics service, tool, and responsive UI. Migrate remaining covered emitters/readers and keep tests and documentation aligned with the shared contracts.

## Acceptance checks

- Review maps contracts to implementation, migration, tests, and documentation.
- Privacy enforcement, bounds, correlation, failure isolation, authorization, and responsive UI have focused coverage.
- Verification uses fixtures, tests, sentinel scans, and local builds; it requires no private credential, deployment, external collector, or live-service canary.

## Current state

Active incremental work after completed issue #126. External observability integrations are excluded.

## Next action

Prepare the focused reviewer trace and implementation plan from the canonical issue.

## Evidence

- Merged PR [#128](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/128) supplies the completed baseline without making #131 a continuation of #126.
