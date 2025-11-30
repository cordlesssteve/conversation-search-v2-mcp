#!/usr/bin/env node
/**
 * Migrate September 2025 Data from v1 to v2
 *
 * Recovers missing September 2025 conversation data from the old v1 database.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as crypto from 'crypto';

const V1_DB_PATH = process.env.V1_DB_PATH || path.join(process.env.HOME || '', 'data/conversation-search/conversations.db');
const V2_DB_PATH = process.env.V2_DB_PATH || path.join(process.env.HOME || '', 'projects/Utility/DEV-TOOLS/mcp-workspace/servers/your-servers/conversation-search-v2/data/conversations.db');

interface V1Message {
  id: number;
  session_id: string;
  uuid: string;
  timestamp: string;
  role: string;
  content: string;
  file_path: string;
  message_type: string;
  model: string | null;
  parent_uuid: string | null;
  cwd: string | null;
  content_hash: string | null;
}

function main(): void {
  console.log('September 2025 Data Migration: v1 → v2');
  console.log('=======================================\n');

  // Open databases
  console.log('Opening databases...');
  const v1Db = new Database(V1_DB_PATH, { readonly: true });
  const v2Db = new Database(V2_DB_PATH);

  try {
    // Check v1 September data
    const v1SeptCount = v1Db.prepare(`
      SELECT COUNT(*) as count FROM conversations
      WHERE timestamp LIKE '2025-09-%'
    `).get() as { count: number };
    console.log(`  v1 September records: ${v1SeptCount.count.toLocaleString()}`);

    // Check v2 September data
    const v2SeptCount = v2Db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE timestamp LIKE '2025-09-%'
    `).get() as { count: number };
    console.log(`  v2 September records: ${v2SeptCount.count.toLocaleString()}`);

    if (v2SeptCount.count > 0) {
      console.log('\n⚠️  v2 already has September data. Skipping to avoid duplicates.');
      return;
    }

    // Get September sessions from v1
    const v1Sessions = v1Db.prepare(`
      SELECT DISTINCT session_id,
             MIN(timestamp) as started_at,
             MAX(timestamp) as ended_at,
             COUNT(*) as message_count,
             MAX(file_path) as file_path,
             MAX(cwd) as cwd
      FROM conversations
      WHERE timestamp LIKE '2025-09-%'
      GROUP BY session_id
    `).all() as Array<{
      session_id: string;
      started_at: string;
      ended_at: string;
      message_count: number;
      file_path: string;
      cwd: string | null;
    }>;

    console.log(`\nFound ${v1Sessions.length} September sessions to migrate`);

    // Prepare v2 insert statements
    const insertSession = v2Db.prepare(`
      INSERT OR IGNORE INTO sessions (
        id, file_path, project_path, cwd, started_at, ended_at, message_count,
        title, is_title_auto_generated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, datetime('now'), datetime('now'))
    `);

    const insertMessage = v2Db.prepare(`
      INSERT OR IGNORE INTO messages (
        uuid, session_id, role, content, timestamp, model, parent_uuid,
        message_type, cwd, file_path, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const checkSessionExists = v2Db.prepare(`SELECT id FROM sessions WHERE id = ?`);

    // Get all September messages
    const v1Messages = v1Db.prepare(`
      SELECT * FROM conversations
      WHERE timestamp LIKE '2025-09-%'
      ORDER BY session_id, timestamp
    `).all() as V1Message[];

    console.log(`Total messages to migrate: ${v1Messages.length.toLocaleString()}`);

    // Begin transaction
    const transaction = v2Db.transaction(() => {
      let sessionsCreated = 0;
      let messagesInserted = 0;
      let messagesSkipped = 0;

      // First, create sessions
      for (const session of v1Sessions) {
        const existing = checkSessionExists.get(session.session_id);
        if (!existing) {
          // Extract project path from file_path
          const projectPath = extractProjectPath(session.file_path);
          const title = generateTitle(session.file_path);

          insertSession.run(
            session.session_id,
            session.file_path,
            projectPath,
            session.cwd,
            session.started_at,
            session.ended_at,
            session.message_count,
            title
          );
          sessionsCreated++;
        }
      }

      console.log(`  Sessions created: ${sessionsCreated}`);

      // Then, insert messages
      for (const msg of v1Messages) {
        try {
          const contentHash = msg.content_hash ||
            crypto.createHash('md5').update(msg.content).digest('hex');

          insertMessage.run(
            msg.uuid,
            msg.session_id,
            msg.role,
            msg.content,
            msg.timestamp,
            msg.model,
            msg.parent_uuid,
            msg.message_type,
            msg.cwd,
            msg.file_path,
            contentHash
          );
          messagesInserted++;
        } catch (error) {
          // Likely duplicate UUID, skip
          messagesSkipped++;
        }

        if ((messagesInserted + messagesSkipped) % 10000 === 0) {
          console.log(`  Progress: ${(messagesInserted + messagesSkipped).toLocaleString()} / ${v1Messages.length.toLocaleString()}`);
        }
      }

      return { sessionsCreated, messagesInserted, messagesSkipped };
    });

    console.log('\nMigrating data...');
    const result = transaction();

    console.log('\n--- Migration Complete ---');
    console.log(`Sessions created: ${result.sessionsCreated}`);
    console.log(`Messages inserted: ${result.messagesInserted.toLocaleString()}`);
    console.log(`Messages skipped (duplicates): ${result.messagesSkipped.toLocaleString()}`);

    // Verify
    const finalCount = v2Db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE timestamp LIKE '2025-09-%'
    `).get() as { count: number };
    console.log(`\nv2 September records after migration: ${finalCount.count.toLocaleString()}`);

  } finally {
    v1Db.close();
    v2Db.close();
  }
}

function extractProjectPath(filePath: string): string | null {
  // Extract project path from file path like:
  // /home/user/.claude/projects/path-to-project/session.jsonl
  const match = filePath.match(/\.claude\/projects\/([^/]+)/);
  if (match) {
    return match[1].replace(/-/g, '/');
  }
  return null;
}

function generateTitle(filePath: string): string {
  // Generate a title from the file path
  const match = filePath.match(/\.claude\/projects\/([^/]+)/);
  if (match) {
    // Convert path-style to readable: home-user-projects-foo -> foo
    const parts = match[1].split('-');
    return parts.slice(-2).join('/') || 'Unnamed Session';
  }
  return 'Migrated Session (Sept 2025)';
}

main();
