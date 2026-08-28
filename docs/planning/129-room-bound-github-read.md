---
id: room-bound-github-read
status: done
issue: 129
---

# Room-bound read-only GitHub commands

Tracking issue: [#129](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/129)

## Outcome

The delivered `/gh` grammar now resolves GitHub authority exclusively from the authenticated invocation's server-owned room, current durable project attachment, current verified repository connection revision, and that connection's server-held credential reference. The process-global repository selector is no longer an execution authority.

Authorization and a versioned room/repository lease are revalidated before cache access, immediately before and after upstream access, before durable caching, replay, recovery, and publication. Sanitized cache entries are shared only within an immutable project, connection, revision, and canonical repository scope; room rebinds, connection revisions, disablement, verification loss, identity drift, and missing credentials fail closed with stable private reasons and cannot reach prior entries.

Lifecycle room message routes intercept slash text before transcript persistence and dispatch through a short-lived, serialized `CommandRuntime` bound to the authenticated member's acquired SQLite room repository. The runtime is closed after each operation, while the sanitized GitHub cache remains process-global for independently authorized same-project reuse.

Room-route snapshots retain the server protocol identity required for reconnect reconciliation, expose only a sanitized diagnostic readiness state, and keep invoker-scoped GitHub diagnostics addressable through the authenticated room. The room poll projection is also served from the same room repository so reconnect polling cannot escape scope or fall through to unrelated routes.

## Acceptance checks

- Human text and agent `room_command` paths retain the five #98 forms and converge on one `CommandRuntime` room-bound executor.
- General, missing-project, missing/disabled/unverified/drifted/stale connection, and missing-credential states fail before cache or upstream access.
- Same-project rooms independently authorize and reuse sanitized entries; distinct projects and rebound or revised connections do not collide.
- The adapter remains fixed-host, HTTPS, REST-only, GET-only, bounded, rate-limited, truncated, redacted, and incapable of GitHub mutation.
- Replay, restart, pending outbox delivery, diagnostics, audits, and zero raw slash transcript behavior retain their #98 guarantees while rechecking current room binding.
- Focused command, storage/migration, browser, full-suite, typecheck, build, planning, and diff verification is recorded on the closing pull request and issue.

## Evidence

Implemented on the focused issue branch and delivered through the pull request that closes #129. Final review, verification, merge, issue/epic update, and default-branch ancestry evidence is recorded on the issue.
