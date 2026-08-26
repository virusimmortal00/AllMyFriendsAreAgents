---
id: exact-commit-contribution-gates
status: done
issue: 20
owner: developer-team
reviewers: [independent-review]
depends_on: [scoped-github-contribution-broker, governed-assignment-workspaces, first-class-tasks]
reported_by: issue-20
updated: 2026-08-24
---

# Outcome

Completed agent work becomes an immutable, independently reviewed handoff. Draft publication, merge, and deployment each require a separate visible, single-use decision bound to the exact repository, branch, base, head, PR, merged commit, environment, and artifact applicable to that stage.

# Acceptance checks

- Handoffs freeze task/improvement/assignment revisions, fence, manifest digest, broker revision, branch/base/head, test evidence, and unresolved findings.
- A different current developer-team member reviews immutable evidence through the read-only source adapter.
- Source, task, manifest, identity, capability, claim, policy, repository, or emergency-stop changes block later eligibility.
- Publication, merge, and deployment approvals are separate records, exact-state bound, single-use, ordered, and never imply the next operation.
- Draft publication is mediated by the scoped GitHub broker; merge rechecks GitHub base/head/ref/state before marking ready and merging the exact head.
- Deployment requires an explicit environment and artifact SHA-256 and accepts only an executor response matching the approved merged commit and artifact.
- Rejected, stale, replayed, out-of-order, cross-task, partial-failure, restart, and audit-chain checks pass without unauthorized external mutation.
- Desktop/mobile UI visibly distinguishes work completed, review accepted, PR published, merged, deployed, and blocked.

# Current state

Shipped to `main` through [#45](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/45) and the follow-up hotfix [#47](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/47). Issue [#20](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/20) is closed.

# Next action

None. Production deployment stays unavailable until a deployment executor URL is explicitly configured.

# Evidence

- `server/contribution-service.test.ts`
- `server/contribution-api.test.ts`
- `src/contributions.test.tsx`

# Open questions

- Production deployment remains intentionally unavailable until a deployment executor URL is explicitly configured.
