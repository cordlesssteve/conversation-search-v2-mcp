/**
 * Migration Runner
 *
 * Manages database schema migrations with version tracking.
 * Migrations are applied in order and only once.
 */

import { DatabaseConnection } from '../connection.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  applied_at: string;
  checksum: string | null;
}

export interface MigrationResult {
  applied: Migration[];
  skipped: number;
  errors: Array<{ version: number; error: string }>;
}

/**
 * Calculate MD5 checksum of SQL content.
 */
function calculateChecksum(sql: string): string {
  return crypto.createHash('md5').update(sql).digest('hex');
}

/**
 * Load migrations from SQL files in the migrations directory.
 */
export function loadMigrations(migrationsDir?: string): Migration[] {
  const dir = migrationsDir ?? __dirname;
  const migrations: Migration[] = [];

  // Find all .sql files
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    // Extract version number from filename (e.g., "001_initial_schema.sql" -> 1)
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      console.warn(`Skipping migration file with invalid name: ${file}`);
      continue;
    }

    const version = parseInt(match[1], 10);
    const name = match[2];
    const filePath = path.join(dir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');
    const checksum = calculateChecksum(sql);

    migrations.push({ version, name, sql, checksum });
  }

  // Sort by version
  migrations.sort((a, b) => a.version - b.version);

  return migrations;
}

/**
 * Migration runner class.
 */
export class MigrationRunner {
  private db: DatabaseConnection;

  constructor(db: DatabaseConnection) {
    this.db = db;
  }

  /**
   * Ensure the schema_migrations table exists.
   */
  private ensureMigrationsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now')),
        checksum TEXT
      )
    `);
  }

  /**
   * Get the current schema version.
   */
  getCurrentVersion(): number {
    this.ensureMigrationsTable();

    const result = this.db
      .prepare('SELECT MAX(version) as version FROM schema_migrations')
      .get() as { version: number | null } | undefined;

    return result?.version ?? 0;
  }

  /**
   * Get all applied migrations.
   */
  getAppliedMigrations(): AppliedMigration[] {
    this.ensureMigrationsTable();

    return this.db
      .prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version')
      .all() as AppliedMigration[];
  }

  /**
   * Check if a specific migration has been applied.
   */
  isMigrationApplied(version: number): boolean {
    this.ensureMigrationsTable();

    const result = this.db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(version) as { version: number } | undefined;

    return result !== undefined;
  }

  /**
   * Apply a single migration.
   */
  applyMigration(migration: Migration): void {
    console.log(`Applying migration ${migration.version}: ${migration.name}`);

    // Run migration in a transaction
    this.db.transaction(() => {
      // Execute the migration SQL
      this.db.exec(migration.sql);

      // Record the migration
      this.db
        .prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, migration.checksum);
    });

    console.log(`  ✓ Migration ${migration.version} applied successfully`);
  }

  /**
   * Run all pending migrations.
   */
  migrate(migrations?: Migration[]): MigrationResult {
    const allMigrations = migrations ?? loadMigrations();
    const currentVersion = this.getCurrentVersion();

    const result: MigrationResult = {
      applied: [],
      skipped: 0,
      errors: [],
    };

    for (const migration of allMigrations) {
      if (migration.version <= currentVersion) {
        result.skipped++;
        continue;
      }

      try {
        this.applyMigration(migration);
        result.applied.push(migration);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ Migration ${migration.version} failed: ${message}`);
        result.errors.push({ version: migration.version, error: message });
        // Stop on first error
        break;
      }
    }

    return result;
  }

  /**
   * Get migration status summary.
   */
  getStatus(): {
    current_version: number;
    applied_count: number;
    pending_count: number;
    pending_migrations: Array<{ version: number; name: string }>;
  } {
    const allMigrations = loadMigrations();
    const currentVersion = this.getCurrentVersion();
    const applied = this.getAppliedMigrations();

    const pending = allMigrations.filter(m => m.version > currentVersion);

    return {
      current_version: currentVersion,
      applied_count: applied.length,
      pending_count: pending.length,
      pending_migrations: pending.map(m => ({ version: m.version, name: m.name })),
    };
  }
}

/**
 * Run migrations using the default database connection.
 */
export async function runMigrations(db: DatabaseConnection): Promise<MigrationResult> {
  const runner = new MigrationRunner(db);
  return runner.migrate();
}
