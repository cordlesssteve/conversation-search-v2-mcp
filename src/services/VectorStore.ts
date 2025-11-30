/**
 * Vector Store Service
 *
 * Manages ChromaDB collection for semantic search.
 */

import { ChromaClient, Collection, IncludeEnum } from 'chromadb';
import type { EmbeddingService } from './EmbeddingService.js';

export interface VectorDocument {
  id: string;
  content: string;
  metadata: {
    session_id: string;
    message_uuid: string;
    role: string;
    timestamp: string;
    chunk_index?: number;
  };
}

/**
 * A chunk document with rich metadata for semantic search.
 * Used with ChunkManager for message-pair based indexing.
 */
export interface ChunkDocument {
  id: string;
  content: string;
  metadata: {
    session_id: string;
    sequence_number: number;
    chunk_type: string;
    timestamp: string;
    project_path: string;
    message_count: number;
    previous_chunk: string;
    next_chunk: string;
    topic_group: string;
    token_count: number;
    processing_date: string;
  };
}

export interface VectorSearchResult {
  id: string;
  content: string;
  metadata: VectorDocument['metadata'];
  distance: number;
  similarity: number;
}

export class VectorStore {
  private client: ChromaClient;
  private collection: Collection | null = null;
  private collectionName: string;
  private embeddingService: EmbeddingService;

  constructor(
    embeddingService: EmbeddingService,
    collectionName: string = 'conversation_messages',
    chromaHost: string = 'http://localhost:8000'
  ) {
    this.client = new ChromaClient({ path: chromaHost });
    this.collectionName = collectionName;
    this.embeddingService = embeddingService;
  }

