ALTER TABLE rooms ADD COLUMN roster_revision INTEGER NOT NULL DEFAULT 1;

-- Gemini Pro remains in the immutable catalog for historical transcripts, but
-- is intentionally removed from every legacy room's default live roster.
DELETE FROM room_agents WHERE agent_id = 'cursor-gemini';
DELETE FROM agent_sessions WHERE agent_id = 'cursor-gemini';
UPDATE rooms SET writable_agent = 'nobody' WHERE writable_agent = 'cursor-gemini';
UPDATE rooms SET status = 'idle', active_agent = NULL, error = NULL WHERE active_agent = 'cursor-gemini';
