ALTER TABLE command_gh_executions ADD COLUMN authorization_lease TEXT CHECK(
  authorization_lease IS NULL OR authorization_lease ~ '^sha256:[a-f0-9]{64}$' OR authorization_lease = 'legacy-static'
);
