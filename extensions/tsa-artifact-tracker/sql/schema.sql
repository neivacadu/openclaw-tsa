-- tsa-artifact-tracker schema
-- Note: SQLite has no TIMESTAMPTZ; using TEXT ISO-8601 + DEFAULT CURRENT_TIMESTAMP.
-- The spec uses TIMESTAMPTZ for portability (Postgres mirror later); SQLite stores ISO text.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('html', 'pdf', 'doc', 'md', 'image', 'video', 'audio', 'data', 'code', 'other')),
  path TEXT UNIQUE NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER,
  mime_type TEXT,
  public_url TEXT,
  created_by_agent TEXT,
  created_in_session TEXT,
  prompt_summary TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  tags TEXT,
  content_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_kind        ON artifacts(kind);
CREATE INDEX IF NOT EXISTS idx_artifacts_session     ON artifacts(created_in_session);
CREATE INDEX IF NOT EXISTS idx_artifacts_status      ON artifacts(status);
CREATE INDEX IF NOT EXISTS idx_artifacts_created_at  ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash        ON artifacts(content_hash);

-- FTS5 mirror; keep in sync via triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  path, filename, prompt_summary, tags,
  content='artifacts',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, path, filename, prompt_summary, tags)
  VALUES (new.id, new.path, new.filename, new.prompt_summary, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, path, filename, prompt_summary, tags)
  VALUES('delete', old.id, old.path, old.filename, old.prompt_summary, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, path, filename, prompt_summary, tags)
  VALUES('delete', old.id, old.path, old.filename, old.prompt_summary, old.tags);
  INSERT INTO artifacts_fts(rowid, path, filename, prompt_summary, tags)
  VALUES (new.id, new.path, new.filename, new.prompt_summary, new.tags);
END;
