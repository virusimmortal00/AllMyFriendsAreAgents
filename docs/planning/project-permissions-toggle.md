---
id: project-permissions-toggle
status: active
owner: sol
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-21
---

# Outcome

The project-permissions checkbox can grant the room's single writable-agent slot to any active provider, including Cursor participants, after the current turn finishes.

# Acceptance checks

- Cursor participant settings expose an enabled write-access checkbox while the room is idle.
- Selecting a Cursor participant persists that participant as `writableAgent`.
- Ordinary Cursor turns use writable CLI permissions only while selected.
- Reviews, unselected participants, and the default state remain read-only.
- Changing permission starts a session with the matching permission instead of reusing an incompatible session.
- Grant and revoke changes record the human actor and timestamp in the transcript.

# Current state

Cursor profiles were marked permanently non-writable, the settings checkbox was disabled, and the runner always launched Cursor in ask mode. The implementation maps the existing explicit single-writer setting to Cursor's non-interactive writable mode while retaining sandboxing and read-only review behavior.

# Next action

Verify the complete change against current `origin/main`, then publish for review.

# Evidence

- Cursor CLI help reports that print mode has write and shell tools, ask mode is read-only, and `--force` permits non-interactive tool execution.
- Permission changes require a joined human ID and append human-attributed grant/revoke status messages to the durable transcript.

# Open questions

- None.
