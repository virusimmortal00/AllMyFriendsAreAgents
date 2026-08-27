ALTER TABLE room_settings ADD COLUMN configuration_revision INTEGER NOT NULL DEFAULT 0
  CHECK (configuration_revision >= 0);

ALTER TABLE room_settings ADD COLUMN preflight_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (preflight_mode IN ('off', 'shadow', 'enforce'));

-- Version 0018 keyed summaries by the summarizer-prompt revision. The new
-- configuration revision covers every room-setting change, so those older
-- cache entries cannot be proven compatible and must be rebuilt lazily.
DELETE FROM agent_context_summaries;
