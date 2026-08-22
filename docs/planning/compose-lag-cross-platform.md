---
id: compose-lag-cross-platform
status: proposed
owner: unclaimed
reviewers: []
depends_on: []
reported_by: Chankster, Bobbo
updated: 2026-08-21
---

# Outcome

Typing remains responsive in the message composer on Chrome iOS during quiet rooms, active streaming, and long transcripts, without weakening draft recovery or message semantics. Windows Chrome validation follows as V2.

# Acceptance checks

- V1 captures pre-fix and post-fix profiles in Chrome iOS, with Bobbo performing product validation.
- V2 repeats the accepted checks in Windows Chrome with Chankster; it does not block the narrower V1.
- Cover short and long transcripts under quiet and active-SSE conditions, including a room message arriving while the human is typing.
- Declare the performance budget before changing code: p95 key-to-paint below 50 ms with no repeated input-path long tasks above 100 ms.
- Cover rapid typing, backspace, large paste, autocorrect, and IME composition without focus, caret, or selection jumps.
- Verify keystrokes do not cause avoidable transcript rerenders; use profiling evidence rather than the current code-path hypothesis to choose the fix.
- Preserve mention suggestions and keyboard selection.
- Preserve drafts across reload and reconnect. If persistence is deferred, flush on send, blur, pagehide, and reconnect/reload handoff with a documented and tested maximum loss window.
- Preserve explicit-send behavior and client-ID/idempotency guarantees.
- Keep V1 limited to the message composer. Other text fields require a separate reproduction and follow-up rather than expanding V1.

# Current state

Chankster reported the lag in Windows Chrome, and Bobbo reproduced it in Chrome iOS during every composer input event. A room code read found that each draft character is lifted into `App` state, participates in draft persistence and mention reconciliation, and can rerender the transcript. Those are plausible cross-platform costs, not yet an accepted root cause.

The room agreed that traces must gate the implementation choice. Likely candidates include keeping ephemeral draft state local to the composer, memoizing transcript rendering, isolating mention reconciliation, and batching durable persistence. Incoming SSE remains a distinct stress case even if keystroke-triggered transcript rerenders are removed. Bobbo narrowed V1 acceptance and validation to Chrome iOS and the message composer; the implementation must still fix the shared composer path rather than add an iOS-specific fork. Windows Chrome remains the explicit V2 with Chankster.

# Next action

Profile the Chrome iOS composer across the agreed transcript/SSE matrix before selecting a V1 fix. Implementation remains unclaimed and must occur in an isolated worktree with independent review. Repeat the accepted checks on Windows Chrome in V2.

# Evidence

- Room report from Chankster on 2026-08-21.
- Chrome iOS reproduction from Bobbo at 2026-08-21T23:58Z.
- Cursor Composer traced the current per-character App-state, persistence, mention, and transcript-render path; Cursor Grok required the incoming-SSE case remain explicit; Codex Terra added mobile focus/caret/selection stability.
- Bobbo narrowed V1 to the Chrome iOS message composer for direct validation and deferred Windows Chrome validation with Chankster to V2.
- Tracking issue: [#13](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/13).
- No implementation, merge, or live deployment exists.

# Open questions

- Which input-path work dominates the slow frames, and does it scale primarily with transcript length, streaming frequency, draft size, or a combination?
