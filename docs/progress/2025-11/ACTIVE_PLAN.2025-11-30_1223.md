# ACTIVE PLAN: Conversation Search v2 Implementation

**Status:** SUPERSEDED
**Created:** 2025-11-22
**Last Updated:** 2025-11-24
**Previous Archive:** [ACTIVE_PLAN.2025-11-24_1756.md](./docs/progress/2025-11/ACTIVE_PLAN.2025-11-24_1756.md)
**Project:** Conversation Search v2 MCP Server
**Phase:** Phase 7 - Production Deployment (Blocked - Awaiting Claude Code Restart)

---

## Overview

Ground-up rebuild of conversation-search MCP server with sustainable architecture. Core functionality complete with database, repositories, import, and MCP tools operational.

---

## Phase 1: Foundation ✅ COMPLETED

**Goal:** Core infrastructure that everything else builds on.

### 1.1 Project Setup ✅
- [x] Initialize package.json with dependencies
- [x] Configure TypeScript (tsconfig.json)
- [x] Set up ESLint/Prettier
- [x] Create basic MCP server skeleton

### 1.2 Database Schema ✅
- [x] Create schema migration runner
- [x] Implement migration 001: initial schema
- [x] Implement migration 002: projects table
- [x] Create database connection manager
- [x] Verify schema creation on fresh DB

### 1.3 Repository Layer ✅
- [x] Create DatabaseConnection class (better-sqlite3 wrapper)
- [x] Implement SessionRepository
- [x] Implement MessageRepository
- [x] Implement TagRepository
- [x] Implement ProjectRepository (2025-11-23)

---

## Phase 2: Data Import ✅ COMPLETED

**Goal:** Get all historical data into the new system.

### 2.1 JSONL Parser ✅
- [x] Create JSONL file parser
- [x] Handle all message types (user, assistant, system, file-history-snapshot)
- [x] Extract session metadata from first message
- [x] Handle malformed/partial files gracefully

### 2.2 Import Service ✅
- [x] Implement ImportService
- [x] Support multiple source directories
- [x] Deduplication by message UUID
- [x] Progress reporting
- [x] Dry-run mode

### 2.3 Initial Import ✅
- [x] Run full import from both sources
- [x] Verify message counts (215,024 messages)
- [x] Verify no duplicates
- [x] Recover September 2025 data from v1 (129,711 messages)
- [x] Complete date coverage: July 23 - November 23, 2025

### 2.4 Automated Scheduling ✅ (2025-11-23)
- [x] Create wrapper script for imports
- [x] Set up cron (11:30 AM daily)
- [x] Set up anacron (catch-up for missed runs)
- [x] Test automated import
- [x] Verify logging

---

## Phase 3: Search Implementation ✅ COMPLETED

**Goal:** Make the data searchable.

### 3.1 Full-Text Search ✅
- [x] Implement SearchService with FTS5 queries
- [x] Support phrase search
- [x] Support filtering by date range
- [x] Support filtering by project
- [x] Ranking/relevance scoring

### 3.2 MCP Tools (Basic Set) ✅
- [x] search_conversations
- [x] get_recent_conversations (as browse_sessions)
- [x] get_conversation_details (as get_session)
- [x] get_session_for_resume (as get_session with resume context)
- [x] update_database (trigger re-import)
- [x] get_indexing_stats (as get_stats)

### 3.3 Integration Testing ✅
- [x] Test each tool end-to-end
- [x] Verify search results quality
- [x] Performance benchmarks (sub-second results)

---

## Phase 4: Organization Features ✅ MOSTLY COMPLETED

**Goal:** Help users organize their conversations.

### 4.1 Tagging System ✅
- [x] Implement TagService
- [x] tag_conversation tool (as tag_session)
- [x] untag_conversation tool (as untag_session)
- [x] get_conversations_by_tag tool (planned but not yet implemented)
- [x] list_all_tags tool (as list_tags)
- [x] get_conversation_tags tool (as get_session_tags)

### 4.2 Session Naming ⚠️ PARTIAL
- [x] rename_conversation tool (as update_session)
- [ ] generate_conversation_summary tool (not yet implemented)
- [ ] batch_rename_recent tool (not yet implemented)
- [x] list_conversations_with_names tool (as browse_sessions with filters)

### 4.3 Project Management ✅ NEW (2025-11-23)
- [x] list_projects tool
- [x] get_project tool
- [x] update_project tool
- [x] Project filtering in browse_sessions

---

## Phase 5: Vector Search 🔲 NOT STARTED

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

**Note:** Vector search functionality is being tracked in v1 project. V2 will implement once v1 approach is validated.

---

## Phase 6: Operations 🚧 IN PROGRESS

**Goal:** Make it sustainable to run.

### 6.1 Background Sync ✅ COMPLETED
- [x] Incremental import (via ImportService)
- [x] update_database_incremental tool (as update_database)
- [x] Automated scheduling (cron + anacron)
- [x] Logging system

### 6.2 Maintenance ⚠️ PARTIAL
- [x] Database health check (via get_stats)
- [x] Statistics reporting (via get_stats)
- [ ] Orphan cleanup
- [ ] Rebuild commands

