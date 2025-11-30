/**
 * Core data models for Conversation Search v2
 *
 * These interfaces define the shape of data throughout the application.
 * They map closely to the database schema but are TypeScript-native.
 */

// ============================================
// DATABASE ENTITIES
// ============================================

/**
 * A project represents a distinct working directory/codebase.
 * Projects contain multiple sessions and provide organizational context.
 */
export interface Project {
  id: number;                       // Auto-increment primary key
  path: string;                     // Full path: /home/user/projects/Foo
  name: string;                     // Display name (user-editable): "Foo"
  description: string | null;       // Optional user description

  // Denormalized statistics
  session_count: number;            // Number of sessions in project
  message_count: number;            // Total messages across all sessions

  // Timestamps
  created_at: string;               // When project was first seen
  last_activity_at: string | null;  // Most recent session timestamp
  updated_at: string;               // Last modification
}

/**
 * A session represents a single conversation with Claude Code.
 * Sessions contain multiple messages and can be tagged for organization.
 */
export interface Session {
  id: string;                       // Claude's session_id (UUID format)
  file_path: string;                // Source JSONL file path
  project_id: number | null;        // FK to projects.id
  project_path: string | null;      // Extracted project directory (kept for backward compat)
  cwd: string | null;               // Working directory during session
  started_at: string;               // ISO 8601 timestamp
  ended_at: string | null;          // ISO 8601 timestamp or null if single-message/active
  message_count: number;            // Total messages in session

  // Metadata
  title: string | null;             // User-assigned or auto-generated name
  summary: string | null;           // AI-generated summary
  is_title_auto_generated: boolean;
  is_stub: boolean;                 // True if created via hook before full import

  // Timestamps
  created_at: string;               // When indexed
  updated_at: string;               // Last modification
}

/**
 * A message is a single turn in a conversation.
 * Can be from user, assistant, or system.
 */
export interface Message {
  id: number;                       // Auto-increment primary key
  uuid: string;                     // Claude's message UUID
  session_id: string;               // FK to sessions.id

  // Content
  role: 'user' | 'assistant' | 'system' | 'unknown';
  content: string;

  // Metadata
  timestamp: string;                // ISO 8601 timestamp
  model: string | null;             // e.g., 'claude-sonnet-4-5-...'
  parent_uuid: string | null;       // For conversation threading
  message_type: string | null;      // Original type from JSONL

  // Denormalized fields
  cwd: string | null;
  file_path: string | null;

  // Indexing helpers
  content_hash: string | null;      // MD5 for deduplication
  token_count: number | null;       // Estimated tokens

  created_at: string;
}

/**
 * A tag for organizing sessions.
 */
export interface Tag {
  id: number;
  name: string;                     // Normalized (lowercase, trimmed)
  color: string | null;             // Hex color for UI
  description: string | null;
  created_at: string;
}

/**
 * Junction table entry for session-tag relationship.
 */
export interface SessionTag {
  session_id: string;
  tag_id: number;
  created_at: string;
}

// ============================================
// JSONL PARSING TYPES
// ============================================

/**
 * Raw message structure from Claude Code's JSONL files.
 * This is what we parse from the source files.
 */
export interface RawJsonlMessage {
  type: 'user' | 'assistant' | 'system' | 'file-history-snapshot' | 'summary';
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  agentId?: string;

  // Summary line (first line of file)
  summary?: string;
  leafUuid?: string;

  // Message content varies by type
  message?: {
    role: string;
    content: string | ContentBlock[];
    model?: string;
  };

  // For user messages without nested message object
  content?: string;
}

/**
 * Content block for assistant messages with structured content.
 */
export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
}

// ============================================
// QUERY/RESPONSE TYPES
// ============================================

/**
 * Options for searching conversations.
 */
export interface SearchOptions {
  query: string;
  role?: 'user' | 'assistant' | 'system';
  limit?: number;
  offset?: number;
  project?: string;
  tag?: string;
  date_from?: string;
  date_to?: string;
}

/**
 * A search result with relevance information.
 */
export interface SearchResult {
  session: Session;
  matching_content: string;         // Snippet of matching text
  match_count: number;              // Number of matches in session
  relevance_score?: number;         // FTS or vector similarity score
}

/**
 * Session with additional context for display.
 */
export interface SessionWithContext extends Session {
  tags: Tag[];
  project?: Project;                // Associated project (if joined)
  first_message?: string;           // Preview of first user message
  display_name: string;             // title or first_message or 'Unnamed'
}

/**
 * Project with recent sessions for display.
 */
export interface ProjectWithSessions extends Project {
  recent_sessions: Session[];       // Most recent sessions
}

/**
 * Statistics about the indexed data.
 */
export interface IndexingStats {
  total_sessions: number;
  total_messages: number;
  total_tags: number;
  messages_by_role: Record<string, number>;
  date_range: {
    earliest: string | null;
    latest: string | null;
  };
  database_size_bytes: number;
}

/**
 * Result of an import operation.
 */
export interface ImportResult {
  source_path: string;
  files_found: number;
  files_processed: number;
  sessions_created: number;
  sessions_updated: number;
  messages_created: number;
  messages_skipped: number;         // Duplicates
  errors: ImportError[];
  duration_ms: number;
}

export interface ImportError {
  file_path: string;
  error: string;
  line_number?: number;
}

// ============================================
// VECTOR SEARCH TYPES (Phase 5)
// ============================================

/**
 * A chunk of content with its embedding.
 * Used for vector similarity search.
 */
export interface EmbeddingChunk {
  id: string;                       // chunk_id
  session_id: string;
  message_id?: number;              // If chunk is from a specific message
  content: string;
  embedding?: number[];             // Vector embedding (768 dimensions for Nomic)
  token_count: number;
  created_at: string;
}

/**
 * Vector search result with similarity score.
 */
export interface VectorSearchResult {
  chunk: EmbeddingChunk;
  session: Session;
  similarity_score: number;         // 0-1, higher is more similar
  rank: number;
}

/**
 * Options for vector/hybrid search.
 */
export interface VectorSearchOptions extends SearchOptions {
  semantic_weight?: number;         // 0-1, weight for vector vs FTS
  include_adjacent?: boolean;       // Include surrounding context
}
