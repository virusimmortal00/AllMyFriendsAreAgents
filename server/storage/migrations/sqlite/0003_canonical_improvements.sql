CREATE TABLE canonical_improvements (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL,
  risk TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  PRIMARY KEY (room_id, id)
);

CREATE INDEX canonical_improvements_query_idx
  ON canonical_improvements(room_id, state, risk, updated_at DESC, id);

CREATE TABLE canonical_improvement_events (
  room_id TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  change_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (room_id, improvement_id, revision),
  FOREIGN KEY (room_id, improvement_id)
    REFERENCES canonical_improvements(room_id, id) ON DELETE CASCADE
);

CREATE TABLE emergency_stops (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  projection_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE emergency_stop_events (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (room_id, revision)
);
