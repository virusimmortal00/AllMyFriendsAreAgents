import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from "./sqlite-migrations.js";

async function prepareLegacyConsultationDatabase(database: DatabaseSync) {
  const timestamp = "2026-08-27T00:00:00.000Z";
  const files = (await readdir(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY)).filter((filename) => Number(filename.slice(0, 4)) <= 20).sort();
  for (const filename of files) {
    database.exec(await readFile(path.join(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, filename), "utf8"));
    database.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(Number(filename.slice(0, 4)), timestamp);
  }
  const current = await readFile(path.join(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, "0024_room_consultations.sql"), "utf8");
  const legacy = current
    .replace("  idempotency_scope TEXT NOT NULL CHECK (length(idempotency_scope) > 0),\n", "")
    .replace("UNIQUE (room_id, idempotency_scope, idempotency_key)", "UNIQUE (room_id, idempotency_key)")
    .replace("ON DELETE RESTRICT", "ON DELETE CASCADE");
  database.exec(legacy);
  database.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (21,?)").run(timestamp);
  const projection = { schemaVersion: 1, roomId: "room", consultationId: "legacy", revision: 1, state: "queued", idempotencyKey: "same", requestDigest: `sha256:${"a".repeat(64)}`, request: { topic: "legacy" }, affinitySnapshot: [], duties: [], provenance: [{ kind: "human", actorId: "member-a", recordedAt: timestamp }], execution: null, finalArtifact: null, transitions: [{ revision: 1, from: null, to: "queued", at: timestamp, actorId: "member-a", reason: "created" }], createdAt: timestamp, updatedAt: timestamp };
  database.prepare("INSERT INTO consultations VALUES (?,?,?,?,?,?,?,?,?)").run("room", "legacy", 1, "queued", "same", projection.requestDigest, JSON.stringify(projection), timestamp, timestamp);
  return projection;
}

