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

Completed by merged PR [#128](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/128). Deployment-specific credentials and live-service canaries are not acceptance gates for this repository work.

## Evidence

- Merge commit `1547cb49173215b4e566f38160f32aff981296ba`.
- PR #128 records the focused and full tests, TypeScript checks, production build, planning-doc guard, and final privacy review.
- Follow-up work is separately tracked by [#131](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/131) and [#132](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/132).
