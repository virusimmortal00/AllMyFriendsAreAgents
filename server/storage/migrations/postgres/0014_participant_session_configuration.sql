ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS configuration_fingerprint TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS configuration_revision INTEGER;