  /**
   * Initialize the collection.
   */
  async initialize(): Promise<void> {
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      metadata: {
        'hnsw:space': 'cosine',
        description: 'Conversation messages for semantic search',
      },
    });
  }

  /**
   * Get collection or throw if not initialized.
   */
  private getCollection(): Collection {
    if (!this.collection) {
      throw new Error('VectorStore not initialized. Call initialize() first.');
    }
    return this.collection;
  }

  /**
   * Add documents to the collection.
   */
  async addDocuments(documents: VectorDocument[]): Promise<number> {
    const collection = this.getCollection();

    // Generate embeddings
    const contents = documents.map(d => d.content);
    const embeddings = await this.embeddingService.embedBatch(contents);

    // Add to ChromaDB
    await collection.add({
      ids: documents.map(d => d.id),
      embeddings: embeddings.map(e => e.embedding),
      documents: contents,
      metadatas: documents.map(d => d.metadata as Record<string, string | number>),
    });

    return documents.length;
  }

  /**
   * Upsert documents (add or update if exists).
   * Skips existence checks - much faster for bulk indexing.
   */
  async upsertDocuments(documents: VectorDocument[], concurrency?: number): Promise<number> {
    const collection = this.getCollection();

    // Generate embeddings with configurable concurrency
    const contents = documents.map(d => d.content);
    const embeddings = await this.embeddingService.embedBatch(contents, concurrency);

    // Upsert to ChromaDB (add or update)
    await collection.upsert({
      ids: documents.map(d => d.id),
      embeddings: embeddings.map(e => e.embedding),
      documents: contents,
      metadatas: documents.map(d => d.metadata as Record<string, string | number>),
    });

    return documents.length;
  }

  /**
   * Search for similar documents.
   */
  async search(query: string, limit: number = 10): Promise<VectorSearchResult[]> {
    const collection = this.getCollection();

    // Generate query embedding
    const { embedding } = await this.embeddingService.embed(query);

    // Query ChromaDB
    const results = await collection.query({
      queryEmbeddings: [embedding],
      nResults: limit,
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
    });

    // Format results
    const searchResults: VectorSearchResult[] = [];

    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const distance = results.distances?.[0]?.[i] ?? 0;
        searchResults.push({
          id: results.ids[0][i],
          content: results.documents?.[0]?.[i] ?? '',
          metadata: results.metadatas?.[0]?.[i] as VectorDocument['metadata'],
          distance,
          similarity: 1 - distance, // Cosine distance to similarity
        });
      }
    }

    return searchResults;
  }

  /**
   * Search with session filter.
   */
  async searchInSession(
    query: string,
    sessionId: string,
    limit: number = 10
  ): Promise<VectorSearchResult[]> {
    const collection = this.getCollection();

    const { embedding } = await this.embeddingService.embed(query);

    const results = await collection.query({
      queryEmbeddings: [embedding],
      nResults: limit,
      where: { session_id: sessionId },
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
    });

    const searchResults: VectorSearchResult[] = [];

    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const distance = results.distances?.[0]?.[i] ?? 0;
        searchResults.push({
          id: results.ids[0][i],
          content: results.documents?.[0]?.[i] ?? '',
          metadata: results.metadatas?.[0]?.[i] as VectorDocument['metadata'],
          distance,
          similarity: 1 - distance,
        });
      }
    }

    return searchResults;
  }

  /**
   * Delete documents by session.
   */
  async deleteBySession(sessionId: string): Promise<void> {
    const collection = this.getCollection();
    await collection.delete({
      where: { session_id: sessionId },
    });
  }

  /**
   * Check if a document exists.
   */
  async exists(id: string): Promise<boolean> {
    const collection = this.getCollection();
    const result = await collection.get({
      ids: [id],
      limit: 1,
    });
    return result.ids.length > 0;
  }

  /**
   * Get collection statistics.
   */
  async getStats(): Promise<{ count: number; name: string }> {
    const collection = this.getCollection();
    const count = await collection.count();
    return {
      count,
      name: this.collectionName,
    };
  }

  /**
   * Health check for ChromaDB.
   */
  async healthCheck(): Promise<{ available: boolean; error?: string }> {
    try {
      await this.client.heartbeat();
      return { available: true };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : 'ChromaDB not available',
      };
    }
  }

  /**
   * Upsert chunk documents (message pairs with rich metadata).
   * Sub-batches upserts to avoid ChromaDB payload limits.
   */
  async upsertChunks(chunks: ChunkDocument[], concurrency?: number): Promise<number> {
    const collection = this.getCollection();
    const UPSERT_BATCH_SIZE = 50; // ChromaDB payload limit safe size

    // Generate embeddings
    const contents = chunks.map(c => c.content);
    const embeddings = await this.embeddingService.embedBatch(contents, concurrency);

    // Upsert to ChromaDB in sub-batches to avoid payload limits
    for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
      const end = Math.min(i + UPSERT_BATCH_SIZE, chunks.length);
      const batchChunks = chunks.slice(i, end);
      const batchEmbeddings = embeddings.slice(i, end);
      const batchContents = contents.slice(i, end);

      await collection.upsert({
        ids: batchChunks.map(c => c.id),
        embeddings: batchEmbeddings.map(e => e.embedding),
        documents: batchContents,
        metadatas: batchChunks.map(c => c.metadata as Record<string, string | number>),
      });
    }

    return chunks.length;
  }

  /**
   * Search with topic filter.
   */
  async searchByTopic(
    query: string,
    topic: string,
    limit: number = 10
  ): Promise<VectorSearchResult[]> {
    const collection = this.getCollection();

    const { embedding } = await this.embeddingService.embed(query);

    const results = await collection.query({
      queryEmbeddings: [embedding],
      nResults: limit,
      where: { topic_group: topic },
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
    });

    const searchResults: VectorSearchResult[] = [];

    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const distance = results.distances?.[0]?.[i] ?? 0;
        searchResults.push({
          id: results.ids[0][i],
          content: results.documents?.[0]?.[i] ?? '',
          metadata: results.metadatas?.[0]?.[i] as VectorDocument['metadata'],
          distance,
          similarity: 1 - distance,
        });
      }
    }

    return searchResults;
  }

  /**
   * Get a chunk by ID with its adjacent chunks.
   */
  async getChunkWithContext(chunkId: string): Promise<{
    chunk: VectorSearchResult | null;
    previous: VectorSearchResult | null;
    next: VectorSearchResult | null;
  }> {
    const collection = this.getCollection();

    // Get the target chunk
    const result = await collection.get({
      ids: [chunkId],
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas],
    });

    if (result.ids.length === 0) {
      return { chunk: null, previous: null, next: null };
    }

    const metadata = result.metadatas?.[0] as Record<string, string | number>;
    const chunk: VectorSearchResult = {
      id: result.ids[0],
      content: result.documents?.[0] ?? '',
      metadata: metadata as VectorDocument['metadata'],
      distance: 0,
      similarity: 1,
    };

    // Get adjacent chunks if they exist
    const prevId = metadata?.previous_chunk as string;
    const nextId = metadata?.next_chunk as string;

    let previous: VectorSearchResult | null = null;
    let next: VectorSearchResult | null = null;

    if (prevId) {
      const prevResult = await collection.get({
        ids: [prevId],
        include: [IncludeEnum.Documents, IncludeEnum.Metadatas],
      });
      if (prevResult.ids.length > 0) {
        previous = {
          id: prevResult.ids[0],
          content: prevResult.documents?.[0] ?? '',
          metadata: prevResult.metadatas?.[0] as VectorDocument['metadata'],
          distance: 0,
          similarity: 1,
        };
      }
    }

    if (nextId) {
      const nextResult = await collection.get({
        ids: [nextId],
        include: [IncludeEnum.Documents, IncludeEnum.Metadatas],
      });
      if (nextResult.ids.length > 0) {
        next = {
          id: nextResult.ids[0],
          content: nextResult.documents?.[0] ?? '',
          metadata: nextResult.metadatas?.[0] as VectorDocument['metadata'],
          distance: 0,
          similarity: 1,
        };
      }
    }

    return { chunk, previous, next };
  }

  /**
   * Delete the entire collection (for fresh reindexing).
   */
  async deleteCollection(): Promise<void> {
    try {
      await this.client.deleteCollection({ name: this.collectionName });
      this.collection = null;
    } catch {
      // Collection may not exist, that's fine
    }
  }
}
