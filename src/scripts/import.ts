#!/usr/bin/env node
/**
 * Import script
 *
 * Import conversation history from JSONL files into the database.
 * Usage: npm run import [-- --source <path>] [-- --skip-existing] [-- --verbose]
 */

import * as path from 'path';
import * as os from 'os';
import { getDatabase, closeDatabase, MigrationRunner } from '../database/index.js';
import { SessionRepository, MessageRepository, ProjectRepository } from '../repositories/index.js';
import { ImportService } from '../services/index.js';

// Default source directories
const DEFAULT_SOURCE_DIRS = [
  path.join(os.homedir(), '.claude/projects'),
  path.join(os.homedir(), 'backups/conversation-search-old/claude-conversations'),
];

interface CliOptions {
  sourceDirs: string[];
  skipExisting: boolean;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    sourceDirs: [...DEFAULT_SOURCE_DIRS],
    skipExisting: true,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--source' && args[i + 1]) {
      options.sourceDirs = [args[++i]];
    } else if (arg === '--add-source' && args[i + 1]) {
      options.sourceDirs.push(args[++i]);
    } else if (arg === '--no-skip-existing') {
      options.skipExisting = false;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Conversation Search v2 - Import Tool

Usage:
  npm run import [options]

Options:
  --source <path>       Replace default source directories with specified path
  --add-source <path>   Add an additional source directory
  --no-skip-existing    Re-import sessions that already exist
  --verbose, -v         Show detailed progress
  --help, -h            Show this help message

Default source directories:
  - ~/.claude/projects
  - ~/backups/conversation-search-old/claude-conversations

Examples:
  npm run import                        # Import from default directories
  npm run import -- --verbose           # Import with detailed progress
  npm run import -- --source ~/custom   # Import from custom directory only
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

async function main(): Promise<void> {
  const options = parseArgs();

  console.log('Conversation Search v2 - Import Tool');
  console.log('====================================\n');

  const db = getDatabase();

  try {
    // Ensure migrations are applied
    const migrationRunner = new MigrationRunner(db);
    const migrationStatus = migrationRunner.getStatus();

    if (migrationStatus.pending_count > 0) {
      console.log('Applying pending migrations...');
      migrationRunner.migrate();
      console.log('Migrations applied.\n');
    }

    // Create repositories and import service
    const sessionRepo = new SessionRepository(db);
    const messageRepo = new MessageRepository(db);
    const projectRepo = new ProjectRepository(db);
    const importService = new ImportService(sessionRepo, messageRepo, projectRepo);

    // Show current stats
    const beforeStats = importService.getStats();
    console.log('Current database state:');
    console.log(`  Sessions: ${formatNumber(beforeStats.sessions)}`);
    console.log(`  Messages: ${formatNumber(beforeStats.messages)}`);
    console.log('');

    // Show source directories
    console.log('Source directories:');
    for (const dir of options.sourceDirs) {
      console.log(`  - ${dir}`);
    }
    console.log('');

    // Run import
    console.log('Importing conversations...\n');

    let lastProgressLine = '';
    const result = await importService.importAll({
      sourceDirs: options.sourceDirs,
      skipExisting: options.skipExisting,
      onProgress: (current, total, sessionId) => {
        if (options.verbose) {
          console.log(`  [${current}/${total}] ${sessionId}`);
        } else {
          // Overwrite progress line
          const percent = Math.round((current / total) * 100);
          const progressLine = `  Progress: ${current}/${total} (${percent}%)`;
          if (progressLine !== lastProgressLine) {
            process.stdout.write(`\r${progressLine}`);
            lastProgressLine = progressLine;
          }
        }
      },
      onError: (file, error) => {
        if (options.verbose) {
          console.error(`  ERROR: ${file} - ${error.message}`);
        }
      },
    });

    // Clear progress line
    if (!options.verbose && result.totalFiles > 0) {
      process.stdout.write('\r' + ' '.repeat(50) + '\r');
    }

    // Print results
    console.log('\n--- Import Summary ---');
    console.log(`Total files found: ${formatNumber(result.totalFiles)}`);
    console.log(`Successfully imported: ${formatNumber(result.imported)}`);
    console.log(`Skipped (already exists): ${formatNumber(result.skipped)}`);
    console.log(`Failed: ${formatNumber(result.failed)}`);
    console.log(`Total messages imported: ${formatNumber(result.totalMessages)}`);
    console.log(`Duration: ${formatDuration(result.duration)}`);

    if (result.errors.length > 0 && options.verbose) {
      console.log('\nErrors:');
      for (const err of result.errors.slice(0, 10)) {
        console.log(`  ${path.basename(err.file)}: ${err.error}`);
      }
      if (result.errors.length > 10) {
        console.log(`  ... and ${result.errors.length - 10} more errors`);
      }
    }

    // Show final stats
    const afterStats = importService.getStats();
    console.log('\nFinal database state:');
    console.log(`  Sessions: ${formatNumber(afterStats.sessions)} (+${formatNumber(afterStats.sessions - beforeStats.sessions)})`);
    console.log(`  Messages: ${formatNumber(afterStats.messages)} (+${formatNumber(afterStats.messages - beforeStats.messages)})`);

    // Show database info
    const dbStats = db.getStats();
    console.log(`\nDatabase: ${dbStats.path}`);
    console.log(`Size: ${(dbStats.size_bytes / 1024 / 1024).toFixed(2)} MB`);

  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Import failed:', error);
  process.exit(1);
});
