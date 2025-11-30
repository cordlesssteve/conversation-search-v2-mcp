/**
 * Database module exports
 */

export { DatabaseConnection, getDatabase, closeDatabase } from './connection.js';
export type { DatabaseConfig } from './connection.js';

export { MigrationRunner, runMigrations, loadMigrations } from './migrations/runner.js';
export type { Migration, AppliedMigration, MigrationResult } from './migrations/runner.js';
