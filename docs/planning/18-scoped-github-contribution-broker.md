---
id: scoped-github-contribution-broker
status: done
issue: 18
owner: developer-team
reviewers: [independent-review]
depends_on: [governed-assignment-workspaces, first-class-tasks]
reported_by: issue-18
updated: 2026-08-24
---

# Outcome

Assigned agents can read or contribute to one configured GitHub repository through narrow server operations without receiving GitHub credentials or arbitrary API, ref, merge, deployment, or administration authority.

# Acceptance checks

- Every operation revalidates current developer capability, task and assignment revisions, work-claim fence, manifest, policy, emergency stop, canonical repository, assignment branch, base, and head.
- Read, comment, draft publication, PR metadata, and review-request capabilities are independent.
- Comments and draft PRs are idempotent across retry; mutation retries reconcile external state before creating anything.
- Only an assignment-owned branch at a broker-observed commit can be pushed, and only a draft PR against the configured base can be created.
- PR metadata and review requests require the externally revalidated, broker-owned draft PR identity.
- Unknown operations and fields, unrelated targets, changed refs, closed tasks, stale identities, revocation, expiry, response overflow, rate limits, and partial failures fail closed and are audited.
- The durable audit is append-only, hash chained, permission restricted, and contains immutable claims and external result IDs without credentials or comment bodies.
- The full test suite, production build, independent review, and an isolated live canary pass before merge or live deployment.

# Current state

Merged to `main` through PR #44 at `d20d3c0466f811d040305827a23b948c2a2c5dfc`. The broker remains default-off unless a repository and server token are configured. Merge and deployment remain deliberately reserved for issue #20.

# Next action

No action remains in this bounded phase. Continue exact publication, merge, and deployment gating in #20.

# Evidence

- `server/github-contribution-broker.test.ts`
- PR #44; merge `d20d3c0466f811d040305827a23b948c2a2c5dfc`
- `pnpm test` — 454 passed, one platform-specific skip
- `pnpm build` — passed

# Open questions

- None for this bounded phase. Broader eligibility-set and concurrent-writer UX remain owned by #12.
