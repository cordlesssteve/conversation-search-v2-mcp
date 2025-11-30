-- Migration 003: Add Session Stub Support
-- Created: 2025-11-23
-- Description: Add is_stub field to sessions for early session registration before full import

-- ============================================
-- ADD IS_STUB FIELD
-- ============================================

-- Add is_stub boolean to sessions table
-- Stubs are created when a session starts (via hook) before messages are available
-- Import will later fill in the full session data while preserving tags
ALTER TABLE sessions ADD COLUMN is_stub BOOLEAN DEFAULT FALSE;

-- Make file_path nullable for stubs (stubs don't have a file path yet)
-- SQLite doesn't support ALTER COLUMN, so we need to work around this
-- For now, we'll allow NULL by inserting with placeholder values

-- ============================================
-- INDEX FOR FINDING STUBS
-- ============================================

-- Index to quickly find stub sessions that need updating
CREATE INDEX idx_sessions_is_stub ON sessions(is_stub) WHERE is_stub = TRUE;

-- Migration record is handled by the MigrationRunner
