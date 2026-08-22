---
id: short-stable-id
status: proposed
issue:
owner: unclaimed
reviewers: []
depends_on: []
reported_by: unknown
updated: YYYY-MM-DD
---

# Outcome

State the observable result, not the implementation.

# Acceptance checks

- List concrete checks that prove the outcome.

# Current state

Record what is known, what is only suspected, and what is not yet live.

# Next action

Name the next bounded action and its owner if assigned.

# Evidence

- Add commit SHAs, deployment IDs, test commands, traces, screenshots, or reproduction notes.

# Open questions

- Keep only questions that can materially change the work.

`issue` is optional while `status` is `proposed`. It becomes required as soon as status moves to `active` or `blocked`. Use a bare number (`24`), `#24`, or a GitHub issue URL. The CI guardrail fails if a live status points at a closed issue, or if a PR closes an issue without flipping the matching file to `done` or `superseded`.
