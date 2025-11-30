/**
 * Database Connection Manager
 *
 * Provides a singleton connection to the SQLite database with proper
 * configuration for performance and data integrity.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DatabaseConfig {
  path: string;
  readonly?: boolean;
  verbose?: boolean;
}

// Database now stored in project/data/ directory (relative to src/database/)
const DEFAULT_DB_PATH = path.join(__dirname, '../../data/conversations.db');

/**
 * Expands ~ to home directory in paths
 */
function expandPath(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Database connection manager with connection pooling and configuration.
 */
export class DatabaseConnection {
  private db: Database.Database | null = null;
  private dbPath: string;
  private readonly: boolean;
  private verbose: boolean;

  constructor(config: Partial<DatabaseConfig> = {}) {
    this.dbPath = expandPath(config.path ?? DEFAULT_DB_PATH);
    this.readonly = config.readonly ?? false;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Get the database connection, creating it if necessary.
   */
  getConnection(): Database.Database {
    if (this.db) {
      return this.db;
    }

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database connection
    this.db = new Database(this.dbPath, {
      readonly: this.readonly,
      verbose: this.verbose ? console.log : undefined,
    });

    // Configure database for optimal performance
    this.configurePragmas();

    return this.db;
  }

  /**
   * Configure SQLite pragmas for performance and integrity.
   */
  private configurePragmas(): void {
    if (!this.db) return;

    // Enable foreign key constraints
    this.db.pragma('foreign_keys = ON');

    // Use WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    // Synchronous mode - NORMAL is a good balance of safety/speed
    this.db.pragma('synchronous = NORMAL');

    // Increase cache size to 64MB
    this.db.pragma('cache_size = -64000');

    // Store temp tables in memory
    this.db.pragma('temp_store = MEMORY');

    // Enable memory-mapped I/O (256MB)
    this.db.pragma('mmap_size = 268435456');
  }

  /**
   * Execute a SQL statement that doesn't return data.
   */
  exec(sql: string): void {
    this.getConnection().exec(sql);
  }

  /**
   * Prepare a statement for repeated execution.
   */
  prepare(sql: string): Database.Statement {
    return this.getConnection().prepare(sql);
  }

  /**
   * Run a function in a transaction.
   */
  transaction<T>(fn: () => T): T {
    const db = this.getConnection();
    return db.transaction(fn)();
  }

  /**
   * Check if a table exists in the database.
   */
  tableExists(tableName: string): boolean {
    const result = this.getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName);
    return result !== undefined;
  }

  /**
   * Get database file size in bytes.
   */
  getDatabaseSize(): number {
    try {
      const stats = fs.statSync(this.dbPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Vacuum the database to reclaim space.
   */
  vacuum(): void {
    this.getConnection().exec('VACUUM');
  }

  /**
   * Get database statistics.
   */
  getStats(): {
    path: string;
    size_bytes: number;
    page_count: number;
    page_size: number;
    wal_mode: boolean;
  } {
    const db = this.getConnection();
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const journalMode = db.pragma('journal_mode', { simple: true }) as string;

    return {
      path: this.dbPath,
      size_bytes: this.getDatabaseSize(),
      page_count: pageCount,
      page_size: pageSize,
      wal_mode: journalMode === 'wal',
    };
  }
}

// Singleton instance for the application
let defaultConnection: DatabaseConnection | null = null;

/**
 * Get the default database connection.
 */
export function getDatabase(config?: Partial<DatabaseConfig>): DatabaseConnection {
  if (!defaultConnection) {
    defaultConnection = new DatabaseConnection(config);
  }
  return defaultConnection;
}

/**
 * Close the default database connection.
 */
export function closeDatabase(): void {
  if (defaultConnection) {
    defaultConnection.close();
    defaultConnection = null;
  }
}
