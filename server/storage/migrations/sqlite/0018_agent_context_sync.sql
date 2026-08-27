ALTER TABLE room_agents ADD COLUMN last_seen_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE room_settings (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  base_prompt_revision INTEGER NOT NULL DEFAULT 0 CHECK (base_prompt_revision >= 0),
  base_prompt_text TEXT,
  summarizer_model TEXT,
  summarizer_prompt_text TEXT NOT NULL,
  summarizer_prompt_revision INTEGER NOT NULL DEFAULT 0 CHECK (summarizer_prompt_revision >= 0),
  feature_flags_json TEXT NOT NULL DEFAULT '{"preflightInvocationGating":false}',
  updated_at TEXT NOT NULL
);

CREATE TABLE room_settings_history (
  event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('base_prompt', 'summarizer', 'feature_flags', 'mixed')),
  base_prompt_revision INTEGER NOT NULL,
  summarizer_prompt_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX room_settings_history_room_order_idx ON room_settings_history(room_id, occurred_at, event_id);

CREATE TRIGGER room_settings_history_immutable_update BEFORE UPDATE ON room_settings_history BEGIN
  SELECT RAISE(ABORT, 'room settings history is append-only');
END;

CREATE TRIGGER room_settings_history_immutable_delete BEFORE DELETE ON room_settings_history BEGIN
  SELECT RAISE(ABORT, 'room settings history is append-only');
END;

CREATE TABLE agent_context_summaries (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  span_start_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  span_end_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  config_revision INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id, span_start_message_id, span_end_message_id, config_revision)
);
