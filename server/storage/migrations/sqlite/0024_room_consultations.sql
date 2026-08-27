CREATE TABLE consultations (
  room_id TEXT NOT NULL,
  consultation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('queued','discussing','input_required','complete','failed','cancelled')),
  idempotency_scope TEXT NOT NULL CHECK (length(idempotency_scope) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(CAST(idempotency_key AS BLOB)) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 71
    AND substr(request_digest, 1, 7) = 'sha256:'
    AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, consultation_id),
  UNIQUE (room_id, idempotency_scope, idempotency_key)
);

CREATE TABLE consultation_events (
  room_id TEXT NOT NULL,
  consultation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
  occurred_at TEXT NOT NULL,
  change_json TEXT NOT NULL CHECK (json_valid(change_json)),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  PRIMARY KEY (room_id, consultation_id, revision),
  FOREIGN KEY (room_id, consultation_id) REFERENCES consultations(room_id, consultation_id) ON DELETE RESTRICT
);

CREATE TABLE consultation_affinities (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  duties_json TEXT NOT NULL CHECK (json_valid(duties_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);

CREATE INDEX consultations_room_state_updated_idx ON consultations(room_id, lifecycle_state, updated_at DESC);
CREATE INDEX consultation_events_room_occurred_idx ON consultation_events(room_id, occurred_at DESC);
CREATE INDEX consultation_affinities_room_idx ON consultation_affinities(room_id, participant_id);

CREATE TRIGGER consultation_events_immutable_update
BEFORE UPDATE ON consultation_events BEGIN SELECT RAISE(ABORT, 'consultation events are immutable'); END;
CREATE TRIGGER consultation_events_immutable_delete
BEFORE DELETE ON consultation_events BEGIN SELECT RAISE(ABORT, 'consultation events are immutable'); END;
