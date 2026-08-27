import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from "./sqlite-migrations.js";

describe("SQLite migrations", () => {
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
      ]));
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 21 });
      expect((database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("recipient_human_id");
      const assignmentColumns = (database.prepare("PRAGMA table_info(assignment_records)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(assignmentColumns).toEqual(expect.arrayContaining(["lifecycle_revision", "cancelled_at", "disposed_at", "last_operation_key"]));
      const messageColumns = (database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(messageColumns).toContain("client_message_id");
      expect(messageColumns).toContain("mentions_json");
      expect(messageColumns).toContain("continuation_request_json");
      expect((database.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining(["roster_revision", "roster_schema_version", "deployment_provenance_json"]));
      expect((database.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("code_epoch");
      expect((database.prepare("PRAGMA table_info(room_agents)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("last_seen_message_id");
      expect((database.prepare("PRAGMA table_info(room_settings)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expect.arrayContaining(["configuration_revision", "base_prompt_revision", "base_prompt_text", "summarizer_model", "summarizer_prompt_text", "summarizer_prompt_revision", "feature_flags_json", "preflight_mode"]));
      expect((database.prepare("PRAGMA table_info(agent_context_summaries)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("config_revision");
    } finally {
      database.close();
    }
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
