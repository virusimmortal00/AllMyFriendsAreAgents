---
id: capabilities-and-structured-logging
status: done
issue: 126
---

# Agent capabilities and structured logging

Tracking issue: [#126](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/126)

## Outcome

One server-owned policy resolves configured, runtime-available, and effective capabilities per roster participant. Manage Agents presents that safe projection, unavailable actions fail closed, `/gh` remains read-only, and agent processes never inherit service or provider credentials. Capability decisions and use are bounded and auditable. Server logs are structured, correlated, redacted, and rotated.

## Acceptance checks

- Capability policy, denial, environment filtering, projection, and mobile-safe UX tests.
- Capability audit retention and sensitive-input exclusion tests.
- W3C trace propagation/creation, redaction, safe error, request correlation, and rotation tests.
- Complete tests and production build on one isolated branch; one PR and one review round after owner approval.

## Current state

Implementation is isolated on `codex/3-32-capabilities-logging`. No live-service mutation or PR publication is part of this work unit.

## Evidence

Final command results and immutable commit are reported to the coordinating task after verification.
