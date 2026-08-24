CREATE TABLE continuation_policies (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  projection_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE continuation_jobs (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id),
  job_revision INTEGER NOT NULL CHECK (job_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','WAITING_TOOL','BLOCKED','COMPLETED','FAILED','CANCELLED','ACKNOWLEDGED')),
  projection_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, job_id)
);
CREATE UNIQUE INDEX one_nonterminal_continuation_per_agent
  ON continuation_jobs(room_id, owner_agent_id)
  WHERE status IN ('QUEUED','RUNNING','WAITING_TOOL','BLOCKED');
CREATE INDEX continuation_jobs_owner_updated ON continuation_jobs(room_id, owner_agent_id, updated_at DESC, job_id);

CREATE TABLE continuation_inbox (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  inbox_entry_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id),
  inbox_revision INTEGER NOT NULL CHECK (inbox_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('UNREAD','ACKNOWLEDGED','CLOSED','ARCHIVED')),
  projection_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (room_id, inbox_entry_id),
  UNIQUE (room_id, job_id),
  FOREIGN KEY (room_id, job_id) REFERENCES continuation_jobs(room_id, job_id) ON DELETE CASCADE
);
CREATE INDEX continuation_inbox_owner_order ON continuation_inbox(room_id, owner_agent_id, created_at DESC, inbox_entry_id);
