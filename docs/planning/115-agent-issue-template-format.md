---
id: agent-issue-template-format
status: proposed
issue: 115
owner: unclaimed
reviewers: []
depends_on: []
reported_by: crimsonsunset
updated: 2026-08-27
---

# Outcome

When an agent recommends filing a GitHub issue during a room conversation, its proposed issue text already matches `.github/ISSUE_TEMPLATE/work-item.md` (Outcome / Acceptance checks / Current state / Next action / Evidence / Open questions), so the human or IDE agent filing it can copy it through with minimal editing.

# Acceptance checks

- [ ] Room base prompt (or a dedicated prompt fragment) instructs agents to format issue proposals using the work-item.md section headers.
- [ ] A sample room transcript shows an agent proposing an issue in that shape, unprompted.
- [ ] Rooms still only ever propose issues in chat — actual issue creation stays with the IDE/human per the "rooms READ, IDE CREATES" decision; this ticket doesn't add issue-creation capability to rooms.

# Current state

Not started. `.github/ISSUE_TEMPLATE/work-item.md` already exists for human/IDE-filed issues; agents aren't currently told to shape their proposals around it.

# Next action

Find where room base prompts are currently assembled and add the template shape as guidance, then verify with a live room conversation.

# Evidence

- None yet.

# Open questions

- Does this belong in the global base prompt, or only in a "let's file an issue" context that's triggered on demand?
