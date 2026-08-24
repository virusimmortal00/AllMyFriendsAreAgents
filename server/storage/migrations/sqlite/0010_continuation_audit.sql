CREATE TABLE continuation_job_events (
  room_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_revision INTEGER NOT NULL CHECK (job_revision > 0),
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  PRIMARY KEY (room_id, job_id, job_revision),
  UNIQUE (room_id, event_id),
  FOREIGN KEY (room_id, job_id) REFERENCES continuation_jobs(room_id, job_id) ON DELETE CASCADE
);
CREATE INDEX continuation_job_events_order ON continuation_job_events(room_id, job_id, job_revision);
