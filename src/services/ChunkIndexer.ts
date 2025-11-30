/**
 * Chunk Indexer Service
 *
 * Indexes conversations into ChromaDB using semantic chunking.
 * Features:
 * - Message pairing (Q&A kept together)
 * - Topic detection and grouping
 * - Checkpoint system for resumable indexing
 * - Session-based processing for better organization
 */

import fs from 'fs';
import type { MessageRepository, SessionRepository } from '../repositories/index.js';
import type { VectorStore, ChunkDocument } from './VectorStore.js';
import { ChunkManager, type ConversationChunk } from './ChunkManager.js';

export interface ChunkIndexingOptions {
  /** Number of sessions to process per batch */
  batchSize?: number;
  /** Concurrency for embedding requests */
  concurrency?: number;
  /** Progress callback */
  onProgress?: (processed: number, total: number, currentSession?: string) => void;
  /** Checkpoint file path (for resumable indexing) */
  checkpointPath?: string;
  /** Start fresh (ignore checkpoint) */
  freshStart?: boolean;
}

export interface ChunkIndexingResult {
  totalSessions: number;
  processedSessions: number;
  skippedSessions: number;
  totalChunks: number;
  errors: number;
  duration: number;
}

interface Checkpoint {
  lastProcessedSessionId: string | null;
  processedCount: number;
  totalSessions: number;
  timestamp: string;
}

export class ChunkIndexer {
  private chunkManager: ChunkManager;

  constructor(
    private sessionRepo: SessionRepository,
    private messageRepo: MessageRepository,
    private vectorStore: VectorStore
  ) {
    this.chunkManager = new ChunkManager();
  }

  /**
   * Index all sessions into ChromaDB using semantic chunking.
   */
  async indexAll(options: ChunkIndexingOptions = {}): Promise<ChunkIndexingResult> {
    const {
      batchSize = 10,
      concurrency = 10,
      onProgress,
      checkpointPath = '/tmp/chunk-indexer-checkpoint.json',
      freshStart = false,
    } = options;

    const startTime = Date.now();
    const result: ChunkIndexingResult = {
      totalSessions: 0,
      processedSessions: 0,
      skippedSessions: 0,
      totalChunks: 0,
      errors: 0,
      duration: 0,
    };

    // Get all session IDs
    const allSessions = this.sessionRepo.findAll();
    result.totalSessions = allSessions.length;

    // Load checkpoint if exists and not fresh start
    let checkpoint: Checkpoint | null = null;
    let startIndex = 0;

    if (!freshStart && fs.existsSync(checkpointPath)) {
      try {
        checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
        if (checkpoint?.lastProcessedSessionId) {
          const idx = allSessions.findIndex(s => s.id === checkpoint!.lastProcessedSessionId);
          if (idx >= 0) {
            startIndex = idx + 1;
            result.processedSessions = checkpoint.processedCount;
            console.log(`Resuming from checkpoint: ${startIndex}/${allSessions.length} sessions`);
          }
        }
      } catch {
        console.log('Could not load checkpoint, starting fresh');
      }
    }

    // Process sessions in batches (upsert per-session to avoid huge payloads)
    for (let i = startIndex; i < allSessions.length; i += batchSize) {
      const batch = allSessions.slice(i, i + batchSize);

      for (const session of batch) {
        try {
          // Get messages for this session
          const messages = this.messageRepo.findBySession(session.id);

          if (messages.length === 0) {
            result.skippedSessions++;
            continue;
          }

          // Create chunks using ChunkManager
          const chunks = this.chunkManager.processSession(session, messages);

          if (chunks.length === 0) {
            result.skippedSessions++;
            continue;
          }

          // Convert to ChunkDocuments and upsert immediately (per-session)
          const sessionChunks = chunks.map(c => this.chunkToDocument(c));

          try {
            await this.vectorStore.upsertChunks(sessionChunks, concurrency);
          } catch (error) {
            console.error(`Error upserting session ${session.id}:`, error);
            result.errors += sessionChunks.length;
            continue;
          }

          result.processedSessions++;
          result.totalChunks += chunks.length;
        } catch (error) {
          console.error(`Error processing session ${session.id}:`, error);
          result.errors++;
        }
      }

      // Save checkpoint
      const lastSession = batch[batch.length - 1];
      this.saveCheckpoint(checkpointPath, {
        lastProcessedSessionId: lastSession.id,
        processedCount: result.processedSessions,
        totalSessions: result.totalSessions,
        timestamp: new Date().toISOString(),
      });

      // Report progress
      onProgress?.(i + batch.length, allSessions.length, lastSession?.id);
    }

    // Clean up checkpoint on successful completion
    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Index a single session.
   */
  async indexSession(sessionId: string, concurrency: number = 10): Promise<number> {
    const session = this.sessionRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = this.messageRepo.findBySession(sessionId);
    if (messages.length === 0) {
      return 0;
    }

    const chunks = this.chunkManager.processSession(session, messages);
    if (chunks.length === 0) {
      return 0;
    }

    const documents = chunks.map(c => this.chunkToDocument(c));
    await this.vectorStore.upsertChunks(documents, concurrency);

    return chunks.length;
  }

  /**
   * Reindex a session (delete existing and re-add).
   */
  async reindexSession(sessionId: string, concurrency: number = 10): Promise<number> {
    await this.vectorStore.deleteBySession(sessionId);
    return this.indexSession(sessionId, concurrency);
  }

  /**
   * Convert ConversationChunk to ChunkDocument for VectorStore.
   */
  private chunkToDocument(chunk: ConversationChunk): ChunkDocument {
    return {
      id: chunk.chunk_id,
      content: chunk.content,
      metadata: {
        session_id: chunk.session_id,
        sequence_number: chunk.sequence_number,
        chunk_type: chunk.chunk_type,
        timestamp: chunk.timestamp,
        project_path: chunk.project_path || '',
        message_count: chunk.message_count,
        previous_chunk: chunk.previous_chunk || '',
        next_chunk: chunk.next_chunk || '',
        topic_group: chunk.topic_group || '',
        token_count: chunk.token_count,
        processing_date: chunk.processing_date,
      },
    };
  }

  /**
   * Save checkpoint to file.
   */
  private saveCheckpoint(filePath: string, checkpoint: Checkpoint): void {
    try {
      fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
    } catch (error) {
      console.error('Failed to save checkpoint:', error);
    }
  }

  /**
   * Get indexing progress from checkpoint.
   */
  static getProgress(checkpointPath: string = '/tmp/chunk-indexer-checkpoint.json'): Checkpoint | null {
    if (!fs.existsSync(checkpointPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(checkpointPath, 'utf-8'));
    } catch {
      return null;
    }
  }
}
