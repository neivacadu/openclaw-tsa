-- tsa-skills-rank schema (SQLite local em /home/ace-tsia/.openclaw/data/skills.sqlite)
-- V1: FTS5 + heuristicas (use_count, success_rate, category match)
-- V2: substitui FTS5 por pgvector quando Camada 4 subir

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS skills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id        TEXT UNIQUE NOT NULL,
  skill_name      TEXT NOT NULL,
  skill_path      TEXT NOT NULL,
  description     TEXT,
  keywords        TEXT,                -- CSV ou JSON array
  category        TEXT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at    TIMESTAMP,
  use_count       INTEGER DEFAULT 0,
  success_rate    REAL DEFAULT 1.0,
  embedding       BLOB                 -- placeholder V2 pgvector
);

CREATE INDEX IF NOT EXISTS idx_skills_category    ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_last_used   ON skills(last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_use_count   ON skills(use_count DESC);

-- FTS5 virtual table (content table = skills, content_rowid = id)
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id,
  skill_name,
  description,
  keywords,
  content='skills',
  content_rowid='id'
);

-- Triggers pra manter FTS5 em sync
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, skill_id, skill_name, description, keywords)
  VALUES (new.id, new.skill_id, new.skill_name, new.description, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, skill_id, skill_name, description, keywords)
  VALUES ('delete', old.id, old.skill_id, old.skill_name, old.description, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, skill_id, skill_name, description, keywords)
  VALUES ('delete', old.id, old.skill_id, old.skill_name, old.description, old.keywords);
  INSERT INTO skills_fts(rowid, skill_id, skill_name, description, keywords)
  VALUES (new.id, new.skill_id, new.skill_name, new.description, new.keywords);
END;

-- Tracking de invocacoes (alimenta rank evolutivo)
CREATE TABLE IF NOT EXISTS skill_invocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id    TEXT NOT NULL,
  session_id  TEXT,
  query       TEXT,
  timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  result      TEXT                     -- ok | error | timeout | partial
);

CREATE INDEX IF NOT EXISTS idx_invocations_skill_id ON skill_invocations(skill_id);
CREATE INDEX IF NOT EXISTS idx_invocations_session  ON skill_invocations(session_id);
CREATE INDEX IF NOT EXISTS idx_invocations_ts       ON skill_invocations(timestamp DESC);

-- Cache de rank por query hash (evita recomputar identico em fluxo curto)
CREATE TABLE IF NOT EXISTS rank_cache (
  query_hash  TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rank_cache_created ON rank_cache(created_at);
