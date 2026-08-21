CREATE TABLE canonical_improvement_milestone_records (
  room_id TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  introduced_revision INTEGER NOT NULL CHECK (introduced_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'ACHIEVED', 'BLOCKED', 'CANCELED')),
  summary TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (room_id, improvement_id, milestone_id, introduced_revision),
  FOREIGN KEY (room_id, improvement_id, introduced_revision)
    REFERENCES canonical_improvement_revisions(room_id, improvement_id, revision) ON DELETE CASCADE
);

INSERT INTO canonical_improvement_milestone_records(
  room_id, improvement_id, milestone_id, introduced_revision, state, summary, recorded_at
)
SELECT room_id, improvement_id, milestone_id, introduced_revision, state, summary, recorded_at
FROM canonical_improvement_milestones;

CREATE TRIGGER canonical_improvement_milestone_records_no_update
BEFORE UPDATE ON canonical_improvement_milestone_records
BEGIN SELECT RAISE(ABORT, 'improvement milestone records are immutable'); END;

CREATE TRIGGER canonical_improvement_milestone_records_no_delete
BEFORE DELETE ON canonical_improvement_milestone_records
BEGIN SELECT RAISE(ABORT, 'improvement milestone records are immutable'); END;
