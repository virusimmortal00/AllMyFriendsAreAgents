CREATE TABLE workspace_quotas (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  document_count INTEGER NOT NULL CHECK (document_count > 0),
  content_size_bytes INTEGER NOT NULL CHECK (content_size_bytes > 0),
  revision_count INTEGER NOT NULL CHECK (revision_count > 0),
  aggregate_room_bytes INTEGER NOT NULL CHECK (aggregate_room_bytes > 0)
);

CREATE TABLE workspace_documents (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  virtual_path TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  archived_by TEXT,
  PRIMARY KEY (room_id, id),
  FOREIGN KEY (room_id, id, current_revision_id) REFERENCES workspace_revisions(room_id, document_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX workspace_documents_active_path_idx
  ON workspace_documents(room_id, virtual_path) WHERE archived_at IS NULL;
CREATE INDEX workspace_documents_room_archive_path_idx
  ON workspace_documents(room_id, archived_at, virtual_path);

CREATE TABLE workspace_revisions (
  room_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (room_id, id),
  UNIQUE (room_id, document_id, id),
  UNIQUE (room_id, document_id, revision),
  FOREIGN KEY (room_id, document_id) REFERENCES workspace_documents(room_id, id) ON DELETE RESTRICT
);

CREATE INDEX workspace_revisions_document_order_idx
  ON workspace_revisions(room_id, document_id, revision);

CREATE TABLE workspace_attachments (
  room_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  data_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (room_id, id),
  FOREIGN KEY (room_id, document_id, revision_id) REFERENCES workspace_revisions(room_id, document_id, id) ON DELETE RESTRICT
);

CREATE INDEX workspace_attachments_revision_idx ON workspace_attachments(room_id, revision_id);

CREATE TABLE workspace_audit_events (
  room_id TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'RENAME_OR_MOVE', 'ARCHIVE', 'RESTORE')),
  resulting_revision_id TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  previous_path TEXT,
  virtual_path TEXT NOT NULL,
  PRIMARY KEY (room_id, id),
  FOREIGN KEY (room_id, document_id) REFERENCES workspace_documents(room_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id, document_id, resulting_revision_id) REFERENCES workspace_revisions(room_id, document_id, id) ON DELETE RESTRICT
);

CREATE INDEX workspace_audit_document_time_idx
  ON workspace_audit_events(room_id, document_id, occurred_at, id);
