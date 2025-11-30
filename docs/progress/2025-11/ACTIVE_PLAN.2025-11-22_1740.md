# ACTIVE PLAN: Conversation Search v2 Implementation

**Status:** SUPERSEDED
**Created:** 2025-11-22
**Last Updated:** 2025-11-22
**Superseded By:** [ACTIVE_PLAN.md](../../ACTIVE_PLAN.md)

---

## Overview

Ground-up rebuild of conversation-search MCP server with sustainable architecture.

---

## Phase 1: Foundation

**Goal:** Core infrastructure that everything else builds on.

### 1.1 Project Setup
- [ ] Initialize package.json with dependencies
- [ ] Configure TypeScript (tsconfig.json)
- [ ] Set up ESLint/Prettier
- [ ] Create basic MCP server skeleton

**Dependencies:**
```json
{
  "@modelcontextprotocol/sdk": "latest",
  "better-sqlite3": "^9.x",
  "chromadb": "^1.x",
  "dotenv": "^16.x"
}
```

### 1.2 Database Schema
- [ ] Create schema migration runner
- [ ] Implement migration 001: initial schema
- [ ] Create database connection manager
- [ ] Verify schema creation on fresh DB

**Schema (Denormalized as requested):**
```sql
-- Migration 001: Initial Schema

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                    -- Claude's session_id (UUID)
  file_path TEXT NOT NULL,                -- Source JSONL file path
  project_path TEXT,                      -- Extracted project directory
  cwd TEXT,                               -- Working directory during session
  started_at TEXT NOT NULL,
  ended_at TEXT,
  message_count INTEGER DEFAULT 0,

  -- Metadata
  title TEXT,
  summary TEXT,
  is_title_auto_generated BOOLEAN DEFAULT FALSE,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,              -- Claude's message UUID
  session_id TEXT NOT NULL,

  -- Content (denormalized - includes redundant session info)
  role TEXT NOT NULL,                     -- 'user', 'assistant', 'system'
  content TEXT NOT NULL,

  -- Metadata
  timestamp TEXT NOT NULL,
  model TEXT,
  parent_uuid TEXT,
  message_type TEXT,
  cwd TEXT,                               -- Denormalized from session
  file_path TEXT,                         -- Denormalized from session

  -- Indexing
  content_hash TEXT,
  token_count INTEGER,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session_tags (
  session_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (session_id, tag_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Indexes
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_project ON sessions(project_path);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_timestamp ON messages(session_id, timestamp);
CREATE INDEX idx_messages_uuid ON messages(uuid);
CREATE INDEX idx_messages_hash ON messages(content_hash);
CREATE INDEX idx_session_tags_tag ON session_tags(tag_id);
```

### 1.3 Repository Layer
- [ ] Create DatabaseConnection class (better-sqlite3 wrapper)
- [ ] Implement SessionRepository
- [ ] Implement MessageRepository
- [ ] Implement TagRepository
- [ ] Add basic unit tests

**Files:**
```
src/
├── database/
│   ├── connection.ts          # Database connection manager
│   └── migrations/
│       ├── runner.ts          # Migration execution logic
│       └── 001_initial.ts     # First migration
├── repositories/
│   ├── SessionRepository.ts
│   ├── MessageRepository.ts
│   └── TagRepository.ts
└── types/
    └── models.ts              # TypeScript interfaces
```

---

## Phase 2: Data Import

**Goal:** Get all historical data into the new system.

### 2.1 JSONL Parser
- [ ] Create JSONL file parser
- [ ] Handle all message types (user, assistant, system, file-history-snapshot)
- [ ] Extract session metadata from first message
- [ ] Handle malformed/partial files gracefully

### 2.2 Import Service
- [ ] Implement ImportService
- [ ] Support multiple source directories
- [ ] Deduplication by message UUID
- [ ] Progress reporting
- [ ] Dry-run mode

**Data Sources:**
1. `~/.claude/projects/` (574 files, current)
2. `~/backups/conversation-search-old/claude-conversations/` (708 files, historical)

### 2.3 Initial Import
- [ ] Run full import from both sources
- [ ] Verify message counts
- [ ] Verify no duplicates
- [ ] Compare against v1 database counts

---

## Phase 3: Search Implementation

**Goal:** Make the data searchable.

### 3.1 Full-Text Search
- [ ] Implement SearchService with FTS5 queries
- [ ] Support phrase search
- [ ] Support filtering by date range
- [ ] Support filtering by project
- [ ] Ranking/relevance scoring

### 3.2 MCP Tools (Basic Set)
- [ ] search_conversations
- [ ] get_recent_conversations
- [ ] get_conversation_details
- [ ] get_session_for_resume
- [ ] update_database (trigger re-import)
- [ ] get_indexing_stats

### 3.3 Integration Testing
- [ ] Test each tool end-to-end
- [ ] Verify search results quality
- [ ] Performance benchmarks

---

## Phase 4: Organization Features

**Goal:** Help users organize their conversations.

### 4.1 Tagging System
- [ ] Implement TagService
- [ ] tag_conversation tool
- [ ] untag_conversation tool
- [ ] get_conversations_by_tag tool
- [ ] list_all_tags tool
- [ ] get_conversation_tags tool

### 4.2 Session Naming
- [ ] rename_conversation tool
- [ ] generate_conversation_summary tool
- [ ] batch_rename_recent tool
- [ ] list_conversations_with_names tool

---

## Phase 5: Vector Search

**Goal:** Enable semantic/similarity search.

### 5.1 ChromaDB Integration
- [ ] Set up ChromaDB client
- [ ] Create embedding pipeline (Nomic)
- [ ] Design chunk strategy (message-level vs session-level)

### 5.2 Embedding Generation
- [ ] Implement EmbeddingService
- [ ] Background embedding job
- [ ] Track embedding status per message/session

### 5.3 Hybrid Search
- [ ] vector_search_conversations tool
- [ ] hybrid_search_conversations tool (FTS + vector)
- [ ] get_similar_conversations tool

---

## Phase 6: Operations

**Goal:** Make it sustainable to run.

### 6.1 Background Sync
- [ ] Watch for new JSONL files
- [ ] Incremental import
- [ ] update_database_incremental tool

### 6.2 Maintenance
- [ ] Database health check
- [ ] Orphan cleanup
- [ ] Statistics reporting
- [ ] Rebuild commands

---

## Data Directory Structure

```
~/data/conversation-search-v2/
├── conversations.db           # SQLite database
├── chroma/                    # ChromaDB storage
│   └── ...
└── logs/
    └── import.log
```

---

## Testing Strategy

### Unit Tests
- Repository methods
- JSONL parser
- Search query building

### Integration Tests
- Full import flow
- Search end-to-end
- MCP tool responses

### Manual Validation
- Compare search results to v1
- Verify all sessions present
- Spot-check message content

---

## Rollout Plan

1. **Development:** Build v2 alongside v1 (v1 keeps running)
2. **Parallel:** Run both, compare results
3. **Migration:** When confident, switch MCP config to v2
4. **Deprecation:** Archive v1 after 2 weeks of v2 success

---

## Current Status

**Phase:** Not Started
**Next Action:** Initialize project (package.json, tsconfig.json)

---

## Notes

- Keep v1 running throughout development
- New database at `~/data/conversation-search-v2/conversations.db`
- Don't delete any source JSONL files
- Commit frequently, small incremental progress
