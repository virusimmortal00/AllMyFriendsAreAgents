---
id: exact-commit-contribution-gates
status: active
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

Implementation is isolated on `codex/issue-20-exact-commit-gates`. It is not merged and not live.

# Next action

Complete executor/API/UI adversarial coverage, run independent review, merge when green, then update the dedicated live checkout and run isolated plus live smoke/canary verification.

# Evidence

- `server/contribution-service.test.ts`
- `server/contribution-api.test.ts`
- `src/contributions.test.tsx`

# Open questions

- Production deployment remains intentionally unavailable until a deployment executor URL is explicitly configured.
