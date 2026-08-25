-- Existing rows predate the OpenCode-only roster schema and must pass through
-- legacy selection confirmation. New and explicitly updated rosters write v3.
ALTER TABLE rooms ADD COLUMN roster_schema_version INTEGER NOT NULL DEFAULT 2;
