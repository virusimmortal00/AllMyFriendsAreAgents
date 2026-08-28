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

After Wave 1 contracts stabilize, add default-off Alloy, Loki, Prometheus/OpenMetrics, and Grafana integrations that consume those contracts without changing standalone application behavior or diagnostics.

## Acceptance checks

- Every integration is opt-in, failure-isolated, and consumes Wave 1 rather than defining parallel logging or query contracts.
- Loki uses low-cardinality labels and structured metadata; Prometheus/OpenMetrics exposes stable low-cardinality metrics.
- Standalone-friendly Compose examples, dashboards, alerts, and retention/label guidance work without a hosted service; Promtail is excluded and OpenTelemetry compatibility does not make its JavaScript Logs SDK the core logger.
- Tests and generic operator documentation disclose no private hostnames, domains, paths, topology, credentials, or deployment plans.

## Current state

Blocked from implementation until [#131](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/131) stabilizes its streams, envelope, query, visibility, privacy, and failure contracts. The issue remains open for design review.

## Next action

Wait for the Wave 1 contract review; do not introduce adapter code or parallel schemas before it completes.

## Evidence

- Dependency and scope are canonical in issue #132.
