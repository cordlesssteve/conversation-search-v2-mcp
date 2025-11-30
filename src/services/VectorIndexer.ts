/**
 * Vector Indexer Service
 *
 * Indexes messages from SQLite into ChromaDB for semantic search.
 */

import type { MessageRepository } from '../repositories/index.js';
import type { VectorStore, VectorDocument } from './VectorStore.js';

export interface IndexingOptions {
  /** Batch size for processing */
  batchSize?: number;
  /** Only index messages from these roles */
  roles?: string[];
  /** Minimum content length to index */
  minContentLength?: number;
  /** Maximum content length per chunk */
  maxChunkLength?: number;
  /** Progress callback */
  onProgress?: (indexed: number, total: number) => void;
  /** Concurrency for embedding requests (default: 50) */
  concurrency?: number;
  /** Skip existence checks and use upsert (default: true for speed) */
  useUpsert?: boolean;
}

export interface IndexingResult {
  totalMessages: number;
  indexed: number;
  skipped: number;
  chunks: number;
  errors: number;
  duration: number;
}

export class VectorIndexer {
  constructor(
    private messageRepo: MessageRepository,
    private vectorStore: VectorStore
  ) {}

  /**
   * Index all messages into ChromaDB.
   */
  async indexAll(options: IndexingOptions = {}): Promise<IndexingResult> {
    const {
      batchSize = 100,
      roles = ['user', 'assistant'],
      minContentLength = 50,
      maxChunkLength = 2000,
      onProgress,
      concurrency = 50,
      useUpsert = true,
    } = options;

    const startTime = Date.now();
    const result: IndexingResult = {
      totalMessages: 0,
      indexed: 0,
      skipped: 0,
      chunks: 0,
      errors: 0,
      duration: 0,
    };

    // Count total messages
    result.totalMessages = this.messageRepo.count();

    // Process messages in batches
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const messages = this.messageRepo.find({}, batchSize, offset);

      if (messages.length === 0) {
        hasMore = false;
        break;
      }

      const documents: VectorDocument[] = [];

      for (const message of messages) {
        // Skip messages with excluded roles
        if (!roles.includes(message.role)) {
          result.skipped++;
          continue;
        }

        // Skip messages that are too short
        if (message.content.length < minContentLength) {
          result.skipped++;
          continue;
        }

        const docId = `msg_${message.uuid}`;

        // Skip existence check when using upsert (major performance improvement)
        if (!useUpsert) {
          if (await this.vectorStore.exists(docId)) {
            result.skipped++;
            continue;
          }
        }

        // Chunk long messages
        const chunks = this.chunkContent(message.content, maxChunkLength);

        for (let i = 0; i < chunks.length; i++) {
          const chunkId = chunks.length > 1 ? `${docId}_${i}` : docId;

          documents.push({
            id: chunkId,
            content: chunks[i],
            metadata: {
              session_id: message.session_id,
              message_uuid: message.uuid,
              role: message.role,
              timestamp: message.timestamp,
              chunk_index: chunks.length > 1 ? i : undefined,
            },
          });

          result.chunks++;
        }

        result.indexed++;
      }

      // Add/upsert documents to vector store
      if (documents.length > 0) {
        try {
          if (useUpsert) {
            await this.vectorStore.upsertDocuments(documents, concurrency);
          } else {
            await this.vectorStore.addDocuments(documents);
          }
        } catch (error) {
          result.errors += documents.length;
          console.error('Error indexing batch:', error);
        }
      }

      offset += batchSize;
      onProgress?.(offset, result.totalMessages);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Index messages for a specific session.
   */
  async indexSession(
    sessionId: string,
    options: Omit<IndexingOptions, 'onProgress'> = {}
  ): Promise<IndexingResult> {
    const {
      roles = ['user', 'assistant'],
      minContentLength = 50,
      maxChunkLength = 2000,
    } = options;

    const startTime = Date.now();
    const result: IndexingResult = {
      totalMessages: 0,
      indexed: 0,
      skipped: 0,
      chunks: 0,
      errors: 0,
      duration: 0,
    };

    const messages = this.messageRepo.findBySession(sessionId);
    result.totalMessages = messages.length;

    const documents: VectorDocument[] = [];

    for (const message of messages) {
      if (!roles.includes(message.role)) {
        result.skipped++;
        continue;
      }

      if (message.content.length < minContentLength) {
        result.skipped++;
        continue;
      }

      const docId = `msg_${message.uuid}`;
      const chunks = this.chunkContent(message.content, maxChunkLength);

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = chunks.length > 1 ? `${docId}_${i}` : docId;

        documents.push({
          id: chunkId,
          content: chunks[i],
          metadata: {
            session_id: message.session_id,
            message_uuid: message.uuid,
            role: message.role,
            timestamp: message.timestamp,
            chunk_index: chunks.length > 1 ? i : undefined,
          },
        });

        result.chunks++;
      }

      result.indexed++;
    }

    if (documents.length > 0) {
      try {
        await this.vectorStore.addDocuments(documents);
      } catch (error) {
        result.errors += documents.length;
        console.error('Error indexing session:', error);
      }
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  /**
   * Re-index a session (delete and re-add).
   */
  async reindexSession(
    sessionId: string,
    options: Omit<IndexingOptions, 'onProgress'> = {}
  ): Promise<IndexingResult> {
    await this.vectorStore.deleteBySession(sessionId);
    return this.indexSession(sessionId, options);
  }

  /**
   * Chunk content into smaller pieces.
   */
  private chunkContent(content: string, maxLength: number): string[] {
    if (content.length <= maxLength) {
      return [content];
    }

    const chunks: string[] = [];
    const sentences = content.split(/(?<=[.!?])\s+/);
    let currentChunk = '';

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        // Handle sentences longer than maxLength
        if (sentence.length > maxLength) {
          const words = sentence.split(' ');
          currentChunk = '';
          for (const word of words) {
            if (currentChunk.length + word.length + 1 > maxLength) {
              if (currentChunk) {
                chunks.push(currentChunk.trim());
              }
              currentChunk = word;
            } else {
              currentChunk += (currentChunk ? ' ' : '') + word;
            }
          }
        } else {
          currentChunk = sentence;
        }
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}
