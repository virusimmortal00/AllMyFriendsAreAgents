ALTER TABLE command_polls ADD COLUMN creator_kind TEXT NOT NULL DEFAULT 'human' CHECK(creator_kind IN ('human','agent'));
ALTER TABLE command_polls ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'legacy-creator';
ALTER TABLE command_polls ADD COLUMN state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED'));
ALTER TABLE command_polls ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE command_polls ADD COLUMN closed_at TIMESTAMPTZ;
ALTER TABLE command_polls ADD COLUMN closer_kind TEXT CHECK(closer_kind IN ('human','agent','controller'));
ALTER TABLE command_polls ADD COLUMN closer_id TEXT;
ALTER TABLE command_polls ADD COLUMN close_mutation_id TEXT;
ALTER TABLE command_polls ADD COLUMN final_tallies_json JSONB;
ALTER TABLE command_polls ADD COLUMN final_total_votes INTEGER CHECK(final_total_votes >= 0);
UPDATE command_polls
SET creator_kind = command_submissions.invoker_kind,
    creator_id = command_submissions.invoker_id
FROM command_submissions
WHERE command_submissions.room_id = command_polls.room_id AND command_submissions.submission_id = command_polls.submission_id;
CREATE UNIQUE INDEX command_polls_close_mutation ON command_polls(room_id, close_mutation_id) WHERE close_mutation_id IS NOT NULL;
CREATE INDEX command_polls_open_room_created ON command_polls(room_id, state, created_at DESC, poll_id DESC);
ALTER TABLE command_polls ADD CONSTRAINT command_polls_lifecycle_consistent CHECK (
  (state = 'OPEN' AND closed_at IS NULL AND closer_kind IS NULL AND closer_id IS NULL AND close_mutation_id IS NULL AND final_tallies_json IS NULL AND final_total_votes IS NULL)
  OR
  (state = 'CLOSED' AND closed_at IS NOT NULL AND closer_kind IS NOT NULL AND closer_id IS NOT NULL AND close_mutation_id IS NOT NULL AND jsonb_typeof(final_tallies_json) = 'array' AND jsonb_array_length(final_tallies_json) = jsonb_array_length(options_json) AND final_total_votes IS NOT NULL)
);
CREATE FUNCTION command_polls_enforce_open_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'OPEN' THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.room_id::text));
    IF (SELECT count(*) FROM command_polls WHERE room_id = NEW.room_id AND state = 'OPEN') >= 20 THEN
      RAISE EXCEPTION 'A room can have at most 20 open polls.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER command_polls_open_limit BEFORE INSERT ON command_polls FOR EACH ROW EXECUTE FUNCTION command_polls_enforce_open_limit();
CREATE FUNCTION command_poll_votes_require_open_poll() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE poll_state TEXT;
BEGIN
  SELECT state INTO poll_state FROM command_polls WHERE room_id = NEW.room_id AND poll_id = NEW.poll_id FOR UPDATE;
  IF poll_state <> 'OPEN' THEN
    RAISE EXCEPTION 'This poll is closed.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER command_poll_votes_require_open_poll BEFORE INSERT ON command_poll_votes FOR EACH ROW EXECUTE FUNCTION command_poll_votes_require_open_poll();
CREATE FUNCTION command_polls_require_monotonic_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'OPEN' OR NEW.state <> 'CLOSED' OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Poll lifecycle updates must be one monotonic OPEN to CLOSED transition.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER command_polls_monotonic_close BEFORE UPDATE ON command_polls FOR EACH ROW EXECUTE FUNCTION command_polls_require_monotonic_close();
