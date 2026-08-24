---
id: cursor-streams-dashboard
status: proposed
issue:
owner: joe
reviewers: []
depends_on: []
reported_by: joe
updated: 2026-08-24
---

# Outcome

One place to see every concurrent Cursor thread in flight — local Composer/Agent tabs across all projects, plus Cloud Agents — instead of manually flipping between IDE tabs. Surfaced first via CLI/Slack; a web panel is an optional later phase, and it is an open question whether that panel belongs here or in a standalone tool.

# Acceptance checks

- A script can enumerate local Composer/Agent threads across every Cursor workspace on the machine, joined to real project paths, without scanning the multi-GB `cursorDiskKV` table.
- The same script can (optionally, if `CURSOR_API_KEY` is set) list Cloud Agents via `GET https://api.cursor.com/v1/agents`.
- Output is sorted so threads with `hasBlockingPendingActions` or `hasUnreadMessages` surface first — these are the actual "needs your attention" signal.
- A missing/changed local schema degrades that one source gracefully (skip + log) rather than crashing the whole tool.
- Optional Slack webhook notification fires only on meaningful state transitions, not every poll tick.

# Current state

Nothing built yet — this is intake from a planning conversation. Feasibility was validated live on this machine (not just from docs):

**Local Composer/Agent threads (unofficial, confirmed working today):**

`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, table `composerHeaders`:

```sql
composerHeaders(composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
                lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
                recency INTEGER, checkpointAt INTEGER, value TEXT /* JSON */)
```

438 rows live across 24 tracked workspaces on this machine. The `value` JSON per thread already carries everything needed:

```json
{
  "composerId": "2fa4da5d-...",
  "name": "PR sweep for mine",
  "subtitle": "Edited pr-354-reply-vini.md, pr-354-body.md, every_01_hour.ts",
  "hasUnreadMessages": false,
  "hasBlockingPendingActions": false,
  "hasPendingPlan": false,
  "contextUsagePercent": 73.7,
  "totalLinesAdded": 146,
  "totalLinesRemoved": 231,
  "filesChangedCount": 6,
  "unifiedMode": "agent",
  "lastUpdatedAt": 1787601565031
}
```

`workspaceId` joins to `workspaceStorage/<workspaceId>/workspace.json` (`{"folder": "file:///path"}`) for the real project path. Some `workspaceId` values are synthetic (e.g. `"empty-window"`); `isSubagent=1` rows are Task-tool subagents, not top-level tabs.

**Cloud Agents (official, documented):** `GET https://api.cursor.com/v1/agents` with `CURSOR_API_KEY` lists every Cloud Agent regardless of launch surface (IDE, web, Slack, GitHub, Linear, mobile) — `status` (`CREATING`/`RUNNING`/`FINISHED`/`ERROR`/`CANCELLED`/`EXPIRED`), repo, PR URL, deep link.

**Known ceiling:**

- The local schema is unofficial and has already shifted once (older docs describe `ItemTable.composer.composerData`; current Cursor uses the dedicated `composerHeaders` table). A future Cursor update can silently break this. Ceiling: per-source failures must be caught and skipped, never crash the whole collector. Upgrade path: re-validate the schema query against a fresh Cursor version before trusting output again.
- No deep-link exists to jump straight to a specific Composer thread by ID (confirmed against Cursor's [deeplink docs](https://cursor.com/docs/reference/deeplinks) and an open [feature request](https://forum.cursor.com/t/create-links-to-past-chats/48716)). Notifications can name project + thread title, not click-to-jump.
- The global DB is 2.3GB; only ever query the small indexed `composerHeaders` table, never scan `cursorDiskKV` (raw message bodies) unless explicitly loading one conversation's content.

# Next action

Owner (joe) to decide where this tool lives (standalone sibling project vs. folded into this repo's `scripts/`), then build Phase 1: a single `streams-print` script with no watching/Slack yet — query `composerHeaders` across all workspaces, join workspace paths, hit the Cloud Agents API if configured, print a table sorted by needs-attention. Validate that alone delivers enough value before building polling/diff/Slack.

# Evidence

- Live query against this machine (2026-08-24): `sqlite3 -readonly ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb "SELECT count(*) FROM composerHeaders;"` → `438`.
- Workspace join validated: `workspaceStorage/88a7472ef72afb4fa4610b89e37106e1/workspace.json` → `{"folder":"file:///Users/joe/Desktop/Repos/Personal/AllMyFriendsAreAgents"}`.
- Cursor Cloud Agents API reference: https://cursor.com/docs/cloud-agent/api/endpoints
- Cursor SDK skill (`@cursor/sdk` / `cursor-sdk`) at `~/.cursor/skills-cursor/sdk/SKILL.md` covers `Agent.list`, `Agent.resume`, `Agent.get`/`getRun` if an "act, not just monitor" phase gets built later.

# Open questions

- Does Cloud Agent + local-CLI-session coverage stay worth building even though plain in-IDE Composer tabs (the main daily pain) are the one thing local `composerHeaders` *does* cover — confirm this reading is right before investing further.
- Standalone tool vs. folded into this repo — no final call yet.
- Monitor-only vs. monitor-and-act (resume/cancel via `@cursor/sdk`) — deferred until Phase 1 proves useful.
- Slack delivery mechanism: incoming webhook (simplest) vs. bot token + `chat.postMessage` (needed if replies/threading matter later).
