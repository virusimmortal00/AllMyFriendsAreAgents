# Planning

This directory is the repo-native working set for concrete bugs and features. Each file should contain enough context for a contributor to understand the outcome, do the work, and verify it without reconstructing the task from chat.

**GitHub Issues are the source of truth** for trackable work. These files are pre-issue room notes and a permanent historical record. They are not a second tracker.

## Current work

- [Cross-platform compose lag](compose-lag-cross-platform.md) — [#13](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/13)
- [Typing indicator truthfulness](typing-indicator-truthfulness.md) — [#25](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/25)
- [Large-message autoscroll](large-message-autoscroll.md) — [#26](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/26)
- [AIM window controls](aim-window-controls.md) — [#27](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/27)
- [Cross-provider project write toggle](project-permissions-toggle.md) — [#4](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/4)
- [Participant mentions and autocomplete](participant-mentions.md) — [#5](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/5)
- [Scoped GitHub contribution broker](18-scoped-github-contribution-broker.md) — [#18](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/18)
- [Exact-commit contribution gates](20-exact-commit-contribution-gates.md) — [#20](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/20)
- [Persistent live room roster](48-persistent-live-roster.md) — [#48](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/48)
- [Governed assignment-scoped developer workspaces](9-governed-assignment-workspaces.md) — [#9](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/9)

## Working rules

1. New intake can start as a `proposed` file from [TEMPLATE.md](TEMPLATE.md) with no `issue:` field.
2. Once work is tracked, open a GitHub issue from `.github/ISSUE_TEMPLATE/work-item.md` and put its number in `issue:`. `active` and `blocked` require that field.
3. Update the file in the same change as the code or evidence it describes. Closing an issue without flipping the matching file to `done` or `superseded` fails CI.
4. Keep authorship and review distinct. Record immutable evidence such as commit SHAs, test commands, traces, or deployment IDs.
5. Preserve completed files as history. Mark replaced work `superseded` and link its issue or replacement instead of deleting the file.
6. Read the relevant file, not the entire directory, unless doing deliberate planning or audit work.

Allowed status values are `proposed`, `active`, `blocked`, `done`, and `superseded`.

`pnpm check:planning-docs` is the read-only guardrail. It never writes to GitHub. Bot-driven sync stays deferred to [#18](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/18). When first-class tasks land in [#17](https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/17), these files should become generated or exported views rather than separately maintained state.