---

## Phase 7: Production Deployment 🔲 CURRENT FOCUS

**Goal:** Deploy v2 alongside v1 for testing.

### 7.1 Configuration ⚠️ IN PROGRESS
- [ ] Register in `~/.claude/config.json`
- [ ] Add to mcp-config-manager discovery
- [ ] Test in live Claude Code session
- [ ] Verify all tools work as expected

### 7.2 Parallel Operation
- [ ] Run v1 and v2 simultaneously
- [ ] Compare search results
- [ ] Validate data consistency
- [ ] Monitor performance

### 7.3 Migration Preparation
- [ ] Document differences between v1 and v2
- [ ] Create rollback plan
- [ ] Test MCP client switching
- [ ] User acceptance testing

---

## Current Status

**Phase:** Phase 7 - Production Deployment
**Next Action:** Register server in Claude Code config

**Phase Completion:**
- ✅ Phase 1: Foundation (100%)
- ✅ Phase 2: Data Import (100%)
- ✅ Phase 3: Search Implementation (100%)
- ✅ Phase 4: Organization Features (85% - missing some naming tools)
- 🔲 Phase 5: Vector Search (0% - deferred)
- 🚧 Phase 6: Operations (60% - core automation done)
- 🚧 Phase 7: Production Deployment (10% - just started)

---

## Success Criteria

### Must Have (for v1 replacement)
- [x] All historical data imported (215K messages)
- [x] FTS search working
- [x] Session browsing and filtering
- [x] Tagging system
- [x] Project organization
- [x] Automated daily imports
- [ ] Registered in Claude Code config ⬅️ NEXT
- [ ] Live testing successful

### Nice to Have (future)
- [ ] Vector/semantic search
- [ ] Conversation summarization
- [ ] Batch rename operations
- [ ] Advanced analytics

---

## Data Directory Structure

```
~/data/conversation-search-v2/
├── conversations.db           # SQLite database (761MB)
├── chroma/                    # ChromaDB storage (future)
│   └── ...
└── logs/
    └── import.log            # Via ~/.claude/conversation-search-v2-import.log
```

---

## Testing Strategy

### Unit Tests ⚠️ NOT DONE
- [ ] Repository methods
- [ ] JSONL parser
- [ ] Search query building

### Integration Tests ✅ MANUAL TESTING DONE
- [x] Full import flow
- [x] Search end-to-end
- [x] MCP tool responses

### Manual Validation ✅ DONE
- [x] Compare data counts to v1
- [x] Verify all sessions present
- [x] Spot-check message content
- [x] Test automated imports

---

## Rollout Plan

1. ✅ **Development:** Build v2 alongside v1 (v1 keeps running)
2. ⬅️ **Registration:** Add v2 to Claude Code config (NEXT STEP)
3. 🔲 **Parallel:** Run both, compare results
4. 🔲 **Migration:** When confident, switch MCP config to v2
5. 🔲 **Deprecation:** Archive v1 after 2 weeks of v2 success

---

## Immediate Next Steps

### Step 1: MCP Server Registration
**Goal:** Make v2 available to Claude Code

Tasks:
- [ ] Add entry to `~/.claude/config.json` in mcpServers section
- [ ] Use server name: `conversation-search-v2`
- [ ] Point to build output: `~/projects/Utility/DEV-TOOLS/mcp-workspace/servers/your-servers/conversation-search-v2/dist/index.js`
- [ ] Test with `mcp__mcp-config-manager__list_servers`
- [ ] Verify all 15 tools are discoverable

### Step 2: Live Testing
**Goal:** Validate v2 works in production

Tasks:
- [ ] Search for known conversations
- [ ] Compare results with v1
- [ ] Test project filtering
- [ ] Test tagging workflow
- [ ] Verify automated import runs successfully

### Step 3: Parallel Operation
**Goal:** Gain confidence in v2

Tasks:
- [ ] Use both servers for 1 week
- [ ] Document any discrepancies
- [ ] Monitor performance
- [ ] Collect user feedback

---

## Notes

- Keep v1 running throughout rollout
- v2 database at `~/data/conversation-search-v2/conversations.db`
- Don't delete any source JSONL files
- Vector search deferred to future phase (being developed in v1 first)
- Automated imports keep database current daily
- September 2025 data successfully recovered from v1 database

---

## Dependencies Needed

**Already Installed:**
- @modelcontextprotocol/sdk
- better-sqlite3
- dotenv

**Future (for vector search):**
- chromadb (when Phase 5 starts)
- Ollama with nomic-embed-text model

---

## Learnings from v1

**What Worked:**
- Denormalized schema for simplicity
- FTS5 for fast full-text search
- Incremental import approach
- Session metadata extraction

**Improvements in v2:**
- Projects as first-class entity (not just denormalized string)
- Cleaner repository pattern
- Better TypeScript types
- Automated scheduling from day 1
- More comprehensive MCP tools (15 vs original set)

**To Watch:**
- Vector indexing complexity (from v1 experience)
- ChromaDB integration challenges
- Embedding cost/performance trade-offs
