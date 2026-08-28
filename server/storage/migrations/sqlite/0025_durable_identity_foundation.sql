CREATE TABLE durable_servers (
  server_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE durable_projects (
  project_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES durable_servers(server_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  name TEXT NOT NULL,
  repository_capacity INTEGER NOT NULL DEFAULT 1 CHECK(repository_capacity IN (0,1)),
  repository_reference_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repository_references (
  repository_reference_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES durable_projects(project_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  state TEXT NOT NULL CHECK(state = 'unverified-legacy-placeholder'),
  local_path TEXT NOT NULL,
  sanitized_remote_identity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE rooms ADD COLUMN server_id TEXT REFERENCES durable_servers(server_id) ON DELETE RESTRICT;
ALTER TABLE rooms ADD COLUMN project_id TEXT REFERENCES durable_projects(project_id) ON DELETE RESTRICT;
ALTER TABLE rooms ADD COLUMN identity_revision INTEGER NOT NULL DEFAULT 1 CHECK(identity_revision >= 1);

ALTER TABLE agent_sessions ADD COLUMN lane TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE agent_sessions ADD COLUMN invalidated_at TEXT;
ALTER TABLE agent_sessions ADD COLUMN invalidation_reason TEXT;

CREATE TABLE source_work_bindings (
  work_kind TEXT NOT NULL CHECK(work_kind IN ('assignment','continuation','investigation','contribution','github-broker','command-delivery','pov-delivery')),
  work_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES durable_projects(project_id) ON DELETE RESTRICT,
  repository_reference_id TEXT REFERENCES repository_references(repository_reference_id) ON DELETE RESTRICT,
  repository_reference_revision INTEGER,
  origin_task_id TEXT,
  origin_task_revision INTEGER,
  implementation_job_id TEXT,
  implementation_worker_id TEXT,
  reconciliation_state TEXT NOT NULL CHECK(reconciliation_state IN ('bound','needs-reconciliation','terminal-history')),
  reason_code TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(room_id, work_kind, work_id),
  CHECK((repository_reference_id IS NULL) = (repository_reference_revision IS NULL)),
  CHECK(reconciliation_state <> 'bound' OR (
    project_id IS NOT NULL AND repository_reference_id IS NOT NULL
    AND implementation_job_id IS NOT NULL AND implementation_worker_id IS NOT NULL
  ))
);

CREATE INDEX source_work_bindings_room_state_idx
  ON source_work_bindings(room_id, reconciliation_state, work_kind);

CREATE TABLE storage_identity_migrations (
  migration_version TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('sqlite-in-place','json-import')),
  source_digest TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  identity_digest TEXT NOT NULL,
  backup_path TEXT,
  completed_at TEXT NOT NULL
);

CREATE TABLE storage_import_manifests (
  source_digest TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
