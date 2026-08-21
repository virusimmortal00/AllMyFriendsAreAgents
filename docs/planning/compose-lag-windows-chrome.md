---
id: compose-lag-windows-chrome
status: proposed
owner: unclaimed
reviewers: []
depends_on: []
reported_by: Chankster
updated: 2026-08-21
---

# Outcome

Typing in the message composer remains responsive on Windows Chrome during quiet rooms and active streaming.

# Acceptance checks

- Capture a pre-fix baseline in Windows Chrome for quiet and active-SSE conditions.
- Declare the performance budget before changing code: p95 key-to-paint below 50 ms with no repeated input-path long tasks above 100 ms.
- Cover rapid typing, backspace, large paste, and IME composition.
- Preserve drafts across reload and reconnect.
- Preserve explicit-send behavior and client-ID/idempotency guarantees.

# Current state

The lag has been reported in Windows Chrome and remained after returning text styles to normal. No root cause has been established. Input-state coupling, transcript rendering, and synchronous draft persistence are hypotheses to test, not accepted causes.

# Next action

Profile a reproducible transcript in Windows Chrome, comparing quiet and active-SSE traces, before selecting a fix.

# Evidence

- Room report from Chankster on 2026-08-21.
- Team intake agreed on 2026-08-21; no implementation or live deployment yet.

# Open questions

- Which input-path work dominates the slow frames?
- Does the problem scale primarily with transcript length, streaming frequency, draft size, or a combination?
