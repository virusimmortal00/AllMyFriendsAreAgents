ALTER TABLE assignment_records RENAME TO assignment_records_legacy;

CREATE TABLE assignment_records (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  developer_member_id TEXT NOT NULL,
  developer_member_config_revision INTEGER NOT NULL CHECK (developer_member_config_revision >= 1),
  agent_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  manifest_revision INTEGER NOT NULL CHECK (manifest_revision >= 1),
  pinned_base_sha TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  observed_head_sha TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('ACTIVE', 'RECOVERABLE', 'COMPLETED', 'MISSING', 'CANCELLED', 'DISPOSED')),
  lifecycle_revision INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_revision >= 1),
  cancelled_at TEXT,
  disposed_at TEXT,
  last_operation_key TEXT,
  recovery_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, assignment_id),
  UNIQUE (room_id, branch_name),
  UNIQUE (room_id, workspace_path)
);

INSERT INTO assignment_records(
  room_id, assignment_id, improvement_id, developer_member_id, developer_member_config_revision,
  agent_id, fencing_token, manifest_revision, pinned_base_sha, branch_name, observed_head_sha,
  workspace_path, lifecycle_status, lifecycle_revision, cancelled_at, disposed_at, last_operation_key,
  recovery_json, created_at, updated_at
)
SELECT room_id, assignment_id, improvement_id, developer_member_id, developer_member_config_revision,
  agent_id, fencing_token, manifest_revision, pinned_base_sha, branch_name, observed_head_sha,
  workspace_path, lifecycle_status, 1, NULL, NULL, NULL, recovery_json, created_at, updated_at
FROM assignment_records_legacy;

DROP TABLE assignment_records_legacy;

CREATE INDEX assignment_records_recovery_idx
  ON assignment_records(room_id, lifecycle_status, updated_at DESC);
