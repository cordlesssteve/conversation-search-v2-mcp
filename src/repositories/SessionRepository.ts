/**
 * Session Repository
 *
 * Data access layer for conversation sessions.
 */

import { DatabaseConnection } from '../database/index.js';
import type { Session, SessionWithContext, Tag } from '../types/models.js';

export interface CreateSessionInput {
  id: string;
  file_path: string;
  project_id?: number;              // FK to projects.id
  project_path?: string;            // Kept for backward compatibility
  cwd?: string;
  started_at: string;
  ended_at?: string;
  message_count?: number;
  title?: string;
  summary?: string;
  is_title_auto_generated?: boolean;
  is_stub?: boolean;                // True if creating a stub before import
}

export interface CreateStubInput {
  id: string;                       // Session UUID from Claude
  project_path?: string;            // Project path if known
  cwd?: string;                     // Working directory
  started_at?: string;              // Defaults to now
}

export interface UpdateSessionInput {
  ended_at?: string;
  message_count?: number;
  title?: string;
  summary?: string;
  is_title_auto_generated?: boolean;
}

export interface SessionFilter {
  project_id?: number;              // Filter by project (preferred)
  project_path?: string;            // Filter by path (backward compat)
  tag_id?: number;
  has_title?: boolean;
  date_from?: string;
  date_to?: string;
}

export class SessionRepository {
  constructor(private db: DatabaseConnection) {}

  /**
   * Create a new session.
   */
  create(input: CreateSessionInput): Session {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, file_path, project_id, project_path, cwd, started_at, ended_at,
        message_count, title, summary, is_title_auto_generated, is_stub
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.id,
      input.file_path,
      input.project_id ?? null,
      input.project_path ?? null,
      input.cwd ?? null,
      input.started_at,
      input.ended_at ?? null,
      input.message_count ?? 0,
      input.title ?? null,
      input.summary ?? null,
      input.is_title_auto_generated ? 1 : 0,
      input.is_stub ? 1 : 0
    );

