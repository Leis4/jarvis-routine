-- Private schedule template storage (privacy migration, additive only).
-- The personal weekly schedule must never be served from public static assets again.
-- Snapshot/history tables are untouched; no data is deleted by this migration.
CREATE TABLE IF NOT EXISTS schedule_template (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);