PRAGMA legacy_alter_table = ON;
ALTER TABLE command_submissions RENAME TO command_submissions_pre_gh;
CREATE TABLE command_submissions (
  submission_id TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  client_submission_id TEXT NOT NULL, command_name TEXT NOT NULL CHECK(command_name IN ('task','pov','poll','help','gh')),
  invocation_json TEXT NOT NULL, invoker_kind TEXT NOT NULL CHECK(invoker_kind IN ('human','agent')),
  invoker_id TEXT NOT NULL, invoker_display_name TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(room_id, submission_id), UNIQUE(room_id, client_submission_id)
);
INSERT INTO command_submissions SELECT * FROM command_submissions_pre_gh;
DROP TABLE command_submissions_pre_gh;
PRAGMA legacy_alter_table = OFF;
CREATE TABLE command_gh_executions (
  execution_id TEXT NOT NULL, room_id TEXT NOT NULL, submission_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','completed','failed')),
  projection_json TEXT, rendered_text TEXT CHECK(rendered_text IS NULL OR length(rendered_text) <= 4000), failure_kind TEXT, diagnostics_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,execution_id), UNIQUE(room_id,submission_id),
  FOREIGN KEY(room_id,submission_id) REFERENCES command_submissions(room_id,submission_id) ON DELETE CASCADE
);
CREATE TRIGGER command_gh_execution_acceptance
AFTER INSERT ON command_submissions WHEN NEW.command_name='gh'
BEGIN
  INSERT INTO command_gh_executions(execution_id,room_id,submission_id,status,projection_json,rendered_text,failure_kind,diagnostics_json,created_at,updated_at)
  VALUES(NEW.submission_id || '-gh',NEW.room_id,NEW.submission_id,'queued',NULL,NULL,NULL,'[]',NEW.created_at,NEW.created_at);
END;
