#!/usr/bin/env node
/**
 * Chunk-Based Vector Indexing Script
 *
 * Indexes conversation sessions using semantic chunking:
 * - Message pairs (Q&A kept together)
 * - Topic detection and grouping
 * - Adjacency links for context expansion
 * - Checkpoint system for resumable indexing
 *
 * Usage:
 *   npm run index-chunks [options]
 *
 * Options:
 *   --batch-size <n>    Process n sessions at a time (default: 10)
 *   --concurrency <n>   Embedding concurrency (default: 10)
 *   --fresh             Start fresh (delete existing collection)
 *   --verbose           Show detailed progress
 *   --help              Show help
 */

import { getDatabase, closeDatabase } from '../database/index.js';
import { SessionRepository, MessageRepository } from '../repositories/index.js';
import { EmbeddingService, VectorStore, ChunkIndexer } from '../services/index.js';

interface CliOptions {
  batchSize: number;
  concurrency: number;
  verbose: boolean;
  fresh: boolean;
  chromaHost: string;
  ollamaHost: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    batchSize: 10,
    concurrency: 10,
    verbose: false,
    fresh: false,
    chromaHost: 'http://localhost:8000',
    ollamaHost: 'http://localhost:11434',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[++i], 10);
    } else if (arg === '--concurrency' && args[i + 1]) {
      options.concurrency = parseInt(args[++i], 10);
    } else if (arg === '--chroma-host' && args[i + 1]) {
      options.chromaHost = args[++i];
    } else if (arg === '--ollama-host' && args[i + 1]) {
      options.ollamaHost = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--fresh') {
      options.fresh = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Chunk-Based Vector Indexing - Conversation Search v2

This script uses SEMANTIC CHUNKING for better search quality:
- Message pairs: Q&A kept together for context
- Topic detection: Groups related discussions
- Adjacency links: Enable "expand context" features

Usage:
  npm run index-chunks [options]

Options:
  --batch-size <n>      Process n sessions at a time (default: 10)
  --concurrency <n>     Embedding concurrency (default: 10)
  --fresh               Start fresh (delete existing collection)
  --chroma-host <url>   ChromaDB URL (default: http://localhost:8000)
  --ollama-host <url>   Ollama URL (default: http://localhost:11434)
  --verbose, -v         Show detailed progress
  --help, -h            Show this help message

Prerequisites:
  1. ChromaDB must be running: docker run -p 8000:8000 chromadb/chroma
  2. Ollama must be running with nomic-embed-text: ollama pull nomic-embed-text

Examples:
  npm run index-chunks                    # Index all sessions (resume from checkpoint)
  npm run index-chunks -- --fresh         # Start fresh (delete existing)
  npm run index-chunks -- --verbose       # With detailed progress
`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

async function main(): Promise<void> {
  const options = parseArgs();

  console.log('Chunk-Based Vector Indexing - Conversation Search v2');
  console.log('====================================================\n');

  // Initialize services
  console.log('Initializing services...');

  const embeddingService = new EmbeddingService(options.ollamaHost);
  const vectorStore = new VectorStore(
    embeddingService,
    'conversation_messages', // Same collection as MCP server uses
    options.chromaHost
  );

  // Health checks
  console.log('\nHealth checks:');

  const ollamaHealth = await embeddingService.healthCheck();
  if (!ollamaHealth.available) {
    console.error(`  ❌ Ollama: FAILED - ${ollamaHealth.error}`);
    console.error('\nPlease ensure Ollama is running: ollama serve');
    process.exit(1);
  }
  console.log(`  ✓ Ollama: OK (${options.ollamaHost})`);

  if (!ollamaHealth.model_loaded) {
    console.error(`  ❌ Model: FAILED - ${ollamaHealth.error}`);
    console.error('\nPlease pull the model: ollama pull nomic-embed-text');
    process.exit(1);
  }
  console.log('  ✓ Model: nomic-embed-text loaded');

  const chromaHealth = await vectorStore.healthCheck();
  if (!chromaHealth.available) {
    console.error(`  ❌ ChromaDB: FAILED - ${chromaHealth.error}`);
    console.error('\nPlease ensure ChromaDB is running:');
    console.error('  docker run -p 8000:8000 chromadb/chroma');
    process.exit(1);
  }
  console.log(`  ✓ ChromaDB: OK (${options.chromaHost})`);

  // Handle fresh start
  if (options.fresh) {
    console.log('\n⚠️  Fresh start requested - deleting existing collection...');
    await vectorStore.deleteCollection();
  }

  // Initialize vector store
  await vectorStore.initialize();
  console.log('  ✓ Collection: initialized');

  // Get current stats
  const vectorStats = await vectorStore.getStats();
  console.log(`\nCurrent vector index: ${formatNumber(vectorStats.count)} chunks`);

  // Initialize database
  const db = getDatabase();
  const sessionRepo = new SessionRepository(db);
  const messageRepo = new MessageRepository(db);

  const allSessions = sessionRepo.findAll();
  console.log(`Total sessions in SQLite: ${formatNumber(allSessions.length)}`);

  // Check for existing checkpoint
  const checkpoint = ChunkIndexer.getProgress();
  if (checkpoint && !options.fresh) {
    console.log(`\n📋 Checkpoint found: ${checkpoint.processedCount}/${checkpoint.totalSessions} sessions`);
    console.log(`   Last updated: ${checkpoint.timestamp}`);
  }

  // Create indexer
  const indexer = new ChunkIndexer(sessionRepo, messageRepo, vectorStore);

  try {
    console.log('\nIndexing sessions...\n');

    let lastProgress = '';
    const result = await indexer.indexAll({
      batchSize: options.batchSize,
      concurrency: options.concurrency,
      freshStart: options.fresh,
      onProgress: (processed, total, currentSession) => {
        if (options.verbose) {
          console.log(`  Processed ${formatNumber(processed)} / ${formatNumber(total)} sessions`);
          if (currentSession) {
            console.log(`    Current: ${currentSession.substring(0, 12)}...`);
          }
        } else {
          const percent = Math.round((processed / total) * 100);
          const progress = `  Progress: ${formatNumber(processed)}/${formatNumber(total)} sessions (${percent}%)`;
          if (progress !== lastProgress) {
            process.stdout.write(`\r${progress}`);
            lastProgress = progress;
          }
        }
      },
    });

    // Clear progress line
    if (!options.verbose) {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
    }

    // Print results
    console.log('\n--- Indexing Summary ---');
    console.log(`Total sessions: ${formatNumber(result.totalSessions)}`);
    console.log(`Processed: ${formatNumber(result.processedSessions)}`);
    console.log(`Skipped: ${formatNumber(result.skippedSessions)} (no messages or empty chunks)`);
    console.log(`Total chunks created: ${formatNumber(result.totalChunks)}`);
    console.log(`Errors: ${formatNumber(result.errors)}`);
    console.log(`Duration: ${formatDuration(result.duration)}`);

    // Calculate rate
    if (result.duration > 0) {
      const sessionsPerSec = result.processedSessions / (result.duration / 1000);
      const chunksPerSec = result.totalChunks / (result.duration / 1000);
      console.log(`Rate: ${sessionsPerSec.toFixed(1)} sessions/sec, ${chunksPerSec.toFixed(1)} chunks/sec`);
    }

    // Final stats
    const finalStats = await vectorStore.getStats();
    console.log(`\nFinal vector index: ${formatNumber(finalStats.count)} chunks`);

  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Indexing failed:', error);
  process.exit(1);
});
