#!/usr/bin/env node
/**
 * V1 to V2 Migration Script
 *
 * Migrates historical conversation data from V1 database to V2.
 * V1 source files may no longer exist, so this reads directly from the V1 database.
 *
 * Usage: npm run migrate:v1 [-- --dry-run] [-- --verbose]
 */

import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { getDatabase, closeDatabase, MigrationRunner } from '../database/index.js';
import { ProjectRepository } from '../repositories/index.js';

// V1 database path
const V1_DB_PATH = process.env.V1_DB_PATH || path.join(os.homedir(), 'data/conversation-search/conversations.db');

interface CliOptions {
  dryRun: boolean;
  verbose: boolean;
  limit?: number;
}

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

interface SessionInfo {
  session_id: string;
  file_path: string;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
  message_count: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--limit' && args[i + 1]) {
      options.limit = parseInt(args[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
V1 to V2 Migration Script

Migrates historical conversation data from the V1 database to V2.
This is needed because the original JSONL source files may have been deleted.

Usage:
  npm run migrate:v1 [options]

Options:
  --dry-run          Show what would be migrated without making changes
  --verbose, -v      Show detailed progress
  --limit <n>        Only migrate first n sessions (for testing)
  --help, -h         Show this help message

Environment:
  V1_DB_PATH         Path to V1 database (default: ~/data/conversation-search/conversations.db)
`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Extract project path from file_path or cwd
 * File path format: /home/user/.claude/projects/-home-user-projects-Foo/session.jsonl
 * We need to convert -home-user-projects-Foo back to /home/user/projects/Foo
 */
function extractProjectPath(filePath: string, cwd: string | null): string | null {
  // Prefer cwd if available
  if (cwd && cwd !== '/' && cwd.length > 1) {
    return cwd;
  }

  // Try to extract from file path
  const match = filePath.match(/\.claude\/projects\/([^/]+)\//);
  if (match) {
    const encoded = match[1];
    // Convert -home-user-projects-Foo to /home/user/projects/Foo
    const decoded = '/' + encoded.replace(/-/g, '/').replace(/\/\//g, '-');
    return decoded;
  }

  return null;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const startTime = Date.now();

  console.log('V1 to V2 Migration Tool');
  console.log('=======================\n');

  if (options.dryRun) {
    console.log('*** DRY RUN MODE - No changes will be made ***\n');
  }

  // Open V1 database (read-only)
  console.log(`V1 Database: ${V1_DB_PATH}`);
  let v1Db: Database.Database;
  try {
    v1Db = new Database(V1_DB_PATH, { readonly: true });
  } catch (error) {
    console.error(`ERROR: Cannot open V1 database: ${(error as Error).message}`);
    process.exit(1);
  }

  // Open V2 database
  const v2Db = getDatabase();
  console.log(`V2 Database: ${v2Db.getPath()}\n`);

  try {
    // Ensure V2 migrations are applied
    const migrationRunner = new MigrationRunner(v2Db);
    const migrationStatus = migrationRunner.getStatus();
    if (migrationStatus.pending_count > 0) {
      console.log('Applying pending V2 migrations...');
      migrationRunner.migrate();
      console.log('Migrations applied.\n');
    }

    // Create V2 project repository for getOrCreate
    const projectRepo = new ProjectRepository(v2Db);

    // Get V1 statistics
    const v1Stats = v1Db.prepare(`
      SELECT
        COUNT(DISTINCT session_id) as sessions,
        COUNT(*) as messages,
        MIN(timestamp) as earliest,
        MAX(timestamp) as latest
      FROM conversations
    `).get() as { sessions: number; messages: number; earliest: string; latest: string };

    console.log('V1 Database Statistics:');
    console.log(`  Sessions: ${formatNumber(v1Stats.sessions)}`);
    console.log(`  Messages: ${formatNumber(v1Stats.messages)}`);
    console.log(`  Date range: ${v1Stats.earliest?.split('T')[0] || 'N/A'} to ${v1Stats.latest?.split('T')[0] || 'N/A'}`);
    console.log('');

    // Get V2 current statistics
    const v2SessionCount = v2Db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const v2MessageCount = v2Db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };

    console.log('V2 Database Statistics (before migration):');
    console.log(`  Sessions: ${formatNumber(v2SessionCount.count)}`);
    console.log(`  Messages: ${formatNumber(v2MessageCount.count)}`);
    console.log('');

    // Find sessions in V1 that don't exist in V2
    const existingSessionIds = new Set<string>();
    const existingRows = v2Db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    for (const row of existingRows) {
      existingSessionIds.add(row.id);
    }

    // Get all unique sessions from V1 with their info
    const v1Sessions = v1Db.prepare(`
      SELECT
        session_id,
        file_path,
        cwd,
        MIN(timestamp) as started_at,
        MAX(timestamp) as ended_at,
        COUNT(*) as message_count
      FROM conversations
      WHERE session_id IS NOT NULL AND session_id != ''
      GROUP BY session_id
      ORDER BY started_at
    `).all() as SessionInfo[];

    // Filter to sessions not in V2
    let sessionsToMigrate = v1Sessions.filter(s => !existingSessionIds.has(s.session_id));

    if (options.limit) {
      sessionsToMigrate = sessionsToMigrate.slice(0, options.limit);
    }

    console.log(`Sessions to migrate: ${formatNumber(sessionsToMigrate.length)}`);
    console.log(`Sessions already in V2: ${formatNumber(v1Sessions.length - sessionsToMigrate.length)}`);
    console.log('');

    if (sessionsToMigrate.length === 0) {
      console.log('No sessions to migrate. V2 is up to date with V1.');
      return;
    }

    if (options.dryRun) {
      // Show sample of what would be migrated
      console.log('Sample sessions that would be migrated:');
      for (const session of sessionsToMigrate.slice(0, 5)) {
        console.log(`  ${session.session_id.slice(0, 8)}... - ${session.message_count} messages - ${session.started_at?.split('T')[0] || 'unknown'}`);
      }
      if (sessionsToMigrate.length > 5) {
        console.log(`  ... and ${sessionsToMigrate.length - 5} more`);
      }
      console.log('\nRun without --dry-run to perform migration.');
      return;
    }

    // Prepare V1 query for messages
    const getV1Messages = v1Db.prepare(`
      SELECT * FROM conversations
      WHERE session_id = ?
      ORDER BY timestamp
    `);

    // Migration counters
    let migratedSessions = 0;
    let migratedMessages = 0;
    let errors = 0;
    const projectCache = new Map<string, number>();

    console.log('Migrating...\n');

    // Process each session
    for (let i = 0; i < sessionsToMigrate.length; i++) {
      const session = sessionsToMigrate[i];
      const percent = Math.round(((i + 1) / sessionsToMigrate.length) * 100);

      if (options.verbose) {
        console.log(`[${i + 1}/${sessionsToMigrate.length}] ${session.session_id} (${session.message_count} messages)`);
      } else {
        process.stdout.write(`\rProgress: ${i + 1}/${sessionsToMigrate.length} (${percent}%)`);
      }

      try {
        // Extract project path
        const projectPath = extractProjectPath(session.file_path, session.cwd);

        // Get or create project
        let projectId: number | undefined;
        if (projectPath) {
          if (projectCache.has(projectPath)) {
            projectId = projectCache.get(projectPath);
          } else {
            const project = projectRepo.getOrCreate(projectPath);
            projectId = project.id;
            projectCache.set(projectPath, project.id);
          }
        }

        // Create session in V2
        // Note: We disable the trigger temporarily by inserting with message_count=0
        // then updating after messages are inserted
        const insertSession = v2Db.prepare(`
          INSERT INTO sessions (
            id, file_path, project_path, project_id, cwd,
            started_at, ended_at, message_count,
            title, is_title_auto_generated, is_stub
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, FALSE, FALSE)
        `);

        insertSession.run(
          session.session_id,
          session.file_path,
          projectPath,
          projectId ?? null,
          session.cwd,
          session.started_at,
          session.ended_at
        );

        // Get messages from V1
        const v1Messages = getV1Messages.all(session.session_id) as V1Message[];

        // Insert messages into V2 using transaction for bulk insert
        const insertMessage = v2Db.prepare(`
          INSERT INTO messages (
            uuid, session_id, role, content, timestamp,
            model, parent_uuid, message_type, cwd, file_path, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        v2Db.transaction(() => {
          for (const msg of v1Messages) {
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
              msg.content_hash
            );
          }
        });
        migratedMessages += v1Messages.length;

        // Update session message count (this will trigger project stats update)
        v2Db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?')
          .run(v1Messages.length, session.session_id);

        migratedSessions++;

      } catch (error) {
        errors++;
        if (options.verbose) {
          console.error(`  ERROR: ${(error as Error).message}`);
        }
      }
    }

    // Clear progress line
    if (!options.verbose) {
      process.stdout.write('\r' + ' '.repeat(50) + '\r');
    }

    const duration = Date.now() - startTime;

    console.log('\n--- Migration Summary ---');
    console.log(`Sessions migrated: ${formatNumber(migratedSessions)}`);
    console.log(`Messages migrated: ${formatNumber(migratedMessages)}`);
    console.log(`Errors: ${formatNumber(errors)}`);
    console.log(`Duration: ${formatDuration(duration)}`);

    // Show final V2 stats
    const finalSessionCount = v2Db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const finalMessageCount = v2Db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };

    console.log('\nV2 Database Statistics (after migration):');
    console.log(`  Sessions: ${formatNumber(finalSessionCount.count)}`);
    console.log(`  Messages: ${formatNumber(finalMessageCount.count)}`);

    // Rebuild FTS index
    console.log('\nRebuilding FTS index...');
    v2Db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    console.log('FTS index rebuilt.');

    // Recalculate project counts
    console.log('Recalculating project statistics...');
    projectRepo.recalculateAllCounts();
    console.log('Project statistics updated.');

    console.log('\nMigration complete!');

  } finally {
    v1Db.close();
    closeDatabase();
  }
}

main().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});
