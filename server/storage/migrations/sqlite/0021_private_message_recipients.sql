ALTER TABLE messages ADD COLUMN recipient_human_id TEXT;
CREATE INDEX messages_private_recipient_idx
  ON messages(room_id, recipient_human_id, row_id)
  WHERE recipient_human_id IS NOT NULL;
