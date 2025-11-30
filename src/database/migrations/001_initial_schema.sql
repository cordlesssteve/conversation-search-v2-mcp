-- Migration 001: Initial Schema
-- Created: 2025-11-22
-- Description: Core tables for conversation search v2

-- ============================================
-- MIGRATION TRACKING
-- ============================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  checksum TEXT
);

-- ============================================
-- CORE ENTITIES
-- ============================================

-- Sessions represent individual conversation instances
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                    -- Claude's session_id (UUID)
  file_path TEXT NOT NULL,                -- Source JSONL file path (denormalized)
  project_path TEXT,                      -- Extracted project directory
  cwd TEXT,                               -- Working directory during session
  started_at TEXT NOT NULL,
  ended_at TEXT,                          -- NULL if session has only one message or is active
  message_count INTEGER DEFAULT 0,        -- Denormalized count for quick access

  -- Metadata
  title TEXT,                             -- User-assigned or auto-generated name
  summary TEXT,                           -- AI-generated summary
  is_title_auto_generated BOOLEAN DEFAULT FALSE,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Messages are individual turns in a conversation
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,              -- Claude's message UUID
  session_id TEXT NOT NULL,

  -- Content
  role TEXT NOT NULL,                     -- 'user', 'assistant', 'system'
  content TEXT NOT NULL,

  -- Metadata
  timestamp TEXT NOT NULL,
  model TEXT,                             -- e.g., 'claude-sonnet-4-5-...'
  parent_uuid TEXT,                       -- For conversation threading
  message_type TEXT,                      -- 'user', 'assistant', 'system', etc.

  -- Denormalized fields (for query convenience)
  cwd TEXT,                               -- Working directory (from session)
  file_path TEXT,                         -- Source file (from session)

  -- Indexing helpers
  content_hash TEXT,                      -- MD5 hash for deduplication
  token_count INTEGER,                    -- Estimated token count

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- ============================================
-- ORGANIZATION FEATURES
-- ============================================

-- Tags for categorizing sessions
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,              -- Tag name (lowercase, normalized)
  color TEXT,                             -- Hex color for UI (optional)
  description TEXT,                       -- What this tag means
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Many-to-many relationship: sessions <-> tags
CREATE TABLE session_tags (
  session_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (session_id, tag_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- ============================================
-- FULL-TEXT SEARCH
-- ============================================

-- FTS5 virtual table for efficient text search
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=id,
  tokenize='porter unicode61'             -- Porter stemming + unicode support
);

-- Triggers to keep FTS index synchronized with messages table
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- ============================================
-- INDEXES
-- ============================================

-- Sessions indexes
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_ended ON sessions(ended_at DESC);
CREATE INDEX idx_sessions_project ON sessions(project_path);
CREATE INDEX idx_sessions_file ON sessions(file_path);

-- Messages indexes
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(session_id, timestamp);
CREATE INDEX idx_messages_role ON messages(session_id, role);
CREATE INDEX idx_messages_uuid ON messages(uuid);
CREATE INDEX idx_messages_hash ON messages(content_hash);
CREATE INDEX idx_messages_cwd ON messages(cwd);

-- Tags indexes
CREATE INDEX idx_session_tags_tag ON session_tags(tag_id);
CREATE INDEX idx_tags_name ON tags(name);

-- ============================================
-- PRAGMAS (to be set at connection time)
-- ============================================
-- PRAGMA foreign_keys = ON;
-- PRAGMA journal_mode = WAL;
-- PRAGMA synchronous = NORMAL;
-- PRAGMA cache_size = -64000;  -- 64MB cache
