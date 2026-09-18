-- 0030: room-level toggle for the advisory intent classifier consulted during
-- shadow/enforce pre-flight routing. Defaults to enabled (1); older rows keep
-- the enabled default so no backfill is required.
ALTER TABLE room_settings ADD COLUMN intent_classifier_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (intent_classifier_enabled IN (0, 1));
