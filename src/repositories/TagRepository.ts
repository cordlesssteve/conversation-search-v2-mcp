/**
 * Tag Repository
 *
 * Data access layer for conversation tags.
 */

import { DatabaseConnection } from '../database/index.js';
import type { Tag } from '../types/models.js';

export interface CreateTagInput {
  name: string;
  color?: string;
  description?: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
  description?: string;
}

export class TagRepository {
  constructor(private db: DatabaseConnection) {}

  /**
   * Create a new tag.
   */
  create(input: CreateTagInput): Tag {
    const normalizedName = this.normalizeName(input.name);

    const stmt = this.db.prepare(`
      INSERT INTO tags (name, color, description)
      VALUES (?, ?, ?)
    `);

    const result = stmt.run(
      normalizedName,
      input.color ?? null,
      input.description ?? null
    );

    return this.findById(result.lastInsertRowid as number)!;
  }

  /**
   * Find a tag by ID.
   */
  findById(id: number): Tag | null {
    const result = this.db
      .prepare('SELECT * FROM tags WHERE id = ?')
      .get(id) as Tag | undefined;

    return result ?? null;
  }

  /**
   * Find a tag by name.
   */
  findByName(name: string): Tag | null {
    const normalizedName = this.normalizeName(name);

    const result = this.db
      .prepare('SELECT * FROM tags WHERE name = ?')
      .get(normalizedName) as Tag | undefined;

    return result ?? null;
  }

  /**
   * Find or create a tag by name.
   */
  findOrCreate(name: string, defaults?: Omit<CreateTagInput, 'name'>): Tag {
    const existing = this.findByName(name);
    if (existing) {
      return existing;
    }

    return this.create({
      name,
      ...defaults,
    });
  }

  /**
   * Update a tag.
   */
  update(id: number, input: UpdateTagInput): Tag | null {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push('name = ?');
      values.push(this.normalizeName(input.name));
    }

    if (input.color !== undefined) {
      fields.push('color = ?');
      values.push(input.color);
    }

    if (input.description !== undefined) {
      fields.push('description = ?');
      values.push(input.description);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);

    this.db
      .prepare(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.findById(id);
  }

  /**
   * Delete a tag.
   */
  delete(id: number): boolean {
    const result = this.db
      .prepare('DELETE FROM tags WHERE id = ?')
      .run(id);

    return result.changes > 0;
  }

  /**
   * Get all tags.
   */
  findAll(): Tag[] {
    return this.db
      .prepare('SELECT * FROM tags ORDER BY name')
      .all() as Tag[];
  }

  /**
   * Get all tags with usage counts.
   */
  findAllWithCounts(): Array<Tag & { session_count: number }> {
    return this.db
      .prepare(`
        SELECT t.*, COUNT(st.session_id) as session_count
        FROM tags t
        LEFT JOIN session_tags st ON t.id = st.tag_id
        GROUP BY t.id
        ORDER BY session_count DESC, t.name
      `)
      .all() as Array<Tag & { session_count: number }>;
  }

  /**
   * Add a tag to a session.
   */
  addToSession(sessionId: string, tagId: number): boolean {
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)')
        .run(sessionId, tagId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Add a tag to a session by name (creates tag if needed).
   */
  addToSessionByName(sessionId: string, tagName: string): Tag {
    const tag = this.findOrCreate(tagName);
    this.addToSession(sessionId, tag.id);
    return tag;
  }

  /**
   * Remove a tag from a session.
   */
  removeFromSession(sessionId: string, tagId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?')
      .run(sessionId, tagId);

    return result.changes > 0;
  }

  /**
   * Remove a tag from a session by name.
   */
  removeFromSessionByName(sessionId: string, tagName: string): boolean {
    const tag = this.findByName(tagName);
    if (!tag) return false;

    return this.removeFromSession(sessionId, tag.id);
  }

  /**
   * Get all tags for a session.
   */
  findBySession(sessionId: string): Tag[] {
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
   * Get all session IDs with a specific tag.
   */
  getSessionIds(tagId: number): string[] {
    const results = this.db
      .prepare('SELECT session_id FROM session_tags WHERE tag_id = ?')
      .all(tagId) as Array<{ session_id: string }>;

    return results.map(r => r.session_id);
  }

  /**
   * Check if a session has a specific tag.
   */
  sessionHasTag(sessionId: string, tagId: number): boolean {
    const result = this.db
      .prepare('SELECT 1 FROM session_tags WHERE session_id = ? AND tag_id = ?')
      .get(sessionId, tagId);

    return result !== undefined;
  }

  /**
   * Set all tags for a session (replaces existing).
   */
  setSessionTags(sessionId: string, tagIds: number[]): void {
    this.db.transaction(() => {
      // Remove all existing tags
      this.db
        .prepare('DELETE FROM session_tags WHERE session_id = ?')
        .run(sessionId);

      // Add new tags
      const stmt = this.db.prepare(
        'INSERT INTO session_tags (session_id, tag_id) VALUES (?, ?)'
      );

      for (const tagId of tagIds) {
        stmt.run(sessionId, tagId);
      }
    });
  }

  /**
   * Count sessions with a specific tag.
   */
  countSessions(tagId: number): number {
    const result = this.db
      .prepare('SELECT COUNT(*) as count FROM session_tags WHERE tag_id = ?')
      .get(tagId) as { count: number };

    return result.count;
  }

  /**
   * Count total tags.
   */
  count(): number {
    const result = this.db
      .prepare('SELECT COUNT(*) as count FROM tags')
      .get() as { count: number };

    return result.count;
  }

  /**
   * Normalize tag name (lowercase, trimmed).
   */
  private normalizeName(name: string): string {
    return name.toLowerCase().trim();
  }
}
