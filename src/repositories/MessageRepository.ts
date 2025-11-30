/**
 * Message Repository
 *
 * Data access layer for conversation messages.
 */

import { DatabaseConnection } from '../database/index.js';
import type { Message, SearchResult } from '../types/models.js';
import crypto from 'crypto';

export interface CreateMessageInput {
  uuid: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  model?: string;
  parent_uuid?: string;
  message_type?: string;
  cwd?: string;
  file_path?: string;
  token_count?: number;
}

export interface MessageFilter {
  session_id?: string;
  role?: string;
  date_from?: string;
  date_to?: string;
}

export class MessageRepository {
  constructor(private db: DatabaseConnection) {}

  /**
   * Create a new message.
   */
  create(input: CreateMessageInput): Message {
    const contentHash = this.calculateHash(input.session_id, input.uuid, input.content);

    const stmt = this.db.prepare(`
      INSERT INTO messages (
        uuid, session_id, role, content, timestamp, model,
        parent_uuid, message_type, cwd, file_path, content_hash, token_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.uuid,
      input.session_id,
      input.role,
      input.content,
      input.timestamp,
      input.model ?? null,
      input.parent_uuid ?? null,
      input.message_type ?? null,
      input.cwd ?? null,
      input.file_path ?? null,
      contentHash,
      input.token_count ?? null
    );

    return this.findById(result.lastInsertRowid as number)!;
  }

  /**
   * Create multiple messages in a transaction.
   */
  createMany(inputs: CreateMessageInput[]): number {
    let created = 0;

    this.db.transaction(() => {
      for (const input of inputs) {
        try {
          this.create(input);
          created++;
        } catch (error) {
          // Skip duplicates (UNIQUE constraint on uuid)
          if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
            continue;
          }
          throw error;
        }
      }
    });

    return created;
  }

  /**
   * Find a message by ID.
   */
  findById(id: number): Message | null {
    const result = this.db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(id) as Message | undefined;

    return result ?? null;
  }

  /**
   * Find a message by UUID.
   */
  findByUuid(uuid: string): Message | null {
    const result = this.db
      .prepare('SELECT * FROM messages WHERE uuid = ?')
      .get(uuid) as Message | undefined;

    return result ?? null;
  }

  /**
   * Check if a message exists by UUID.
   */
  exists(uuid: string): boolean {
    const result = this.db
      .prepare('SELECT 1 FROM messages WHERE uuid = ?')
      .get(uuid);

    return result !== undefined;
  }

  /**
   * Find messages for a session.
   */
  findBySession(sessionId: string, limit?: number): Message[] {
    let sql = 'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC';
    const params: unknown[] = [sessionId];

    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    return this.db.prepare(sql).all(...params) as Message[];
  }

  /**
   * Find messages with filters.
   */
  find(filter: MessageFilter, limit: number = 100, offset: number = 0): Message[] {
    let sql = 'SELECT * FROM messages';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filter.session_id) {
      conditions.push('session_id = ?');
      params.push(filter.session_id);
    }

    if (filter.role) {
      conditions.push('role = ?');
      params.push(filter.role);
    }

    if (filter.date_from) {
      conditions.push('timestamp >= ?');
      params.push(filter.date_from);
    }

    if (filter.date_to) {
      conditions.push('timestamp <= ?');
      params.push(filter.date_to);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY timestamp ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as Message[];
  }

  /**
   * Full-text search across message content.
   */
  search(query: string, limit: number = 20, filter?: MessageFilter): SearchResult[] {
    // Escape FTS5 special characters
    const escapedQuery = this.escapeFtsQuery(query);

    let sql = `
      SELECT m.*, s.*,
             snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) as snippet,
             bm25(messages_fts) as rank
      FROM messages_fts
      INNER JOIN messages m ON messages_fts.rowid = m.id
      INNER JOIN sessions s ON m.session_id = s.id
      WHERE messages_fts MATCH ?
    `;
    const params: unknown[] = [escapedQuery];

    if (filter?.session_id) {
      sql += ' AND m.session_id = ?';
      params.push(filter.session_id);
    }

    if (filter?.role) {
      sql += ' AND m.role = ?';
      params.push(filter.role);
    }

    if (filter?.date_from) {
      sql += ' AND m.timestamp >= ?';
      params.push(filter.date_from);
    }

    if (filter?.date_to) {
      sql += ' AND m.timestamp <= ?';
      params.push(filter.date_to);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    const results = this.db.prepare(sql).all(...params) as Array<{
      snippet: string;
      rank: number;
      [key: string]: unknown;
    }>;

    // Group by session and aggregate
    const sessionMap = new Map<string, SearchResult>();

    for (const row of results) {
      const sessionId = row.session_id as string;

      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, {
          session: {
            id: row.id as string,
            file_path: row.file_path as string,
            project_id: row.project_id as number | null,
            project_path: row.project_path as string | null,
            cwd: row.cwd as string | null,
            started_at: row.started_at as string,
            ended_at: row.ended_at as string | null,
            message_count: row.message_count as number,
            title: row.title as string | null,
            summary: row.summary as string | null,
            is_title_auto_generated: Boolean(row.is_title_auto_generated),
            is_stub: Boolean(row.is_stub),
            created_at: row.created_at as string,
            updated_at: row.updated_at as string,
          },
          matching_content: row.snippet,
          match_count: 1,
          relevance_score: -row.rank, // bm25 returns negative scores
        });
      } else {
        const existing = sessionMap.get(sessionId)!;
        existing.match_count++;
      }
    }

    return Array.from(sessionMap.values());
  }

  /**
   * Delete a message by ID.
   */
  delete(id: number): boolean {
    const result = this.db
      .prepare('DELETE FROM messages WHERE id = ?')
      .run(id);

    return result.changes > 0;
  }

  /**
   * Delete all messages for a session.
   */
  deleteBySession(sessionId: string): number {
    const result = this.db
      .prepare('DELETE FROM messages WHERE session_id = ?')
      .run(sessionId);

    return result.changes;
  }

  /**
   * Count messages.
   */
  count(filter?: MessageFilter): number {
    let sql = 'SELECT COUNT(*) as count FROM messages';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filter?.session_id) {
      conditions.push('session_id = ?');
      params.push(filter.session_id);
    }

    if (filter?.role) {
      conditions.push('role = ?');
      params.push(filter.role);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const result = this.db.prepare(sql).get(...params) as { count: number };
    return result.count;
  }

  /**
   * Count messages by role.
   */
  countByRole(): Record<string, number> {
    const results = this.db
      .prepare('SELECT role, COUNT(*) as count FROM messages GROUP BY role')
      .all() as Array<{ role: string; count: number }>;

    return Object.fromEntries(results.map(r => [r.role, r.count]));
  }

  /**
   * Get date range of messages.
   */
  getDateRange(): { earliest: string | null; latest: string | null } {
    const result = this.db
      .prepare('SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM messages')
      .get() as { earliest: string | null; latest: string | null };

    return result;
  }

  /**
   * Calculate content hash for deduplication.
   */
  private calculateHash(sessionId: string, uuid: string, content: string): string {
    return crypto
      .createHash('md5')
      .update(`${sessionId}${uuid}${content}`)
      .digest('hex');
  }

  /**
   * Escape FTS5 special characters.
   */
  private escapeFtsQuery(query: string): string {
    const trimmed = query.trim();

    // If already quoted, return as-is
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed;
    }

    // Escape internal double quotes
    const escaped = trimmed.replace(/"/g, '""');

    // Wrap in quotes for phrase search
    return `"${escaped}"`;
  }
}
