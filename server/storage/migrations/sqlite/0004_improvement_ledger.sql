ALTER TABLE canonical_improvements
  ADD COLUMN status_contract_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"implementation":{"state":"UNKNOWN"},"deployment":{"state":"UNKNOWN"},"developerTeamEvidence":{"state":"UNKNOWN"},"independentAcceptance":{"state":"UNKNOWN"},"upstreamPublication":{"state":"UNKNOWN"},"nextAction":{"state":"UNKNOWN"}}';

UPDATE canonical_improvements
SET status_contract_json = CASE
  WHEN json_type(projection_json, '$.statusContract') = 'object'
    THEN json_extract(projection_json, '$.statusContract')
  ELSE status_contract_json
END;

CREATE TABLE canonical_improvement_revisions (
  room_id TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle_state TEXT NOT NULL,
  status_contract_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, improvement_id, revision),
  FOREIGN KEY (room_id, improvement_id)
    REFERENCES canonical_improvements(room_id, id) ON DELETE CASCADE
);

INSERT INTO canonical_improvement_revisions(
  room_id, improvement_id, revision, lifecycle_state, status_contract_json, snapshot_json, created_at
)
SELECT
  room_id,
  improvement_id,
  revision,
  json_extract(snapshot_json, '$.state'),
  CASE
    WHEN json_type(snapshot_json, '$.statusContract') = 'object'
      THEN json_extract(snapshot_json, '$.statusContract')
    ELSE '{"schemaVersion":1,"implementation":{"state":"UNKNOWN"},"deployment":{"state":"UNKNOWN"},"developerTeamEvidence":{"state":"UNKNOWN"},"independentAcceptance":{"state":"UNKNOWN"},"upstreamPublication":{"state":"UNKNOWN"},"nextAction":{"state":"UNKNOWN"}}'
  END,
  snapshot_json,
  occurred_at
FROM canonical_improvement_events;

CREATE TABLE canonical_improvement_evidence (
  room_id TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  introduced_revision INTEGER NOT NULL CHECK (introduced_revision >= 1),
  qualification TEXT NOT NULL CHECK (qualification IN ('DEVELOPER_TEAM', 'INDEPENDENT_ACCEPTANCE', 'UNQUALIFIED')),
  evidence_kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  summary TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (room_id, improvement_id, evidence_id),
  FOREIGN KEY (room_id, improvement_id, introduced_revision)
    REFERENCES canonical_improvement_revisions(room_id, improvement_id, revision) ON DELETE CASCADE
);

CREATE TABLE canonical_improvement_milestones (
  room_id TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  introduced_revision INTEGER NOT NULL CHECK (introduced_revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'ACHIEVED', 'BLOCKED', 'CANCELED')),
  summary TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (room_id, improvement_id, milestone_id),
  FOREIGN KEY (room_id, improvement_id, introduced_revision)
    REFERENCES canonical_improvement_revisions(room_id, improvement_id, revision) ON DELETE CASCADE
);

CREATE TABLE canonical_improvement_audit_history (
  room_id TEXT NOT NULL,
  improvement_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  event_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL,
  PRIMARY KEY (room_id, improvement_id, event_id),
  FOREIGN KEY (room_id, improvement_id, revision)
    REFERENCES canonical_improvement_revisions(room_id, improvement_id, revision) ON DELETE CASCADE
);

INSERT INTO canonical_improvement_audit_history(
  room_id, improvement_id, event_id, revision, event_kind, actor_id, occurred_at, details_json
)
SELECT
  room_id,
  improvement_id,
  'revision-' || revision,
  revision,
  CASE WHEN revision = 1 THEN 'CREATED' ELSE 'REVISED' END,
  actor_id,
  occurred_at,
  change_json
FROM canonical_improvement_events;

CREATE TRIGGER canonical_improvement_revisions_no_update
BEFORE UPDATE ON canonical_improvement_revisions
BEGIN SELECT RAISE(ABORT, 'improvement revisions are immutable'); END;

CREATE TRIGGER canonical_improvement_revisions_no_delete
BEFORE DELETE ON canonical_improvement_revisions
BEGIN SELECT RAISE(ABORT, 'improvement revisions are immutable'); END;

CREATE TRIGGER canonical_improvement_evidence_no_update
BEFORE UPDATE ON canonical_improvement_evidence
BEGIN SELECT RAISE(ABORT, 'improvement evidence is immutable'); END;

CREATE TRIGGER canonical_improvement_evidence_no_delete
BEFORE DELETE ON canonical_improvement_evidence
BEGIN SELECT RAISE(ABORT, 'improvement evidence is immutable'); END;

CREATE TRIGGER canonical_improvement_milestones_no_update
BEFORE UPDATE ON canonical_improvement_milestones
BEGIN SELECT RAISE(ABORT, 'improvement milestones are immutable'); END;

CREATE TRIGGER canonical_improvement_milestones_no_delete
BEFORE DELETE ON canonical_improvement_milestones
BEGIN SELECT RAISE(ABORT, 'improvement milestones are immutable'); END;

CREATE TRIGGER canonical_improvement_audit_no_update
BEFORE UPDATE ON canonical_improvement_audit_history
BEGIN SELECT RAISE(ABORT, 'improvement audit history is append-only'); END;

CREATE TRIGGER canonical_improvement_audit_no_delete
BEFORE DELETE ON canonical_improvement_audit_history
BEGIN SELECT RAISE(ABORT, 'improvement audit history is append-only'); END;
