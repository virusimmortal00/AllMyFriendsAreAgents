ALTER TABLE command_gh_executions ADD COLUMN authorization_lease TEXT CHECK(
  authorization_lease IS NULL OR authorization_lease GLOB 'sha256:*' OR authorization_lease = 'legacy-static'
);
