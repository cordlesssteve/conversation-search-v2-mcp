#!/usr/bin/env node
/**
 * Vector Indexing Script
 *
 * Index conversation messages into ChromaDB for semantic search.
 * Usage: npm run index-vectors [-- --batch-size 100] [-- --verbose]
 */

import { getDatabase, closeDatabase } from '../database/index.js';
import { MessageRepository } from '../repositories/index.js';
import { EmbeddingService, VectorStore, VectorIndexer } from '../services/index.js';

interface CliOptions {
  batchSize: number;
  verbose: boolean;
  sessionId?: string;
  chromaHost: string;
  ollamaHost: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    batchSize: 100,
    verbose: false,
    chromaHost: 'http://localhost:8000',
    ollamaHost: 'http://localhost:11434',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[++i], 10);
    } else if (arg === '--session' && args[i + 1]) {
      options.sessionId = args[++i];
    } else if (arg === '--chroma-host' && args[i + 1]) {
      options.chromaHost = args[++i];
    } else if (arg === '--ollama-host' && args[i + 1]) {
      options.ollamaHost = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
Vector Indexing Tool - Conversation Search v2

Usage:
  npm run index-vectors [options]

Options:
  --batch-size <n>        Process n messages at a time (default: 100)
  --session <id>          Only index a specific session
  --chroma-host <url>     ChromaDB URL (default: http://localhost:8000)
  --ollama-host <url>     Ollama URL (default: http://localhost:11434)
  --verbose, -v           Show detailed progress
  --help, -h              Show this help message

Prerequisites:
  1. ChromaDB must be running: docker run -p 8000:8000 chromadb/chroma
  2. Ollama must be running with nomic-embed-text: ollama pull nomic-embed-text

Examples:
  npm run index-vectors                    # Index all messages
  npm run index-vectors -- --verbose       # With detailed progress
  npm run index-vectors -- --session abc   # Index specific session
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

  console.log('Vector Indexing Tool - Conversation Search v2');
  console.log('=============================================\n');

  // Initialize services
  console.log('Initializing services...');

  const embeddingService = new EmbeddingService(options.ollamaHost);
  const vectorStore = new VectorStore(
    embeddingService,
    'conversation_messages',
    options.chromaHost
  );

  // Health checks
  console.log('\nHealth checks:');

  const ollamaHealth = await embeddingService.healthCheck();
  if (!ollamaHealth.available) {
    console.error(`  Ollama: FAILED - ${ollamaHealth.error}`);
    console.error('\nPlease ensure Ollama is running: ollama serve');
    process.exit(1);
  }
  console.log(`  Ollama: OK (${options.ollamaHost})`);

  if (!ollamaHealth.model_loaded) {
    console.error(`  Model: FAILED - ${ollamaHealth.error}`);
    console.error('\nPlease pull the model: ollama pull nomic-embed-text');
    process.exit(1);
  }
  console.log('  Model: nomic-embed-text loaded');

  const chromaHealth = await vectorStore.healthCheck();
  if (!chromaHealth.available) {
    console.error(`  ChromaDB: FAILED - ${chromaHealth.error}`);
    console.error('\nPlease ensure ChromaDB is running:');
    console.error('  docker run -p 8000:8000 chromadb/chroma');
    process.exit(1);
  }
  console.log(`  ChromaDB: OK (${options.chromaHost})`);

  // Initialize vector store
  await vectorStore.initialize();
  console.log('  Collection: initialized');

  // Get current stats
  const vectorStats = await vectorStore.getStats();
  console.log(`\nCurrent vector index: ${formatNumber(vectorStats.count)} documents`);

  // Initialize database
  const db = getDatabase();
  const messageRepo = new MessageRepository(db);

  const totalMessages = messageRepo.count();
  console.log(`Total messages in SQLite: ${formatNumber(totalMessages)}`);

  // Create indexer
  const indexer = new VectorIndexer(messageRepo, vectorStore);

  try {
    console.log('\nIndexing messages...\n');

    let lastProgress = '';
    const result = options.sessionId
      ? await indexer.indexSession(options.sessionId)
      : await indexer.indexAll({
          batchSize: options.batchSize,
          onProgress: (indexed, total) => {
            if (options.verbose) {
              console.log(`  Processed ${formatNumber(indexed)} / ${formatNumber(total)}`);
            } else {
              const percent = Math.round((indexed / total) * 100);
              const progress = `  Progress: ${formatNumber(indexed)}/${formatNumber(total)} (${percent}%)`;
              if (progress !== lastProgress) {
                process.stdout.write(`\r${progress}`);
                lastProgress = progress;
              }
            }
          },
        });

    // Clear progress line
    if (!options.verbose) {
      process.stdout.write('\r' + ' '.repeat(50) + '\r');
    }

    // Print results
    console.log('\n--- Indexing Summary ---');
    console.log(`Total messages: ${formatNumber(result.totalMessages)}`);
    console.log(`Indexed: ${formatNumber(result.indexed)}`);
    console.log(`Skipped: ${formatNumber(result.skipped)} (too short, wrong role, or already indexed)`);
    console.log(`Chunks created: ${formatNumber(result.chunks)}`);
    console.log(`Errors: ${formatNumber(result.errors)}`);
    console.log(`Duration: ${formatDuration(result.duration)}`);

    // Final stats
    const finalStats = await vectorStore.getStats();
    console.log(`\nFinal vector index: ${formatNumber(finalStats.count)} documents`);

  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Indexing failed:', error);
  process.exit(1);
});
