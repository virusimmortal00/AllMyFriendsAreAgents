# Planning

This directory is the repo-native working set for concrete bugs and features. Each file should contain enough context for a contributor to understand the outcome, do the work, and verify it without reconstructing the task from chat.

## Current work

- [Chrome/Windows compose lag](compose-lag-windows-chrome.md)
- [Typing indicator truthfulness](typing-indicator-truthfulness.md)
- [Large-message autoscroll](large-message-autoscroll.md)
- [AIM window controls](aim-window-controls.md)
- [Cross-provider project write toggle](project-permissions-toggle.md)
- [Participant mentions and autocomplete](participant-mentions.md)

## Working rules

1. Create one stable, lowercase-kebab-case file per real work item. Do not seed empty placeholders.
2. Start from [TEMPLATE.md](TEMPLATE.md). Keep the outcome, acceptance checks, current state, and next action current.
3. Update the file in the same change as the code or evidence it describes.
4. Keep authorship and review distinct. Record immutable evidence such as commit SHAs, test commands, traces, or deployment IDs.
5. Preserve completed files as history. Mark replaced work `superseded` and link its replacement instead of silently rewriting the decision trail.
6. Read the relevant file, not the entire directory, unless doing deliberate planning or audit work.

Allowed status values are `proposed`, `active`, `blocked`, `done`, and `superseded`.

This is a lightweight bridge, not a second permanent tracker. When Improvements becomes the canonical task system, these files should become generated or exported views rather than separately maintained state.
