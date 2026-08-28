---
id: optional-observability-integrations
status: blocked
issue: 132
owner: unclaimed
reviewers: []
depends_on: [131]
reported_by: roadmap-reconciliation
updated: 2026-08-28
---

# Wave 2 optional observability integrations

Canonical issue: [#132](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/132)

## Outcome

After Wave 1 contracts stabilize, add default-off Alloy, Loki, Prometheus/OpenMetrics, and Grafana integrations that consume those contracts without changing standalone application behavior.

## Acceptance checks

- Every integration is opt-in, privacy-bounded, low-cardinality where required, and failure-isolated.
- Disabled integrations preserve Wave 1 behavior and resource bounds.
- Tests and generic operator documentation disclose no private deployment details and require no hosted service.

## Current state

Blocked from implementation until [#131](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/131) stabilizes its event, diagnostics, privacy, and failure contracts. The issue remains open for design review.

## Next action

Wait for the Wave 1 contract review; do not introduce adapter code or parallel schemas before it completes.

## Evidence

- Dependency and scope are canonical in issue #132.
