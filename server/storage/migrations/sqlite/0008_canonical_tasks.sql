CREATE TABLE canonical_tasks (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('draft','proposed','approved','active','blocked','completed','abandoned','archived')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL CHECK (length(description) <= 8000),
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, task_id)
);

CREATE TABLE canonical_task_events (
  room_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
  occurred_at TEXT NOT NULL,
  change_json TEXT NOT NULL CHECK (json_valid(change_json)),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (room_id, task_id, revision),
  FOREIGN KEY (room_id, task_id) REFERENCES canonical_tasks(room_id, task_id) ON DELETE CASCADE
);

CREATE TABLE canonical_task_links (
  room_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK (link_kind IN ('dependency','blocker')),
  target_task_id TEXT NOT NULL,
  PRIMARY KEY (room_id, task_id, link_kind, target_task_id),
  CHECK (task_id <> target_task_id),
  FOREIGN KEY (room_id, task_id) REFERENCES canonical_tasks(room_id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, target_task_id) REFERENCES canonical_tasks(room_id, task_id) ON DELETE RESTRICT
);

CREATE INDEX canonical_tasks_state_idx ON canonical_tasks(room_id, lifecycle_state, updated_at DESC);
CREATE INDEX canonical_task_links_target_idx ON canonical_task_links(room_id, target_task_id, link_kind);

CREATE TRIGGER canonical_task_events_immutable_update
BEFORE UPDATE ON canonical_task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
CREATE TRIGGER canonical_task_events_immutable_delete
BEFORE DELETE ON canonical_task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
