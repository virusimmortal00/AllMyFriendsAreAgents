---
id: room-bound-github-read
status: done
issue: 129
---

# Room-bound read-only GitHub commands

Tracking issue: [#129](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/129)

## Outcome

The delivered `/gh` grammar now resolves GitHub authority exclusively from the authenticated invocation's server-owned room, current durable project attachment, current verified repository connection revision, and that connection's server-held credential reference. The process-global repository selector is no longer an execution authority.

Authorization and current binding validation precede cache, replay, recovery, and upstream access. Sanitized cache entries are shared only within an immutable project, connection, revision, and canonical repository scope; room rebinds, connection revisions, disablement, verification loss, identity drift, and missing credentials fail closed with stable private reasons and cannot reach prior entries.

## Acceptance checks

- Human text and agent `room_command` paths retain the five #98 forms and converge on one `CommandRuntime` room-bound executor.
- General, missing-project, missing/disabled/unverified/drifted/stale connection, and missing-credential states fail before cache or upstream access.
- Same-project rooms independently authorize and reuse sanitized entries; distinct projects and rebound or revised connections do not collide.
- The adapter remains fixed-host, HTTPS, REST-only, GET-only, bounded, rate-limited, truncated, redacted, and incapable of GitHub mutation.
- Replay, restart, pending outbox delivery, diagnostics, audits, and zero raw slash transcript behavior retain their #98 guarantees while rechecking current room binding.
- Focused command, storage/migration, browser, full-suite, typecheck, build, planning, and diff verification is recorded on the closing pull request and issue.

## Evidence

Implemented on the focused issue branch and delivered through the pull request that closes #129. Final review, verification, merge, issue/epic update, and default-branch ancestry evidence is recorded on the issue.
