#!/usr/bin/env node
/**
 * Create Session Stub
 *
 * Creates a stub session entry for early registration before full import.
 * Called by SessionStart hooks to enable immediate tagging of new sessions.
 *
 * Usage:
 *   npm run create-stub -- --session-id=<uuid> [--project-path=<path>] [--cwd=<path>]
 *
 * Or directly:
 *   node dist/scripts/create-stub.js --session-id=<uuid>
 */

import { getDatabase, closeDatabase, MigrationRunner } from '../database/index.js';
import { SessionRepository, ProjectRepository } from '../repositories/index.js';

interface StubOptions {
  sessionId: string;
  projectPath?: string;
  cwd?: string;
}

function parseArgs(): StubOptions {
  const args = process.argv.slice(2);
  const options: StubOptions = {
    sessionId: '',
  };

  for (const arg of args) {
    if (arg.startsWith('--session-id=')) {
      options.sessionId = arg.replace('--session-id=', '');
    } else if (arg.startsWith('--project-path=')) {
      options.projectPath = arg.replace('--project-path=', '');
    } else if (arg.startsWith('--cwd=')) {
      options.cwd = arg.replace('--cwd=', '');
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (!options.sessionId) {
    console.error('Error: --session-id is required');
    console.error('Usage: npm run create-stub -- --session-id=<uuid> [--project-path=<path>]');
    process.exit(1);
  }

  const db = getDatabase();

  try {
    // Run migrations if needed
    const runner = new MigrationRunner(db);
    const status = runner.getStatus();
    if (status.pending_count > 0) {
      runner.migrate();
    }

    const sessionRepo = new SessionRepository(db);
    const projectRepo = new ProjectRepository(db);

    // Check if session already exists
    if (sessionRepo.exists(options.sessionId)) {
      // Session exists - could be a stub or full session
      const isStub = sessionRepo.isStub(options.sessionId);
      console.log(JSON.stringify({
        success: true,
        action: 'exists',
        session_id: options.sessionId,
        is_stub: isStub,
        message: isStub ? 'Session stub already exists' : 'Session already fully imported',
      }));
      return;
    }

    // Get or create project if project_path provided
    let projectId: number | undefined;
    if (options.projectPath) {
      const project = projectRepo.getOrCreate(options.projectPath);
      projectId = project.id;
    }

    // Create the stub
    const session = sessionRepo.createStub({
      id: options.sessionId,
      project_path: options.projectPath,
      cwd: options.cwd,
    });

    // If we have a project, link it
    if (projectId && session) {
      db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?')
        .run(projectId, options.sessionId);
    }

    console.log(JSON.stringify({
      success: true,
      action: 'created',
      session_id: options.sessionId,
      project_path: options.projectPath,
      cwd: options.cwd,
      message: 'Session stub created successfully',
    }));

  } catch (error) {
    console.error(JSON.stringify({
      success: false,
      action: 'error',
      session_id: options.sessionId,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