    return this.findById(input.id)!;
  }

  /**
   * Create a stub session for early registration before full import.
   * Stubs allow tagging sessions before messages are available.
   */
  createStub(input: CreateStubInput): Session {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, file_path, project_path, cwd, started_at,
        message_count, is_stub
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      input.id,
      'STUB:pending_import',  // Placeholder file_path for stubs
      input.project_path ?? null,
      input.cwd ?? null,
      input.started_at ?? now,
      0,
      1  // is_stub = true
    );

    return this.findById(input.id)!;
  }

  /**
   * Check if a session is a stub (created before import).
   */
  isStub(id: string): boolean {
    const result = this.db
      .prepare('SELECT is_stub FROM sessions WHERE id = ?')
      .get(id) as { is_stub: number } | undefined;

    return result?.is_stub === 1;
  }

  /**
   * Update a stub session with full import data.
   * Preserves tags and other user-set metadata.
   */
  updateFromImport(id: string, input: CreateSessionInput): Session | null {
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        file_path = ?,
        project_id = ?,
        project_path = ?,
        cwd = ?,
        started_at = ?,
        ended_at = ?,
        message_count = ?,
        is_stub = 0,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    stmt.run(
      input.file_path,
      input.project_id ?? null,
      input.project_path ?? null,
      input.cwd ?? null,
      input.started_at,
      input.ended_at ?? null,
      input.message_count ?? 0,
      id
    );

    return this.findById(id);
  }

  /**
   * Find all stub sessions that need import data.
   */
  findStubs(): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE is_stub = 1')
      .all() as Session[];
  }

  /**
   * Find a session by ID.
   */
  findById(id: string): Session | null {
    const result = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Session | undefined;

    return result ?? null;
  }

  /**
   * Check if a session exists.
   */
  exists(id: string): boolean {
    const result = this.db
      .prepare('SELECT 1 FROM sessions WHERE id = ?')
      .get(id);

    return result !== undefined;
  }

  /**
   * Update a session.
   */
  update(id: string, input: UpdateSessionInput): Session | null {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.ended_at !== undefined) {
      fields.push('ended_at = ?');
      values.push(input.ended_at);
    }
    if (input.message_count !== undefined) {
      fields.push('message_count = ?');
      values.push(input.message_count);
    }
    if (input.title !== undefined) {
      fields.push('title = ?');
      values.push(input.title);
    }
    if (input.summary !== undefined) {
      fields.push('summary = ?');
      values.push(input.summary);
    }
    if (input.is_title_auto_generated !== undefined) {
      fields.push('is_title_auto_generated = ?');
      values.push(input.is_title_auto_generated ? 1 : 0);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push("updated_at = datetime('now')");
    values.push(id);

    this.db
      .prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findById(id);
  }

  /**
   * Delete a session (cascades to messages and tags).
   */
  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(id);

    return result.changes > 0;
  }

  /**
   * Find all sessions (for bulk operations like indexing).
   * Returns sessions ordered by started_at ascending for consistent processing.
   */
  findAll(): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at ASC')
      .all() as Session[];
  }

  /**
   * Find recent sessions with optional filters.
   */
  findRecent(limit: number = 20, offset: number = 0, filter?: SessionFilter): Session[] {
    let sql = 'SELECT DISTINCT s.* FROM sessions s';
    const params: unknown[] = [];
    const conditions: string[] = [];

    // Join with tags if filtering by tag
    if (filter?.tag_id) {
      sql += ' INNER JOIN session_tags st ON s.id = st.session_id';
      conditions.push('st.tag_id = ?');
      params.push(filter.tag_id);
    }

    if (filter?.project_id) {
      conditions.push('s.project_id = ?');
      params.push(filter.project_id);
    } else if (filter?.project_path) {
      conditions.push('s.project_path LIKE ?');
      params.push(`%${filter.project_path}%`);
    }

    if (filter?.has_title === true) {
      conditions.push('s.title IS NOT NULL');
    } else if (filter?.has_title === false) {
      conditions.push('s.title IS NULL');
    }

    if (filter?.date_from) {
      conditions.push('s.started_at >= ?');
      params.push(filter.date_from);
    }

    if (filter?.date_to) {
      conditions.push('s.started_at <= ?');
      params.push(filter.date_to);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY s.started_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as Session[];
  }

  /**
   * Find sessions with context (includes tags and first message preview).
   */
  findRecentWithContext(limit: number = 20, offset: number = 0, filter?: SessionFilter): SessionWithContext[] {
    const sessions = this.findRecent(limit, offset, filter);

    return sessions.map(session => {
      const tags = this.getSessionTags(session.id);
      const firstMessage = this.getFirstUserMessage(session.id);

      return {
        ...session,
        tags,
        first_message: firstMessage,
        display_name: session.title || firstMessage || 'Unnamed conversation',
      };
    });
  }

  /**
   * Get tags for a session.
   */
  private getSessionTags(sessionId: string): Tag[] {
    return this.db
      .prepare(`
        SELECT t.* FROM tags t
        INNER JOIN session_tags st ON t.id = st.tag_id
        WHERE st.session_id = ?
        ORDER BY t.name
      `)
      .all(sessionId) as Tag[];
  }

  /**
   * Get first user message content (for preview).
   */
  private getFirstUserMessage(sessionId: string): string | undefined {
    const result = this.db
      .prepare(`
        SELECT content FROM messages
        WHERE session_id = ? AND role = 'user'
        ORDER BY timestamp ASC
        LIMIT 1
      `)
      .get(sessionId) as { content: string } | undefined;

    if (result?.content) {
      // Truncate to ~100 chars for preview
      const cleaned = result.content.replace(/\s+/g, ' ').trim();
      return cleaned.length > 100 ? cleaned.slice(0, 100) + '...' : cleaned;
    }

    return undefined;
  }

  /**
   * Count total sessions.
   */
  count(filter?: SessionFilter): number {
    let sql = 'SELECT COUNT(DISTINCT s.id) as count FROM sessions s';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filter?.tag_id) {
      sql += ' INNER JOIN session_tags st ON s.id = st.session_id';
      conditions.push('st.tag_id = ?');
      params.push(filter.tag_id);
    }

    if (filter?.project_id) {
      conditions.push('s.project_id = ?');
      params.push(filter.project_id);
    } else if (filter?.project_path) {
      conditions.push('s.project_path LIKE ?');
      params.push(`%${filter.project_path}%`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const result = this.db.prepare(sql).get(...params) as { count: number };
    return result.count;
  }

  /**
   * Get unique project paths.
   */
  getProjects(): string[] {
    const results = this.db
      .prepare('SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL ORDER BY project_path')
      .all() as Array<{ project_path: string }>;

    return results.map(r => r.project_path);
  }

  /**
   * Increment message count for a session.
   */
  incrementMessageCount(id: string, amount: number = 1): void {
    this.db
      .prepare("UPDATE sessions SET message_count = message_count + ?, updated_at = datetime('now') WHERE id = ?")
      .run(amount, id);
  }

  /**
   * Update ended_at timestamp.
   */
  updateEndedAt(id: string, endedAt: string): void {
    this.db
      .prepare("UPDATE sessions SET ended_at = ?, updated_at = datetime('now') WHERE id = ?")
      .run(endedAt, id);
  }
}
