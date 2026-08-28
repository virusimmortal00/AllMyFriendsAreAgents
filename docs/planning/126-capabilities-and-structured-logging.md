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

Implemented and merged into `main` through pull request
[#128](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/128).
Capability resolution, safe projection, structured logging, audit behavior, and
their denial and failure paths are covered by the repository test suite.

## Evidence

- Initial implementation:
  [`dff07d9`](https://github.com/virusimmortal00/AllMyFriendsAreAgents/commit/dff07d9)
- Review follow-up and final verification:
  [`3e38546`](https://github.com/virusimmortal00/AllMyFriendsAreAgents/commit/3e38546)
- Merge commit:
  [`1547cb4`](https://github.com/virusimmortal00/AllMyFriendsAreAgents/commit/1547cb4)
