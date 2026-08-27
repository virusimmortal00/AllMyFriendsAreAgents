ALTER TABLE command_polls ADD COLUMN creator_kind TEXT NOT NULL DEFAULT 'human' CHECK(creator_kind IN ('human','agent'));
ALTER TABLE command_polls ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'legacy-creator';
ALTER TABLE command_polls ADD COLUMN state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','CLOSED'));
ALTER TABLE command_polls ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE command_polls ADD COLUMN closed_at TEXT;
ALTER TABLE command_polls ADD COLUMN closer_kind TEXT CHECK(closer_kind IN ('human','agent','controller'));
ALTER TABLE command_polls ADD COLUMN closer_id TEXT;
ALTER TABLE command_polls ADD COLUMN close_mutation_id TEXT;
ALTER TABLE command_polls ADD COLUMN final_tallies_json TEXT;
ALTER TABLE command_polls ADD COLUMN final_total_votes INTEGER CHECK(final_total_votes >= 0);
UPDATE command_polls
SET creator_kind = (SELECT invoker_kind FROM command_submissions WHERE command_submissions.room_id = command_polls.room_id AND command_submissions.submission_id = command_polls.submission_id),
    creator_id = (SELECT invoker_id FROM command_submissions WHERE command_submissions.room_id = command_polls.room_id AND command_submissions.submission_id = command_polls.submission_id);
UPDATE command_poll_votes
SET voter_id = 'human:' || voter_id
WHERE voter_id NOT LIKE 'human:%' AND voter_id NOT LIKE 'agent:%';
CREATE UNIQUE INDEX command_polls_close_mutation ON command_polls(room_id, close_mutation_id) WHERE close_mutation_id IS NOT NULL;
CREATE INDEX command_polls_open_room_created ON command_polls(room_id, state, created_at DESC, poll_id DESC);
CREATE TRIGGER command_polls_open_limit
BEFORE INSERT ON command_polls
WHEN NEW.state = 'OPEN' AND (SELECT count(*) FROM command_polls WHERE room_id = NEW.room_id AND state = 'OPEN') >= 20
BEGIN
  SELECT RAISE(ABORT, 'A room can have at most 20 open polls.');
END;
CREATE TRIGGER command_poll_votes_require_open_poll
BEFORE INSERT ON command_poll_votes
WHEN (SELECT state FROM command_polls WHERE room_id = NEW.room_id AND poll_id = NEW.poll_id) <> 'OPEN'
BEGIN
  SELECT RAISE(ABORT, 'This poll is closed.');
END;
CREATE TRIGGER command_polls_monotonic_close
BEFORE UPDATE ON command_polls
WHEN OLD.state <> 'OPEN' OR NEW.state <> 'CLOSED' OR NEW.revision <> OLD.revision + 1
  OR NEW.closed_at IS NULL OR NEW.closer_kind IS NULL OR NEW.closer_id IS NULL OR NEW.close_mutation_id IS NULL
  OR NEW.final_tallies_json IS NULL OR NEW.final_total_votes IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Poll lifecycle updates must be one monotonic OPEN to CLOSED transition.');
END;