describe("SQLite migrations", () => {
  it("repairs databases that recorded the legacy consultation migration as 0021", async () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    try {
      const projection = await prepareLegacyConsultationDatabase(database);
      await runSqliteMigrations(database);
      expect((database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("recipient_human_id");
      expect((database.prepare("PRAGMA table_info(consultations)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("idempotency_scope");
      expect(JSON.parse((database.prepare("SELECT projection_json FROM consultations WHERE consultation_id='legacy'").get() as { projection_json: string }).projection_json)).toMatchObject({ idempotencyScope: "member-a" });
      database.prepare("INSERT INTO consultations(room_id,consultation_id,revision,lifecycle_state,idempotency_scope,idempotency_key,request_digest,projection_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("room", "other", 1, "queued", "member-b", "same", projection.requestDigest, JSON.stringify({ ...projection, consultationId: "other", idempotencyScope: "member-b" }), projection.createdAt, projection.updatedAt);
    } finally { database.close(); }
  });

  it("resumes migration 0024 after an interruption during legacy table renames", async () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    try {
      await prepareLegacyConsultationDatabase(database);
      database.exec(`
        DROP TRIGGER IF EXISTS consultation_events_immutable_update;
        DROP TRIGGER IF EXISTS consultation_events_immutable_delete;
        DROP INDEX IF EXISTS consultations_room_state_updated_idx;
        DROP INDEX IF EXISTS consultation_events_room_occurred_idx;
        DROP INDEX IF EXISTS consultation_affinities_room_idx;
        ALTER TABLE consultations RENAME TO consultations_legacy_0021;
      `);

      await runSqliteMigrations(database);

      expect(database.prepare("SELECT consultation_id, idempotency_scope FROM consultations").get()).toEqual({ consultation_id: "legacy", idempotency_scope: "member-a" });
      expect((database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("recipient_human_id");
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_legacy_0021'").all()).toEqual([]);
      expect(database.prepare("SELECT version FROM schema_migrations WHERE version=24").get()).toEqual({ version: 24 });
    } finally { database.close(); }
  });

  it("creates the portable storage schema and is idempotent", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      await runSqliteMigrations(database);
      await runSqliteMigrations(database);

      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(({ name }) => name);
      expect(tables).toEqual(expect.arrayContaining([
        "schema_migrations",
        "rooms",
        "messages",
        "agents",
        "room_agents",
        "agent_sessions",
        "generation_runs",
        "canonical_improvements",
        "canonical_improvement_events",
        "canonical_improvement_revisions",
        "canonical_improvement_evidence",
        "canonical_improvement_milestones",
        "canonical_improvement_milestone_records",
        "canonical_improvement_audit_history",
        "emergency_stops",
        "emergency_stop_events",
        "assignment_records",
        "canonical_tasks",
        "canonical_task_events",
        "canonical_task_links",
        "continuation_policies",
        "continuation_jobs",
        "continuation_inbox",
        "continuation_job_events",
        "room_settings",
        "room_settings_history",
        "agent_context_summaries",
        "command_submissions",
        "command_submission_tombstones",
        "command_round_robin",
        "command_attempts",
        "command_pov_executions",
        "command_polls",
        "command_poll_votes",
        "command_audit_identities",
        "command_diagnostics",
        "consultations",
        "consultation_events",
        "consultation_affinities",
        "command_gh_executions",
        "durable_servers",
        "durable_projects",
        "repository_references",
        "source_work_bindings",
        "storage_identity_migrations",
        "storage_import_manifests",
        "room_memberships",
        "room_attachment_events",
        "room_forks",
      ]));
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 26 });
      expect((database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("recipient_human_id");
      const assignmentColumns = (database.prepare("PRAGMA table_info(assignment_records)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(assignmentColumns).toEqual(expect.arrayContaining(["lifecycle_revision", "cancelled_at", "disposed_at", "last_operation_key"]));
      const messageColumns = (database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(messageColumns).toContain("client_message_id");
      expect(messageColumns).toContain("mentions_json");
      expect(messageColumns).toContain("continuation_request_json");
      expect((database.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining(["roster_revision", "roster_schema_version", "deployment_provenance_json", "server_id", "project_id", "identity_revision"]));
      expect((database.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining(["lifecycle_revision", "attachment_revision", "forked_from_room_id", "forked_from_project_id"]));
      expect((database.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining(["code_epoch", "lane", "invalidated_at", "invalidation_reason"]));
      expect((database.prepare("PRAGMA table_info(room_agents)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("last_seen_message_id");
      expect((database.prepare("PRAGMA table_info(room_settings)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining(["configuration_revision", "base_prompt_revision", "base_prompt_text", "summarizer_model", "summarizer_prompt_text", "summarizer_prompt_revision", "feature_flags_json", "preflight_mode"]));
      expect((database.prepare("PRAGMA table_info(agent_context_summaries)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("config_revision");
      const consultationIndexes = (database.prepare("PRAGMA index_list(consultations)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(consultationIndexes).toEqual(expect.arrayContaining(["consultations_room_state_updated_idx", "sqlite_autoindex_consultations_1", "sqlite_autoindex_consultations_2"]));
      expect((database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining([
        "command_polls_open_limit",
        "command_poll_votes_require_open_poll",
        "command_polls_monotonic_close",
      ]));
    } finally {
      database.close();
    }
  });

  it("keeps PostgreSQL lifecycle, race, and retention guards in schema parity", async () => {
    const migration = await readFile(path.join(process.cwd(), "server/storage/migrations/postgres/0016_poll_lifecycle.sql"), "utf8");
    expect(migration).toContain("command_polls_lifecycle_consistent");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("command_polls_open_limit");
    expect(migration).toContain("command_poll_votes_require_open_poll");
    expect(migration).toContain("command_polls_monotonic_close");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("SET voter_id = 'human:' || voter_id");
  });
  it("keeps the PostgreSQL GitHub command constraint, durable execution, and atomic acceptance trigger in parity",async()=>{const migration=await readFile(path.join(process.cwd(),"server/storage/migrations/postgres/0017_github_read_commands.sql"),"utf8");expect(migration).toContain("'gh'");expect(migration).toContain("command_gh_executions");expect(migration).toContain("AFTER INSERT ON command_submissions");expect(migration).toContain("status IN ('queued','completed','failed')");expect(migration).not.toMatch(/authorization|etag|header|payload/i);});

  it("keeps the forward PostgreSQL consultation schema member-scoped and deletion-consistent", async () => {
    const migration = await readFile(path.join(process.cwd(), "server/storage/migrations/postgres/0018_room_consultations.sql"), "utf8");
    expect(migration).toContain("UNIQUE (room_id, idempotency_scope, idempotency_key)");
    expect(migration).toContain("ON DELETE RESTRICT");
    expect(migration).not.toContain("ON DELETE CASCADE");
  });

  it("migrates legacy poll voter identities before accepting namespaced votes", async () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    try {
      database.exec("CREATE TABLE command_submissions(submission_id TEXT,room_id TEXT,invoker_kind TEXT,invoker_id TEXT); CREATE TABLE command_polls(poll_id TEXT,room_id TEXT,submission_id TEXT,question TEXT,options_json TEXT,created_at TEXT); CREATE TABLE command_poll_votes(room_id TEXT,poll_id TEXT,voter_id TEXT,mutation_id TEXT,option_index INTEGER,created_at TEXT,PRIMARY KEY(room_id,poll_id,voter_id),UNIQUE(room_id,poll_id,mutation_id));");
      database.prepare("INSERT INTO command_submissions VALUES (?,?,?,?)").run("submission","room","human","legacy-human");
      database.prepare("INSERT INTO command_polls VALUES (?,?,?,?,?,?)").run("poll","room","submission","Choose",'["A","B"]',"2026-08-27T12:00:00.000Z");
      database.prepare("INSERT INTO command_poll_votes VALUES (?,?,?,?,?,?)").run("room","poll","legacy-human","legacy-vote",1,"2026-08-27T12:01:00.000Z");
      database.exec(await readFile(path.join(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY,"0022_poll_lifecycle.sql"),"utf8"));
      expect(database.prepare("SELECT voter_id FROM command_poll_votes").get()).toEqual({voter_id:"human:legacy-human"});
      expect(()=>database.prepare("INSERT INTO command_poll_votes VALUES (?,?,?,?,?,?)").run("room","poll","human:legacy-human","new-vote",0,"2026-08-27T12:02:00.000Z")).toThrow(/UNIQUE/);
    } finally { database.close(); }
  });

  it("adds empty improvement storage without modifying existing room data", async () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      for (const [version, filename] of [[1, "0001_initial.sql"], [2, "0002_client_message_ids.sql"]] as const) {
        database.exec(await readFile(path.join(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, filename), "utf8"));
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(version, "2026-08-21T00:00:00Z");
      }
      database.prepare(`
        INSERT INTO rooms(
          id, slug, name, topic, writable_agent, conversation_energy, project_path,
          participant_styles_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("room-1", "existing", "Existing Room", "Existing topic", "nobody", "balanced", "/tmp/project", "{}", "idle", "now", "now");
      database.prepare(`
        INSERT INTO messages(id, room_id, speaker, text, created_at) VALUES (?, ?, ?, ?, ?)
      `).run("message-1", "room-1", "you", "preserve transcript", "now");

      await runSqliteMigrations(database);

      expect(database.prepare("SELECT name, topic FROM rooms WHERE id = ?").get("room-1"))
        .toEqual({ name: "Existing Room", topic: "Existing topic" });
      expect(database.prepare("SELECT text FROM messages WHERE id = ?").get("message-1"))
        .toEqual({ text: "preserve transcript" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_improvements").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM emergency_stops").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_tasks").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("removes Gemini Pro from a legacy live roster and revokes its durable authority", async () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      database.exec(await readFile(path.join(DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, "0001_initial.sql"), "utf8"));
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run("2026-08-21T00:00:00Z");
      database.prepare(`INSERT INTO rooms(id, slug, name, topic, writable_agent, conversation_energy, project_path, participant_styles_json, status, active_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("room-1", "legacy", "Legacy", "Topic", "cursor-gemini", "balanced", "/tmp/project", "{}", "working", "cursor-gemini", "now", "now");
      database.prepare("INSERT INTO agents(id, display_name, provider, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("cursor-gemini", "Cursor", "cursor", "gemini-3.1-pro", "now", "now");
      database.prepare("INSERT INTO room_agents(room_id, agent_id, enabled, position, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?)")
        .run("room-1", "cursor-gemini", "now", "now");
      database.prepare("INSERT INTO agent_sessions(room_id, agent_id, provider_session_id, permission, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("room-1", "cursor-gemini", "session", "writable", "now");

      await runSqliteMigrations(database);
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_agents WHERE agent_id = 'cursor-gemini'").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_id = 'cursor-gemini'").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT writable_agent, status, active_agent FROM rooms WHERE id = 'room-1'").get()).toEqual({ writable_agent: "nobody", status: "idle", active_agent: null });
      expect(database.prepare("SELECT agent_id, enabled, position FROM room_agents WHERE room_id = 'room-1' ORDER BY position").all()).toEqual([
        { agent_id: "codex-sol", enabled: 1, position: 0 },
        { agent_id: "claude-sonnet", enabled: 1, position: 1 },
        { agent_id: "cursor-grok", enabled: 1, position: 2 },
        { agent_id: "cursor-composer", enabled: 1, position: 3 },
        { agent_id: "cursor-gemini-flash", enabled: 1, position: 4 },
        { agent_id: "cursor-glm", enabled: 1, position: 5 },
      ]);
    } finally {
      database.close();
    }
  });

  it("does not rewrite a roster that has already been edited", async () => {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      await runSqliteMigrations(database);
      database.prepare(`INSERT INTO rooms(id, slug, name, topic, writable_agent, conversation_energy, project_path, participant_styles_json, status, roster_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("room-edited", "edited", "Edited", "Topic", "nobody", "balanced", "/tmp/project", "{}", "idle", 2, "now", "now");
      database.prepare("INSERT INTO room_agents(room_id, agent_id, enabled, position, created_at, updated_at) VALUES (?, ?, 0, 7, ?, ?)")
        .run("room-edited", "codex-sol", "now", "now");
      database.prepare("DELETE FROM schema_migrations WHERE version = 13").run();

      await runSqliteMigrations(database);
      expect(database.prepare("SELECT agent_id, enabled, position FROM room_agents WHERE room_id = 'room-edited'").all()).toEqual([
        { agent_id: "codex-sol", enabled: 0, position: 7 },
      ]);
    } finally {
      database.close();
    }
  });
});
