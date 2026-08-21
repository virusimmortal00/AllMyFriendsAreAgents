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
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('ACTIVE', 'RECOVERABLE', 'COMPLETED', 'MISSING')),
  recovery_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, assignment_id),
  UNIQUE (room_id, branch_name),
  UNIQUE (room_id, workspace_path)
);

CREATE INDEX assignment_records_recovery_idx
  ON assignment_records(room_id, lifecycle_status, updated_at DESC);
