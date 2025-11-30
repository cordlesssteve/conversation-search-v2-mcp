/**
 * Import Service
 *
 * Handles importing conversations from JSONL files into the database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionRepository, MessageRepository, ProjectRepository } from '../repositories/index.js';
import { JsonlParser } from './JsonlParser.js';

export interface ImportOptions {
  /** Source directories containing JSONL files */
  sourceDirs: string[];
  /** Skip files already imported (by session ID) */
  skipExisting?: boolean;
  /** Callback for progress updates */
  onProgress?: (current: number, total: number, sessionId: string) => void;
  /** Callback for errors */
  onError?: (file: string, error: Error) => void;
}

export interface ImportResult {
  totalFiles: number;
  imported: number;
  skipped: number;
  failed: number;
  totalMessages: number;
  errors: Array<{ file: string; error: string }>;
  duration: number;
}

export class ImportService {
  private parser: JsonlParser;

  constructor(
    private sessionRepo: SessionRepository,
    private messageRepo: MessageRepository,
    private projectRepo?: ProjectRepository
  ) {
    this.parser = new JsonlParser();
  }

  /**
   * Import all JSONL files from specified directories.
   */
  async importAll(options: ImportOptions): Promise<ImportResult> {
    const startTime = Date.now();
    const result: ImportResult = {
      totalFiles: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      totalMessages: 0,
      errors: [],
      duration: 0,
    };

    // Collect all JSONL files
    const files: string[] = [];
    for (const dir of options.sourceDirs) {
      const dirFiles = await this.findJsonlFiles(dir);
      files.push(...dirFiles);
    }

    result.totalFiles = files.length;

    // Import each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        const imported = await this.importFile(file, options.skipExisting ?? true);

        if (imported === null) {
          result.skipped++;
        } else if (imported === 0) {
          result.skipped++;
        } else {
          result.imported++;
          result.totalMessages += imported;
        }

        options.onProgress?.(i + 1, files.length, path.basename(file, '.jsonl'));
      } catch (error) {
        result.failed++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push({ file, error: errorMsg });
        options.onError?.(file, error instanceof Error ? error : new Error(errorMsg));
      }
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Import a single JSONL file.
   * Returns number of messages imported, 0 if skipped, null if failed.
   *
   * If the session exists as a stub (is_stub=true), it will be updated
   * with the full import data while preserving tags and user metadata.
   */
  async importFile(filePath: string, skipExisting: boolean = true): Promise<number | null> {
    // Parse the file
    const session = await this.parser.parseFile(filePath);
    if (!session) {
      return null;
    }

    // Check if session already exists
    const existingSession = this.sessionRepo.exists(session.id);
    const isStub = existingSession && this.sessionRepo.isStub(session.id);

    // Skip if exists and NOT a stub (unless skipExisting is false)
    if (skipExisting && existingSession && !isStub) {
      return 0;
    }

    // Look up or create project (if ProjectRepository is available)
    let projectId: number | undefined;
    if (this.projectRepo && session.project_path) {
      const project = this.projectRepo.getOrCreate(session.project_path);
      projectId = project.id;
    }

    const sessionInput = {
      id: session.id,
      file_path: session.file_path,
      project_id: projectId,
      project_path: session.project_path ?? undefined,
      cwd: session.cwd ?? undefined,
      started_at: session.started_at ?? new Date().toISOString(),
      ended_at: session.ended_at ?? undefined,
      message_count: session.messages.length,
      title: session.title ?? undefined,
      is_title_auto_generated: session.title !== null,
    };

    // Create or update session
    if (isStub) {
      // Update stub with full import data (preserves tags)
      this.sessionRepo.updateFromImport(session.id, sessionInput);
    } else if (!existingSession) {
      // Create new session
      this.sessionRepo.create(sessionInput);
    }

    // Import messages
    const messageInputs = session.messages.map(msg => ({
      uuid: msg.uuid,
      session_id: msg.session_id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      model: msg.model ?? undefined,
      parent_uuid: msg.parent_uuid ?? undefined,
      message_type: msg.message_type ?? undefined,
      cwd: msg.cwd ?? undefined,
    }));

    const created = this.messageRepo.createMany(messageInputs);

    // Update session message count
    this.sessionRepo.update(session.id, {
      message_count: created,
    });

    return created;
  }

  /**
   * Find all JSONL files in a directory (recursive).
   */
  private async findJsonlFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    if (!fs.existsSync(dir)) {
      return files;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await this.findJsonlFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Get import statistics.
   */
  getStats(): { sessions: number; messages: number } {
    return {
      sessions: this.sessionRepo.count(),
      messages: this.messageRepo.count(),
    };
  }
}
