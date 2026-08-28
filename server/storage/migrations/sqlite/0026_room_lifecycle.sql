ALTER TABLE rooms ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 1 CHECK(lifecycle_revision >= 1);
ALTER TABLE rooms ADD COLUMN attachment_revision INTEGER NOT NULL DEFAULT 0 CHECK(attachment_revision >= 0);
ALTER TABLE rooms ADD COLUMN forked_from_room_id TEXT REFERENCES rooms(id) ON DELETE RESTRICT;
ALTER TABLE rooms ADD COLUMN forked_from_project_id TEXT REFERENCES durable_projects(project_id) ON DELETE RESTRICT;

CREATE TABLE room_memberships (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  human_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(room_id,human_id)
);

CREATE INDEX room_memberships_human_idx ON room_memberships(human_id,room_id);

CREATE TABLE room_attachment_events (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  actor_human_id TEXT NOT NULL,
  previous_project_id TEXT REFERENCES durable_projects(project_id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES durable_projects(project_id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('attach','detach','rebind','fork-provenance')),
  occurred_at TEXT NOT NULL,
  UNIQUE(room_id,revision)
);

CREATE TABLE room_forks (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE RESTRICT,
  source_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  source_room_revision INTEGER NOT NULL,
  source_project_id TEXT REFERENCES durable_projects(project_id) ON DELETE RESTRICT,
  source_attachment_revision INTEGER NOT NULL,
  forked_by_human_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER room_attachment_events_immutable_update
BEFORE UPDATE ON room_attachment_events BEGIN SELECT RAISE(ABORT,'room attachment audit is immutable'); END;
CREATE TRIGGER room_attachment_events_immutable_delete
BEFORE DELETE ON room_attachment_events BEGIN SELECT RAISE(ABORT,'room attachment audit is immutable'); END;
CREATE TRIGGER room_forks_immutable_update
BEFORE UPDATE ON room_forks BEGIN SELECT RAISE(ABORT,'room fork provenance is immutable'); END;
CREATE TRIGGER room_forks_immutable_delete
BEFORE DELETE ON room_forks BEGIN SELECT RAISE(ABORT,'room fork provenance is immutable'); END;
