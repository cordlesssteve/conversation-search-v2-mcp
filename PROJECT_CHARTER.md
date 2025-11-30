# PROJECT CHARTER

**Status:** FOUNDATIONAL
**Created:** 2025-11-22
**Project Type:** Single-Branch
**Charter Version:** 1.0 (ORIGINAL)
**Revisions:** None

---

## Project Purpose

**Why does this exist?**

Conversation Search v2 is a ground-up rebuild of the conversation-search MCP server, designed for long-term sustainability, maintainability, and effectiveness. It provides tools for searching, organizing, and retrieving Claude Code conversation history.

**Core Problem:** Claude Code generates valuable conversation history stored in JSONL files, but there's no good way to search, organize, or retrieve past conversations. This MCP server indexes that data and provides search/retrieval capabilities.

**Why v2?** The original implementation (v1) had:
- No schema migration system
- Mixed concerns (SQL + vector search in one system)
- No clear data model separation
- Potential gaps in historical data capture

---

## Success Criteria

**What does "done" look like?**

### Minimum Viable Product (MVP)
- [ ] All historical conversations indexed (both current + backup sources)
- [ ] Full-text search working with FTS5
- [ ] Basic session listing and retrieval
- [ ] Schema migration system in place
- [ ] Clean separation of concerns (repositories, services, tools)

### Full Feature Set
- [ ] Vector/semantic search with ChromaDB
- [ ] Hybrid search (FTS + vector combined)
- [ ] Tagging system for organization
- [ ] Auto-generated session titles/summaries
- [ ] Background sync for new conversations
- [ ] Resume session functionality

### Quality Gates
- [ ] TypeScript compiles with zero errors
- [ ] All MCP tools respond correctly
- [ ] Database can be rebuilt from source JSONL files
- [ ] No data loss from v1 (all sessions recoverable)

---

## Scope Boundaries

### In Scope
- Indexing Claude Code conversation JSONL files
- Full-text search across conversation content
- Semantic/vector search for finding similar conversations
- Session organization (tags, names, summaries)
- MCP tool interface for all features
- Schema versioning and migrations
- Data import from multiple source directories

### Out of Scope
- Real-time conversation streaming (we index after the fact)
- Multi-user support (single-user local app)
- Cloud sync (handled externally)
- Analytics dashboards (may be external consumer)
- Conversation editing (read-only index)

---

## Key Stakeholders

| Stakeholder | Role | Interest |
|-------------|------|----------|
| cordlesssteve | Owner/User | Primary user, decision maker |
| Claude Code | Data Source | Generates JSONL files we index |
| Other MCP tools | Consumers | May query conversation data |

---

## Constraints

### Technical
- **Runtime:** MCP server (Node.js, long-running process)
- **Storage:** SQLite for structured data, ChromaDB for vectors
- **Language:** TypeScript
- **Platform:** WSL2 Linux environment

### Resource
- **Development time:** Incremental, alongside other projects
- **Compute:** Local machine only (no cloud infrastructure)

### Compatibility
- Must handle existing JSONL format from Claude Code
- Should import data from v1 database if needed

---

## Assumptions

1. Claude Code's JSONL format remains stable (or changes are manageable)
2. Single-user usage pattern (no concurrent access concerns)
3. Local embedding generation is sufficient (no API needed)
4. 1000-2000 sessions is the expected scale over time
5. v1 database and source JSONL files remain available during migration

---

## Known Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| JSONL format changes | Low | Medium | Version detection, adapter pattern |
| Data loss during migration | Low | High | Keep v1 running, verify before switch |
| ChromaDB complexity | Medium | Medium | Start with SQLite-only, add vector later |
| Scope creep | Medium | Medium | Strict adherence to this charter |

---

## Data Sources

**Primary Sources (to be indexed):**
1. `~/.claude/projects/` - 574 JSONL files (current)
2. `~/backups/conversation-search-old/claude-conversations/` - 708 JSONL files (historical)

**Reference (not indexed):**
- v1 database at `~/data/conversation-search/conversations.db` (for comparison/validation)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                  conversation-search-v2 MCP                      │
├─────────────────────────────────────────────────────────────────┤
│  MCP Tools Layer                                                 │
│  ├── search_conversations                                        │
│  ├── get_recent_conversations                                    │
│  ├── get_conversation_details                                    │
│  ├── tag_conversation / untag_conversation                       │
│  ├── get_conversations_by_tag                                    │
│  └── ... (16+ tools)                                            │
├─────────────────────────────────────────────────────────────────┤
│  Service Layer                                                   │
│  ├── SearchService (FTS + vector hybrid)                        │
│  ├── SessionService (CRUD, metadata)                            │
│  ├── TagService (organization)                                  │
│  └── IndexService (sync, import)                                │
├─────────────────────────────────────────────────────────────────┤
│  Repository Layer                                                │
│  ├── ProjectRepository                                          │
│  ├── SessionRepository                                          │
│  ├── MessageRepository                                          │
│  └── TagRepository                                              │
├─────────────────────────────────────────────────────────────────┤
│  Data Layer                                                      │
│  ├── SQLite (structured data + FTS5)                            │
│  └── ChromaDB (vector embeddings)                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-11-22 | Rebuild from scratch (v2) | Cleaner architecture, avoid migration complexity |
| 2025-11-22 | Keep denormalized schema | User preference, storage not a concern |
| 2025-11-22 | Use ChromaDB for vectors | User familiarity, mature ecosystem |
| 2025-11-22 | Keep Nomic for embeddings | Good balance of quality/speed/cost |
