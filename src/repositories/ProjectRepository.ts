/**
 * Project Repository
 *
 * Data access layer for projects.
 */

import { DatabaseConnection } from '../database/index.js';
import type { Project, ProjectWithSessions, Session } from '../types/models.js';

export interface CreateProjectInput {
  path: string;
  name: string;
  description?: string;
  last_activity_at?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
}

export interface ProjectFilter {
  name_contains?: string;
  has_activity_since?: string;
}

export class ProjectRepository {
  constructor(private db: DatabaseConnection) {}

  /**
   * Create a new project.
   */
  create(input: CreateProjectInput): Project {
    const stmt = this.db.prepare(`
      INSERT INTO projects (path, name, description, last_activity_at)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.path,
      input.name,
      input.description ?? null,
      input.last_activity_at ?? null
    );

    return this.findById(result.lastInsertRowid as number)!;
  }

  /**
   * Find a project by ID.
   */
  findById(id: number): Project | null {
    const stmt = this.db.prepare(`SELECT * FROM projects WHERE id = ?`);
    const row = stmt.get(id) as Project | undefined;
    return row ?? null;
  }

  /**
   * Find a project by path.
   */
  findByPath(path: string): Project | null {
    const stmt = this.db.prepare(`SELECT * FROM projects WHERE path = ?`);
    const row = stmt.get(path) as Project | undefined;
    return row ?? null;
  }

  /**
   * Get or create a project by path.
   * Extracts name from the last segment of the path.
   */
  getOrCreate(path: string): Project {
    const existing = this.findByPath(path);
    if (existing) {
      return existing;
    }

    // Extract name from path (last segment)
    const segments = path.split('/').filter(s => s.length > 0);
    const name = segments[segments.length - 1] || 'Unknown';

    return this.create({ path, name });
  }

  /**
   * Find all projects with optional filtering.
   */
  findAll(filter?: ProjectFilter, limit = 100, offset = 0): Project[] {
    let query = `SELECT * FROM projects WHERE 1=1`;
    const params: (string | number)[] = [];

    if (filter?.name_contains) {
      query += ` AND name LIKE ?`;
      params.push(`%${filter.name_contains}%`);
    }

    if (filter?.has_activity_since) {
      query += ` AND last_activity_at >= ?`;
      params.push(filter.has_activity_since);
    }

    query += ` ORDER BY last_activity_at DESC NULLS LAST, name ASC`;
    query += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Project[];
  }

  /**
   * Update a project.
   */
  update(id: number, input: UpdateProjectInput): Project | null {
    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.name !== undefined) {
      updates.push('name = ?');
      params.push(input.name);
    }

    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push('updated_at = datetime("now")');
    params.push(id);

    const stmt = this.db.prepare(`
      UPDATE projects SET ${updates.join(', ')} WHERE id = ?
    `);
    stmt.run(...params);

    return this.findById(id);
  }

  /**
   * Delete a project.
   * Sessions will have their project_id set to NULL.
   */
  delete(id: number): boolean {
    const stmt = this.db.prepare(`DELETE FROM projects WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get project with recent sessions.
   */
  findWithSessions(id: number, sessionLimit = 10): ProjectWithSessions | null {
    const project = this.findById(id);
    if (!project) {
      return null;
    }

    const sessionsStmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE project_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `);
    const recent_sessions = sessionsStmt.all(id, sessionLimit) as Session[];

    return {
      ...project,
      recent_sessions,
    };
  }

  /**
   * Get project statistics.
   */
  getStats(id: number): {
    session_count: number;
    message_count: number;
    earliest_session: string | null;
    latest_session: string | null;
    messages_by_role: Record<string, number>;
  } | null {
    const project = this.findById(id);
    if (!project) {
      return null;
    }

    // Get message breakdown by role
    const roleStmt = this.db.prepare(`
      SELECT m.role, COUNT(*) as count
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.project_id = ?
      GROUP BY m.role
    `);
    const roleRows = roleStmt.all(id) as Array<{ role: string; count: number }>;

    const messages_by_role: Record<string, number> = {};
    for (const row of roleRows) {
      messages_by_role[row.role] = row.count;
    }

    // Get date range
    const dateStmt = this.db.prepare(`
      SELECT MIN(started_at) as earliest, MAX(started_at) as latest
      FROM sessions
      WHERE project_id = ?
    `);
    const dateRow = dateStmt.get(id) as { earliest: string | null; latest: string | null };

    return {
      session_count: project.session_count,
      message_count: project.message_count,
      earliest_session: dateRow.earliest,
      latest_session: dateRow.latest,
      messages_by_role,
    };
  }

  /**
   * Count total projects.
   */
  count(filter?: ProjectFilter): number {
    let query = `SELECT COUNT(*) as count FROM projects WHERE 1=1`;
    const params: string[] = [];

    if (filter?.name_contains) {
      query += ` AND name LIKE ?`;
      params.push(`%${filter.name_contains}%`);
    }

    if (filter?.has_activity_since) {
      query += ` AND last_activity_at >= ?`;
      params.push(filter.has_activity_since);
    }

    const stmt = this.db.prepare(query);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  /**
   * Update project activity timestamp.
   * Called when a session is added/updated.
   */
  updateActivity(id: number, timestamp: string): void {
    const stmt = this.db.prepare(`
      UPDATE projects
      SET last_activity_at = CASE
            WHEN last_activity_at IS NULL OR ? > last_activity_at
            THEN ?
            ELSE last_activity_at
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(timestamp, timestamp, id);
  }

  /**
   * Recalculate denormalized counts for a project.
   * Use after bulk operations.
   */
  recalculateCounts(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE projects
      SET
        session_count = (SELECT COUNT(*) FROM sessions WHERE project_id = ?),
        message_count = (SELECT COALESCE(SUM(message_count), 0) FROM sessions WHERE project_id = ?),
        updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(id, id, id);
  }

  /**
   * Recalculate counts for all projects.
   */
  recalculateAllCounts(): void {
    const stmt = this.db.prepare(`
      UPDATE projects
      SET
        session_count = (SELECT COUNT(*) FROM sessions WHERE project_id = projects.id),
        message_count = (SELECT COALESCE(SUM(message_count), 0) FROM sessions WHERE project_id = projects.id),
        updated_at = datetime('now')
    `);
    stmt.run();
  }
}
