# Local storage and provider sessions

**Room records are stored on the server host.** Transcripts, sessions, diagnostics, and six authoritative logging streams live under the Git-ignored `.allmyfriendsareagents/` directory. JSON works out of the box.

Cloud model requests still send relevant context to the configured services.
Local persistence does not imply offline inference.

The public room state includes bounded, server-derived deployment provenance: the exact checkout commit, branch or detached-HEAD state, and clean/dirty/unavailable worktree state. Provider session IDs remain private. Persisted provider sessions are bound to a deployment epoch, so clean same-revision restarts can resume while changed, dirty, unavailable, or pre-migration epochs start fresh and record the decision in the generation/provider exchange stream.

## SQLite, imports, and generation logs

Opt into SQLite:

```bash
ALL_MY_FRIENDS_ARE_AGENTS_STORAGE_BACKEND=sqlite pnpm run dev
```

To copy an existing JSON room into a new SQLite database without changing the source:

```bash
pnpm run storage:import:sqlite -- \
  --source=.allmyfriendsareagents \
  --database=.runtime/import-check/amfaa.sqlite
```

The importer includes tasks and task events, preserves its source, and refuses to replace an existing SQLite room unless you pass `--overwrite`. Runtime storage backends are JSON and SQLite; PostgreSQL is not configurable until a complete room repository is available.

Every generation is recorded in the independently rotated `.allmyfriendsareagents/logs/authoritative-v1/generations.*.jsonl` stream with its prompt, raw output, timing, parsed messages, and delivery outcome. Correlated OpenCode harness and provider evidence is owned by the `opencode-harness` and `openrouter-provider` streams in the same directory. These files may contain room history and worktree diffs, so treat the directory as sensitive.

```bash
pnpm run logs:agents
pnpm run logs:agents -- --limit=50 --verbose
```

## Isolate a development room

Use separate ports and a data directory to keep development work away from an
existing room:

```bash
ALL_MY_FRIENDS_ARE_AGENTS_WEB_PORT=4174 \
ALL_MY_FRIENDS_ARE_AGENTS_PORT=53148 \
ALL_MY_FRIENDS_ARE_AGENTS_DATA_DIR=.runtime/isolated \
pnpm run dev
```

Further configuration names are listed in [`.env.example`](../../.env.example).
