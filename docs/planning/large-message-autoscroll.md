---
id: large-message-autoscroll
status: superseded
issue: 26
owner: unclaimed
reviewers: []
depends_on: []
reported_by: Chankster
updated: 2026-08-22
---

# Outcome

When the composer or transcript grows substantially, users who are following the bottom remain at the true bottom without overriding users who intentionally scrolled upward.

# Acceptance checks

- Reproduce and fix the incomplete scroll after pasting a large block of text.
- Cover composer growth, message send, streaming growth, and late layout changes such as font loading.
- Keep bottom-following users pinned within a small threshold of the true bottom.
- Do not yank a user downward after they intentionally scroll up; retain the existing new-message affordance.
- Verify Windows Chrome plus the project's supported mobile and desktop browser set.

# Current state

Promoted to [#26](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/26). This file is historical.

# Next action

Do the work on #26. Do not update this file except to record evidence after close.

# Evidence

- Room report from Chankster on 2026-08-21.

# Open questions

- Is the missed bottom caused by textarea resize timing, transcript layout timing, or competing scroll effects?
- Does it reproduce only while already bottom-pinned?
