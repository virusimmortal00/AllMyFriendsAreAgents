-- Before the roster became authoritative, some databases retained an old
-- room_agents projection even though the runtime used the then-current static
-- default. Revision 1 means the room has never been edited through the new
-- roster API, so replace only those untouched projections with today's default.
INSERT INTO agents(id, display_name, provider, model_id, configuration_json, created_at, updated_at) VALUES
  ('codex-sol', 'Codex', 'codex', 'gpt-5.6-sol', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('claude-sonnet', 'Claude', 'claude', 'claude-sonnet-5', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cursor-grok', 'Cursor', 'cursor', 'cursor-grok-4.6-high', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cursor-composer', 'Cursor', 'cursor', 'composer-2.5', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cursor-gemini-flash', 'Cursor', 'cursor', 'gemini-3.7-flash-high', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cursor-glm', 'Cursor', 'cursor', 'glm-5.2-high', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET
  display_name = excluded.display_name,
  provider = excluded.provider,
  model_id = excluded.model_id,
  updated_at = excluded.updated_at;

DELETE FROM room_agents WHERE room_id IN (SELECT id FROM rooms WHERE roster_revision = 1);

INSERT INTO room_agents(room_id, agent_id, enabled, position, configuration_json, created_at, updated_at)
SELECT id, 'codex-sol', 1, 0, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM rooms WHERE roster_revision = 1
UNION ALL SELECT id, 'claude-sonnet', 1, 1, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM rooms WHERE roster_revision = 1
UNION ALL SELECT id, 'cursor-grok', 1, 2, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM rooms WHERE roster_revision = 1
UNION ALL SELECT id, 'cursor-composer', 1, 3, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM rooms WHERE roster_revision = 1
UNION ALL SELECT id, 'cursor-gemini-flash', 1, 4, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM rooms WHERE roster_revision = 1
UNION ALL SELECT id, 'cursor-glm', 1, 5, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM rooms WHERE roster_revision = 1;
