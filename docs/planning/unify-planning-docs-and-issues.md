---
id: unify-planning-docs-and-issues
status: done
issue: 24
owner: crimsonsunset
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-24
---

# Unify planning docs and GitHub Issues into one source of truth

**Status**: Done — Phases 1–3 implemented; rebased onto current `main` and reconciled with later planning-doc drift
**Ticket**: [#24](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/24)
**Branch**: `feat/unify-planning-docs-and-issues`
**Base**: `main`
**Epic**: none — process/tooling work adjacent to [#15](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/15) but not one of its phases
**Estimated effort**: ~1.5 days across 3 phases

---

## Overview

`docs/planning/*.md` and GitHub Issues currently duplicate the same information by hand, and they've already drifted: three files (`participant-mentions.md`, `project-permissions-toggle.md`, `compose-lag-cross-platform.md`) stayed `active`/`proposed` after their linked PRs merged and their issues closed. This ticket makes GitHub Issues the single hand-authored source of truth for trackable work, keeps `docs/planning/*.md` for pre-issue scratch notes and permanent historical record only, and adds a CI guardrail so the split can't silently drift again.

This combines two options from an earlier `propose-opts-brainstorm` session:

- **Structural fix** (Option 3): collapse the planning-file layer into Issues — one copy of the truth, not two.
- **Ongoing guardrail** (Option 1): a fail-closed CI check that keeps the new steady state honest, without granting any bot or agent write access to GitHub.

**What this is NOT:**

- a claim that `docs/planning/*.md` goes away entirely — pre-issue room notes still start there;
- a bot that auto-syncs issue state into files or files into issues — no new GitHub write credential is introduced by this doc (that's explicitly [#18](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/18)'s job); and
- a change to the in-app governed Improvements ledger — that's a separate runtime system, tracked toward [#17](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/17).

**Dependency chain:**

```text
Phase 1: issue template + guardrail script (report-only, non-blocking)
  ↓
Phase 2: migrate the 6 existing planning files
  ↓
Phase 3: flip the guardrail to a required, blocking check
```

## Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | What's the source of truth for trackable work going forward? | GitHub Issues. | A single copy can't drift. `docs/planning/README.md` already states Issues should become canonical once one exists. |
| 2 | What happens to the 6 existing planning files? | Merge content into a linked issue (opening one first if none exists), then flip file `status: superseded` with a link to the issue. Never delete. | Matches this repo's own working rule #5 — preserve completed files as history, mark replaced work `superseded`. |
| 3 | What replaces `TEMPLATE.md`'s fields for new work? | A GitHub issue template carrying the same fields: Outcome, Acceptance checks, Current state, Next action, Evidence, Open questions. | Keeps the room's existing intake discipline; only moves where it's authored. |
| 4 | How do we stop this from drifting again? | A CI script, run on every PR, that fails closed if a non-`superseded` planning file's linked issue is closed, or if a PR that closes an issue doesn't flip the matching file's status in the same diff. | Directly targets the failure mode that already happened three times in one day. |
| 5 | Does the guardrail get GitHub write access? | No. Read-only `gh api` calls from CI; the script exits non-zero and never commits, comments, or opens anything. | The room's stated principle is that no agent or tooling gets ambient, reusable GitHub write credentials until [#18](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/18)'s scoped broker exists. A write-capable sync script would be exactly that, built without the safeguards #18 is designing in. |
| 6 | What about notes with no issue yet? | Still allowed — `status: proposed` with no `issue:` reference doesn't fail the guardrail. It only fails once a file claims `active`, or is neither `superseded` nor backed by a live issue. | Keeps the room's low-friction intake (report → note → maybe an issue) intact; only enforces sync once something is actually being tracked. |

## Scope

**In:**

- `.github/ISSUE_TEMPLATE/work-item.md` mirroring `TEMPLATE.md`'s fields;
- an `issue:` frontmatter field added to the planning-doc contract;
- `scripts/check-planning-doc-sync.ts` plus a CI workflow that runs it on every PR;
- migration of the 6 existing files (3 already issue-linked, 3 not);
- an updated `docs/planning/README.md` describing the new lifecycle;
- `issue:` backfill on later main-only docs so enforce-mode CI stays green after rebase.

**Out:**

- bot-driven auto-sync in either direction — deferred to [#18](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/18)'s scoped broker, where it belongs;
- folding the in-app Improvements ledger into this — separate system, tracked under [#17](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/17);
- retroactively renumbering existing plain-slug planning files to match issue numbers — cosmetic, not required for the guardrail to work.

## Architecture

```text
PR opened/updated
        │
        ▼
scripts/check-planning-doc-sync.ts  (CI, read-only)
        │
        ├─ for each changed docs/planning/*.md:
        │     read `issue:` frontmatter → query issue state via `gh api`
        │
        ├─ file status ∈ {active, proposed} AND issue is CLOSED   → fail
        ├─ PR body/branch references "closes #N", file for #N
        │     still active/proposed in this diff                  → fail
        └─ otherwise                                               → pass
```

No new runtime component. This is a CI script plus two documentation/template changes — it does not touch `server/` or `src/`.

## Files to create / modify

| File | Change |
|---|---|
| `.github/ISSUE_TEMPLATE/work-item.md` | New issue template carrying `TEMPLATE.md`'s fields (Outcome, Acceptance checks, Current state, Next action, Evidence, Open questions). |
| `scripts/check-planning-doc-sync.ts` | New guardrail script; reads changed `docs/planning/*.md` frontmatter, queries `gh api` for linked issue state, exits non-zero on violation. |
| `.github/workflows/planning-doc-guardrail.yml` | New CI workflow invoking the script on `pull_request`. |
| `package.json` | Add a `check:planning-docs` script entry calling `tsx scripts/check-planning-doc-sync.ts`. |
| `docs/planning/TEMPLATE.md` | Add an `issue:` frontmatter field; document when it's required (once `status` leaves `proposed`). |
| `docs/planning/README.md` | Rewrite "Working rules" to describe Issues-as-source-of-truth, the guardrail, and the `superseded`-not-deleted migration path. Restored the full Current work index (main's 9 entries plus `#9`) after rebase. |
| `docs/planning/participant-mentions.md` | Flip `status: superseded`, link merged PRs [#5](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/5)/[#7](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/7). |
| `docs/planning/project-permissions-toggle.md` | Flip `status: superseded`, link merged [#4](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/4). |
| `docs/planning/compose-lag-cross-platform.md` | Flip `status: superseded`, link closed issue [#13](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/13) and merged [#21](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/21). |
| `docs/planning/typing-indicator-truthfulness.md` | Open a new issue from its content, then flip `status: superseded`, link the issue. |
| `docs/planning/large-message-autoscroll.md` | Same — open issue, supersede. |
| `docs/planning/aim-window-controls.md` | `status: superseded`, `issue: 27`. Kept main's decorative-chrome body after rebase rather than the older "promoted to #27" stub. |
| `docs/planning/9-governed-assignment-workspaces.md` | Added YAML frontmatter (`status: active`, `issue: 9`) so the guardrail can see the ticket-first epic. Body unchanged. |
| `docs/planning/18-scoped-github-contribution-broker.md` | Added `issue: 18`. Status stays `done`. |
| `docs/planning/20-exact-commit-contribution-gates.md` | Added `issue: 20` and flipped `status` to `done` — issue #20 is closed via [#45](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/45)/[#47](https://github.com/virusimmortal00/AllMyFriendsAreAgents/pull/47). Leaving it `active` would fail enforce-mode CI. |
| `docs/planning/48-persistent-live-roster.md` | Added `issue: 48`. Status stays `done`. |

## Phasing

### Phase 1: Foundation — Done

- Write `.github/ISSUE_TEMPLATE/work-item.md` from `TEMPLATE.md`'s fields.
- Write `scripts/check-planning-doc-sync.ts` and wire it into a CI workflow. Shipped in **enforce** mode rather than report-only first; report mode remains available via `--mode=report` / `PLANNING_DOC_GUARDRAIL_MODE=report`.
- Add the `issue:` frontmatter field to `TEMPLATE.md` and document it in `docs/planning/README.md`.

**Outcome:** Every PR runs a blocking planning-doc check. `proposed` files may omit `issue:`; `active`/`blocked` require it.

### Phase 2: Migrate the 6 existing files — Done

- For the 3 files with a linked/closed issue already (`participant-mentions.md`, `project-permissions-toggle.md`, `compose-lag-cross-platform.md`): add the `issue:` frontmatter field, flip `status: superseded`.
- For the 3 files with no issue (`typing-indicator-truthfulness.md`, `large-message-autoscroll.md`, `aim-window-controls.md`): opened [#25](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/25), [#26](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/26), [#27](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/27), then flipped `status: superseded`. After rebase, `aim-window-controls.md` kept main's decorative-chrome write-up instead of the promotion stub.

**Outcome:** The original 6 files read `status: superseded` and resolve to a GitHub issue. Later main-only docs (`18`, `20`, `48`, `#9`) were backfilled so they also satisfy the guardrail.

### Phase 3: Enforce — Done

- CI workflow ships in enforce mode (`PLANNING_DOC_GUARDRAIL_MODE: enforce`). Self-check fixtures run first.
- Rebased onto current `main` (merge-base was `829bd95`). Conflicts: `docs/planning/README.md` (restored full index) and `docs/planning/aim-window-controls.md` (main body + superseded/`issue: 27` frontmatter). `package.json` auto-merged; main's `tsc -b --force` kept.

**Outcome:** A PR that closes a tracked issue without updating the matching planning file's status cannot merge. Docs that landed on main after this branch forked now have `issue:` fields: `#9` stays `active` (issue still open); `#20` flipped to `done` because the issue is already closed.

## Key files referenced

| File | Role |
|---|---|
| [`docs/planning/README.md`](README.md) | Existing working rules; already states Issues should eventually be canonical. |
| [`docs/planning/TEMPLATE.md`](TEMPLATE.md) | Field contract this migrates into the new issue template. |
| [`docs/planning/9-governed-assignment-workspaces.md`](9-governed-assignment-workspaces.md) | This repo's own precedent for the phased-doc format used here. |
| [`scripts/room-tool.ts`](../../scripts/room-tool.ts) | Existing `tsx`-based script convention the new guardrail script follows. |

## Related documentation

- `propose-opts-brainstorm` session, 2026-08-22 — evaluated 4 options for forcing sync between `docs/planning/` and GitHub Issues; this doc combines the accepted Option 1 (CI guardrail) and Option 3 (collapse into Issues).
- [Issue #15](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/15) — program epic; this migration keeps planning artifacts consistent with the task model it describes.
- [Issue #17](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/17) — first-class tasks; the real long-term replacement for hand-authored issues once built.
- [Issue #18](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/18) — scoped GitHub contribution broker; the reason this doc's guardrail stays read-only instead of bot-driven.

_Created: 2026-08-22_
_Planning session: `propose-opts-brainstorm` on forcing `docs/planning/` + GitHub Issues sync; options 1 and 3 combined per user direction._
_Last reconciled: 2026-08-24 — rebased onto current `main`; restored README index; backfilled `issue:` on #9/#18/#20/#48._
