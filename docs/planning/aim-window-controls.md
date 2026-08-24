---
id: aim-window-controls
status: complete
owner: sol
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-21
---

# Outcome

The AIM-style title-bar controls either perform clear, supported actions or stop presenting themselves as interactive controls.

# Acceptance checks

- Decide and document the intended behavior for minimize and maximize/fullscreen controls.
- If functional, support keyboard activation and expose accessible names and states.
- If decorative, remove button semantics and focusability.
- Verify behavior in supported desktop browsers without breaking responsive layouts.

# Current state

The browser application cannot minimize, maximize, or close its containing window. The AIM-style glyphs are therefore intentional decorative chrome: they are hidden from assistive technology, ignore pointer input, cannot receive focus, and use subdued flat styling instead of button affordances in loading, join, and room views.

# Next action

Keep these glyphs decorative unless the application gains a documented, browser-supported window-management contract.

# Evidence

- Room report from crimsonsunset on 2026-08-21.

# Open questions

- None. Browser window management is outside the room UI's supported behavior.
