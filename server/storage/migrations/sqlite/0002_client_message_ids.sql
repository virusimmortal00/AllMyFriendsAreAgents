ALTER TABLE messages ADD COLUMN client_message_id TEXT;
CREATE UNIQUE INDEX messages_human_client_id_idx
  ON messages(room_id, human_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
