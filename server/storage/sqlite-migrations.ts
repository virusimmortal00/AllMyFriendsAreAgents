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
  const tableExists = (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const columnExists = (table: string, column: string) => (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(({ name }) => name === column);
  const applied = new Set(
    (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>)
      .map(({ version }) => Number(version)),
  );
  // Consultation originally shipped as 0021 on its feature branch. Main later
  // assigned 0021 to private-message recipients. Repair that exact collision
  // before normal version processing so neither schema can be silently skipped.
  if (applied.has(21) && tableExists("consultations") && !columnExists("messages", "recipient_human_id")) {
    database.exec(await readFile(path.join(migrationsDirectory, "0021_private_message_recipients.sql"), "utf8"));
  }
  const legacyConsultations = tableExists("consultations") && !columnExists("consultations", "idempotency_scope") && !applied.has(24);
  if (legacyConsultations) {
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(`
      DROP TRIGGER IF EXISTS consultation_events_immutable_update;
      DROP TRIGGER IF EXISTS consultation_events_immutable_delete;
      DROP INDEX IF EXISTS consultations_room_state_updated_idx;
      DROP INDEX IF EXISTS consultation_events_room_occurred_idx;
      DROP INDEX IF EXISTS consultation_affinities_room_idx;
      ALTER TABLE consultations RENAME TO consultations_legacy_0021;
      ALTER TABLE consultation_events RENAME TO consultation_events_legacy_0021;
      ALTER TABLE consultation_affinities RENAME TO consultation_affinities_legacy_0021;
    `);
  }
  const migrations = (await readdir(migrationsDirectory))
    .map((filename) => ({ filename, version: migrationVersion(filename) }))
    .filter((migration): migration is { filename: string; version: number } => migration.version !== undefined)
    .sort((left, right) => left.version - right.version);

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const sql = await readFile(path.join(migrationsDirectory, migration.filename), "utf8");
    if(migration.version===23)database.exec("PRAGMA foreign_keys = OFF;");
    if(migration.version===24 && legacyConsultations)database.exec("PRAGMA foreign_keys = OFF;");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      if (migration.version === 24 && legacyConsultations) {
        database.exec(`
          INSERT INTO consultations(room_id,consultation_id,revision,lifecycle_state,idempotency_scope,idempotency_key,request_digest,projection_json,created_at,updated_at)
          SELECT room_id,consultation_id,revision,lifecycle_state,
            COALESCE(NULLIF(json_extract(projection_json,'$.idempotencyScope'),''),NULLIF(json_extract(projection_json,'$.provenance[0].actorId'),''),'legacy-import'),
            idempotency_key,request_digest,
            json_set(projection_json,'$.idempotencyScope',COALESCE(NULLIF(json_extract(projection_json,'$.idempotencyScope'),''),NULLIF(json_extract(projection_json,'$.provenance[0].actorId'),''),'legacy-import'),'$.execution.providerOperations',json('[]')),
            created_at,updated_at FROM consultations_legacy_0021;
          INSERT INTO consultation_events(room_id,consultation_id,revision,actor_id,occurred_at,change_json,snapshot_json)
          SELECT room_id,consultation_id,revision,actor_id,occurred_at,change_json,
            json_set(snapshot_json,'$.idempotencyScope',COALESCE(NULLIF(json_extract(snapshot_json,'$.idempotencyScope'),''),NULLIF(json_extract(snapshot_json,'$.provenance[0].actorId'),''),'legacy-import'),'$.execution.providerOperations',json('[]'))
            FROM consultation_events_legacy_0021;
          INSERT INTO consultation_affinities SELECT * FROM consultation_affinities_legacy_0021;
          DROP TABLE consultation_events_legacy_0021;
          DROP TABLE consultations_legacy_0021;
          DROP TABLE consultation_affinities_legacy_0021;
        `);
      }
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
      if(migration.version===23 || migration.version===24 && legacyConsultations)database.exec("PRAGMA foreign_keys = ON;");
    } catch (error) {
      database.exec("ROLLBACK");
      if(migration.version===23 || migration.version===24 && legacyConsultations)database.exec("PRAGMA foreign_keys = ON;");
      throw new Error(`SQLite migration ${migration.filename} failed.`, { cause: error });
    }
  }
}
