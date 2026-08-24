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
      ]));
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 10 });
      const messageColumns = (database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(messageColumns).toContain("client_message_id");
      expect(messageColumns).toContain("mentions_json");
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
});
