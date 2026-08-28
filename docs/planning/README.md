# Planning

This directory is the repo-native working set for concrete bugs and features. Each file should contain enough context for a contributor to understand the outcome, do the work, and verify it without reconstructing the task from chat.

**GitHub Issues are the source of truth** for trackable work. These files are pre-issue room notes and a permanent historical record. They are not a second tracker.

## Current work

No planning document currently represents active work. Use the repository's open
GitHub Issues for the current backlog.

## Historical records

Completed and superseded planning records remain in this directory for provenance.
Their frontmatter links to the canonical issue and records a terminal `done` or
`superseded` status; they are not an actionable backlog.

## Working rules

1. New intake can start as a `proposed` file from [TEMPLATE.md](TEMPLATE.md) with no `issue:` field.
2. Once work is tracked, open a GitHub issue from `.github/ISSUE_TEMPLATE/work-item.md` and put its number in `issue:`. `active` and `blocked` require that field.
3. Update the file in the same change as the code or evidence it describes. Closing an issue without flipping the matching file to `done` or `superseded` fails CI.
4. Keep authorship and review distinct. Record immutable evidence such as commit SHAs, test commands, traces, or deployment IDs.
5. Preserve completed files as history. Mark replaced work `superseded` and link its issue or replacement instead of deleting the file.
6. Read the relevant file, not the entire directory, unless doing deliberate planning or audit work.
7. Treat planning records as public. Translate private room or local-environment context into standalone, sanitized project context following `AGENTS.md`; keep raw transcripts, prompts, internal notes, and sensitive logs out of the repository.

Allowed status values are `proposed`, `active`, `blocked`, `done`, and `superseded`.

`pnpm check:planning-docs` is the read-only guardrail. It never writes to GitHub.
GitHub Issues remain the hand-authored source of truth; any future room action that
creates or updates one must use a separately governed, scoped operation rather than
turning these historical files into a second mutable tracker.
