---
id: aim-window-controls
status: proposed
owner: unclaimed
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

The minimize and maximize/fullscreen controls were reported as nonfunctional. It is not yet clear whether they were intended as decoration or incomplete interactions.

# Next action

Inspect the title-bar implementation and product intent, then choose functional controls or explicitly decorative chrome before coding.

# Evidence

- Room report from crimsonsunset on 2026-08-21.

# Open questions

- Should minimize collapse only the room panel, and should maximize enter browser fullscreen or expand within the app shell?
