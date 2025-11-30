-- Migration 002: Add Projects as First-Class Entity
-- Created: 2025-11-23
-- Description: Elevates projects from denormalized field to proper entity

-- ============================================
-- PROJECTS TABLE
-- ============================================

-- Projects represent distinct working directories/codebases
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,              -- Full path: /home/user/projects/Foo
  name TEXT NOT NULL,                     -- Display name: "Foo" (user-editable)
  description TEXT,                       -- Optional user description

  -- Denormalized statistics (updated during import)
  session_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT,                  -- Most recent session timestamp
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for path lookups during import
CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

-- Index for listing projects by activity
CREATE INDEX IF NOT EXISTS idx_projects_activity ON projects(last_activity_at DESC);

-- ============================================
-- MODIFY SESSIONS TABLE
-- ============================================

-- Add project_id foreign key to sessions
ALTER TABLE sessions ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;

-- Index for finding sessions by project
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

-- ============================================
-- DATA MIGRATION
-- ============================================

-- Step 1: Create "General" project for home directory sessions
INSERT INTO projects (path, name, description, created_at, last_activity_at)
SELECT
  '/home/cordlesssteve',
  'General',
  'General conversations not tied to a specific project',
  MIN(started_at),
  MAX(started_at)
FROM sessions
WHERE project_path = '/home/cordlesssteve'
   OR project_path IS NULL;

-- Step 2: Create projects from distinct project_paths
-- Extract name as last path segment using REPLACE trick (SQLite has no REVERSE)
INSERT OR IGNORE INTO projects (path, name, created_at, last_activity_at)
SELECT DISTINCT
  project_path,
  -- Extract last path segment: replace '/' with 50 spaces, take last 50 chars, trim
  TRIM(SUBSTR(REPLACE(RTRIM(project_path, '/'), '/', '                                                  '), -50)),
  MIN(started_at),
  MAX(started_at)
FROM sessions
WHERE project_path IS NOT NULL
  AND project_path != '/home/cordlesssteve'
GROUP BY project_path;

-- Step 3: Link sessions to projects
UPDATE sessions
SET project_id = (
  SELECT id FROM projects WHERE path = sessions.project_path
)
WHERE project_path IS NOT NULL;

-- Step 4: Link NULL project_path sessions to General project
UPDATE sessions
SET project_id = (SELECT id FROM projects WHERE path = '/home/cordlesssteve')
WHERE project_path IS NULL OR project_path = '/home/cordlesssteve';

-- Step 5: Update denormalized counts
UPDATE projects
SET
  session_count = (SELECT COUNT(*) FROM sessions WHERE project_id = projects.id),
  message_count = (SELECT COALESCE(SUM(message_count), 0) FROM sessions WHERE project_id = projects.id);

-- ============================================
-- HELPER FUNCTION (via trigger for future inserts)
-- ============================================

-- Update project stats when session is inserted
CREATE TRIGGER IF NOT EXISTS update_project_stats_insert
AFTER INSERT ON sessions
WHEN NEW.project_id IS NOT NULL
BEGIN
  UPDATE projects
  SET
    session_count = session_count + 1,
    message_count = message_count + NEW.message_count,
    last_activity_at = CASE
      WHEN last_activity_at IS NULL OR NEW.started_at > last_activity_at
      THEN NEW.started_at
      ELSE last_activity_at
    END,
    updated_at = datetime('now')
  WHERE id = NEW.project_id;
END;

-- Update project stats when session message_count changes
CREATE TRIGGER IF NOT EXISTS update_project_stats_update
AFTER UPDATE OF message_count ON sessions
WHEN NEW.project_id IS NOT NULL
BEGIN
  UPDATE projects
  SET
    message_count = message_count + (NEW.message_count - OLD.message_count),
    updated_at = datetime('now')
  WHERE id = NEW.project_id;
END;

-- Update project stats when session is deleted
CREATE TRIGGER IF NOT EXISTS update_project_stats_delete
AFTER DELETE ON sessions
WHEN OLD.project_id IS NOT NULL
BEGIN
  UPDATE projects
  SET
    session_count = session_count - 1,
    message_count = message_count - OLD.message_count,
    updated_at = datetime('now')
  WHERE id = OLD.project_id;
END;
