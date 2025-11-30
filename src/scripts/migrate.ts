#!/usr/bin/env node
/**
 * Migration script
 *
 * Run database migrations from the command line.
 * Usage: npm run migrate
 */

import { getDatabase, closeDatabase, MigrationRunner } from '../database/index.js';

async function main(): Promise<void> {
  console.log('Conversation Search v2 - Migration Runner');
  console.log('=========================================\n');

  const db = getDatabase();

  try {
    const runner = new MigrationRunner(db);

    // Show current status
    const status = runner.getStatus();
    console.log(`Current schema version: ${status.current_version}`);
    console.log(`Applied migrations: ${status.applied_count}`);
    console.log(`Pending migrations: ${status.pending_count}`);

    if (status.pending_count === 0) {
      console.log('\n✓ Database is up to date. No migrations to apply.');
      return;
    }

    console.log('\nPending migrations:');
    for (const m of status.pending_migrations) {
      console.log(`  - ${m.version}: ${m.name}`);
    }

    console.log('\nApplying migrations...\n');

    // Run migrations
    const result = runner.migrate();

    // Report results
    console.log('\n--- Migration Summary ---');
    console.log(`Applied: ${result.applied.length}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.error('\nErrors:');
      for (const err of result.errors) {
        console.error(`  Migration ${err.version}: ${err.error}`);
      }
      process.exit(1);
    }

    // Show final status
    const finalStatus = runner.getStatus();
    console.log(`\nFinal schema version: ${finalStatus.current_version}`);

    // Show database stats
    const stats = db.getStats();
    console.log(`\nDatabase: ${stats.path}`);
    console.log(`Size: ${(stats.size_bytes / 1024).toFixed(2)} KB`);
    console.log(`WAL mode: ${stats.wal_mode ? 'enabled' : 'disabled'}`);

  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
