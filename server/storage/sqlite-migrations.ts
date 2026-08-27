import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const storageDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SQLITE_MIGRATIONS_DIRECTORY = path.join(storageDirectory, "migrations", "sqlite");

function migrationVersion(filename: string) {
  const match = /^(\d+)_.*\.sql$/.exec(filename);
  return match ? Number(match[1]) : undefined;
}

export async function runSqliteMigrations(
  database: DatabaseSync,
  migrationsDirectory = DEFAULT_SQLITE_MIGRATIONS_DIRECTORY,
) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
      .map(({ version }) => Number(version)),
  );
  const migrations = (await readdir(migrationsDirectory))
    .map((filename) => ({ filename, version: migrationVersion(filename) }))
    .filter((migration): migration is { filename: string; version: number } => migration.version !== undefined)
    .sort((left, right) => left.version - right.version);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const sql = await readFile(path.join(migrationsDirectory, migration.filename), "utf8");
    if(migration.version===23)database.exec("PRAGMA foreign_keys = OFF;");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
      if(migration.version===23)database.exec("PRAGMA foreign_keys = ON;");
    } catch (error) {
      database.exec("ROLLBACK");
      if(migration.version===23)database.exec("PRAGMA foreign_keys = ON;");
      throw new Error(`SQLite migration ${migration.filename} failed.`, { cause: error });
    }
  }
}
