/**
 * JSONL Parser
 *
 * Parses Claude Code conversation JSONL files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { RawJsonlMessage } from '../types/models.js';

export interface ParsedSession {
  id: string;
  file_path: string;
  project_path: string | null;
  cwd: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  messages: ParsedMessage[];
}

export interface ParsedMessage {
  uuid: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  model: string | null;
  parent_uuid: string | null;
  message_type: string | null;
  cwd: string | null;
}

export class JsonlParser {
  /**
   * Parse a single JSONL file into a session with messages.
   */
  async parseFile(filePath: string): Promise<ParsedSession | null> {
    try {
      const lines = await this.readLines(filePath);
      if (lines.length === 0) {
        return null;
      }

      const messages: ParsedMessage[] = [];
      let sessionId: string | null = null;
      let title: string | null = null;
      let cwd: string | null = null;
      let projectPath: string | null = null;
      let startedAt: string | null = null;
      let endedAt: string | null = null;

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line) as RawJsonlMessage;

          // Handle summary line (contains session title)
          if (parsed.type === 'summary') {
            title = parsed.summary ?? null;
            continue;
          }

          // Skip system/meta messages
          if (parsed.type === 'system' || parsed.isMeta) {
            continue;
          }

          // Extract session metadata from first message
          if (!sessionId && parsed.sessionId) {
            sessionId = parsed.sessionId;
          }

          if (!cwd && parsed.cwd) {
            cwd = parsed.cwd;
            // Extract project path from cwd
            projectPath = this.extractProjectPath(parsed.cwd);
          }

          // Track timestamps for session duration
          if (parsed.timestamp) {
            if (!startedAt || parsed.timestamp < startedAt) {
              startedAt = parsed.timestamp;
            }
            if (!endedAt || parsed.timestamp > endedAt) {
              endedAt = parsed.timestamp;
            }
          }

          // Parse user and assistant messages
          if (parsed.type === 'user' || parsed.type === 'assistant') {
            const message = this.parseMessage(parsed, sessionId!);
            if (message) {
              messages.push(message);
            }
          }
        } catch (parseError) {
          // Skip malformed lines
          continue;
        }
      }

      if (!sessionId || messages.length === 0) {
        return null;
      }

      // If no title from summary, try to generate from first user message
      if (!title && messages.length > 0) {
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (firstUserMsg) {
          title = this.generateTitle(firstUserMsg.content);
        }
      }

      return {
        id: sessionId,
        file_path: filePath,
        project_path: projectPath,
        cwd,
        title,
        started_at: startedAt,
        ended_at: endedAt,
        messages,
      };
    } catch (error) {
      console.error(`Error parsing file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Read all lines from a file.
   */
  private async readLines(filePath: string): Promise<string[]> {
    const lines: string[] = [];

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lines.push(line);
    }

    return lines;
  }

  /**
   * Parse a single message from JSONL.
   */
  private parseMessage(raw: RawJsonlMessage, sessionId: string): ParsedMessage | null {
    if (!raw.uuid || !raw.timestamp) {
      return null;
    }

    // Extract content from message
    let content = '';
    let role = raw.type === 'assistant' ? 'assistant' : 'user';
    let model: string | null = null;

    if (raw.message) {
      role = raw.message.role || role;
      model = raw.message.model ?? null;

      // Handle different content formats
      if (typeof raw.message.content === 'string') {
        content = raw.message.content;
      } else if (Array.isArray(raw.message.content)) {
        // Content can be an array of content blocks
        content = raw.message.content
          .map(block => {
            if (typeof block === 'string') return block;
            if (block.type === 'text') return block.text || '';
            if (block.type === 'tool_use') {
              return `[Tool Use: ${block.name || 'unknown'}]`;
            }
            if (block.type === 'tool_result') {
              const resultContent = block.content;
              if (typeof resultContent === 'string') return resultContent;
              if (Array.isArray(resultContent)) {
                return (resultContent as Array<string | { text?: string }>)
                  .map((r: string | { text?: string }) => (typeof r === 'string' ? r : r.text || ''))
                  .join('\n');
              }
              return '';
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }
    }

    // Skip empty messages
    if (!content.trim()) {
      return null;
    }

    return {
      uuid: raw.uuid,
      session_id: sessionId,
      role,
      content,
      timestamp: raw.timestamp,
      model,
      parent_uuid: raw.parentUuid ?? null,
      message_type: raw.type ?? null,
      cwd: raw.cwd ?? null,
    };
  }

  /**
   * Extract project path from working directory.
   */
  private extractProjectPath(cwd: string): string | null {
    // Handle common project path patterns
    // e.g., /home/user/projects/MyProject -> /home/user/projects/MyProject
    // e.g., /home/cordlesssteve/catzen-dev -> /home/cordlesssteve/catzen-dev

    // Return as-is if it looks like a valid project path
    if (cwd.includes('/projects/') || cwd.includes('/home/')) {
      return cwd;
    }

    return cwd;
  }

  /**
   * Generate a title from message content.
   */
  private generateTitle(content: string): string | null {
    if (!content) return null;

    // Clean and truncate for title
    const cleaned = content
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);

    if (cleaned.length > 80) {
      return cleaned.slice(0, 80) + '...';
    }

    return cleaned || null;
  }

  /**
   * Get session ID from filename.
   */
  getSessionIdFromFilename(filePath: string): string {
    const filename = path.basename(filePath, '.jsonl');
    return filename;
  }
}
