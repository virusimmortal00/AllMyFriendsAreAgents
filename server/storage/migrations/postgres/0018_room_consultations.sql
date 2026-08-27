CREATE TABLE consultations (
  room_id TEXT NOT NULL,
  consultation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('queued','discussing','input_required','complete','failed','cancelled')),
  idempotency_scope TEXT NOT NULL CHECK (length(idempotency_scope) > 0),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  projection_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, consultation_id),
  UNIQUE (room_id, idempotency_scope, idempotency_key)
);
CREATE TABLE consultation_events (
  room_id TEXT NOT NULL, consultation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
  actor_id TEXT NOT NULL CHECK (length(actor_id) > 0), occurred_at TIMESTAMPTZ NOT NULL,
  change_json JSONB NOT NULL, snapshot_json JSONB NOT NULL,
  PRIMARY KEY (room_id, consultation_id, revision),
  FOREIGN KEY (room_id, consultation_id) REFERENCES consultations(room_id, consultation_id) ON DELETE RESTRICT
);
CREATE TABLE consultation_affinities (
  room_id TEXT NOT NULL, participant_id TEXT NOT NULL, duties_json JSONB NOT NULL,
  provenance_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);
CREATE INDEX consultations_room_state_updated_idx ON consultations(room_id, lifecycle_state, updated_at DESC);
CREATE INDEX consultation_events_room_occurred_idx ON consultation_events(room_id, occurred_at DESC);
CREATE INDEX consultation_affinities_room_idx ON consultation_affinities(room_id, participant_id);

CREATE OR REPLACE FUNCTION reject_consultation_event_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'consultation events are immutable'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER consultation_events_immutable_update BEFORE UPDATE ON consultation_events FOR EACH ROW EXECUTE FUNCTION reject_consultation_event_mutation();
CREATE TRIGGER consultation_events_immutable_delete BEFORE DELETE ON consultation_events FOR EACH ROW EXECUTE FUNCTION reject_consultation_event_mutation();
