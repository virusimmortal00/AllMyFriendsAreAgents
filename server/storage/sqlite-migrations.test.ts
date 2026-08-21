import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSqliteMigrations } from "./sqlite-migrations.js";

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
      ]));
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 2 });
      const messageColumns = (database.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(({ name }) => name);
      expect(messageColumns).toContain("client_message_id");
    } finally {
      database.close();
    }
  });
});
