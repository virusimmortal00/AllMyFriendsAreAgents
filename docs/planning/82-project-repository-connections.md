---
id: project-repository-connections
status: done
issue: 82
---

# Verified project repository connections

Tracking issue: [#82](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/82)

## Outcome

Projects own zero or one revisioned repository connection whose local Git identity is verified server-side. The connection records an immutable canonical GitHub remote, canonical checkout and common Git directory, branch and policy epochs, non-overlapping assignment root, validation and sensitive-path policy, and an opaque credential reference that is never included in public state or worker environments.

Repository connection mutations use exact revisions, fail closed on path or identity drift, and refuse disable or rebind while active or unreconciled durable assignment, job, broker, contribution, merge, or deployment references remain. A lazy project registry owns the connection, writer slot, broker audit, and service state shared by every room attached to the project without granting repository authority through attachment.

## Acceptance checks

- Canonical connect, inspect, reconcile, disable, drift, revision, overlap, durable-reference, redaction, and environment-confinement tests.
- Cross-project isolation and same-project room sharing tests.
- Durable identity, assignment confinement, Git broker, contribution, deployment, replay, migration, full-suite, typecheck, build, planning guardrail, and diff checks on the final reviewed head.

## Evidence

Implemented on the focused issue branch and delivered through the pull request that closes #82. Final command, review, merge, and ancestry evidence is recorded on the issue.
