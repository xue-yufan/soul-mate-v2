ALTER TABLE session_summaries
  ADD COLUMN summarized_through_rowid INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_session_role
  ON messages(session_id, role);
