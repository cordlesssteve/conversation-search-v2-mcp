/**
 * Chunk Manager for Conversation Processing
 *
 * Converts conversations into semantically meaningful chunks for vector search.
 * Key features:
 * - Message pairing: User question + Assistant response kept together
 * - Topic detection: Groups related pairs by detected keywords
 * - Adjacency links: previous_chunk / next_chunk for context retrieval
 * - Smart truncation: Preserves readability at sentence boundaries
 *
 * Ported from conversation-search v1 with adaptations for v2 data model.
 */

import type { Message, Session } from '../types/models.js';

/**
 * A conversation chunk optimized for semantic search.
 */
export interface ConversationChunk {
  chunk_id: string;
  session_id: string;
  sequence_number: number;
  chunk_type: 'message_pair' | 'topic_group';
  content: string;

  // Original message content (for display)
  user_message?: string;
  assistant_message?: string;

  // Timestamps
  timestamp: string;
  processing_date: string;

  // Context
  project_path?: string;
  message_count: number;

  // Adjacency links for context expansion
  previous_chunk?: string;
  next_chunk?: string;

  // Topic metadata
  topic_group?: string;

  // Will be set during embedding
  token_count: number;
}

interface MessagePair {
  userMessage?: Message;
  assistantMessage?: Message;
  timestamp: string;
}

interface TopicGroup {
  topic: string;
  pairs: MessagePair[];
}

export class ChunkManager {
  /**
   * Process a session's messages into searchable chunks.
   */
  processSession(session: Session, messages: Message[]): ConversationChunk[] {
    const chunks: ConversationChunk[] = [];

    // Filter out system messages
    const conversationMessages = messages.filter(m => m.role !== 'system');

    if (conversationMessages.length === 0) {
      return chunks;
    }

    // Step 1: Create message pairs (user question + assistant response)
    const messagePairs = this.createMessagePairs(conversationMessages);

    // Step 2: Detect topic boundaries and group related pairs
    const topicGroups = this.detectTopicGroups(messagePairs);

    // Step 3: Create chunks with adjacency relationships
    let sequenceNumber = 0;

    for (const group of topicGroups) {
      for (let i = 0; i < group.pairs.length; i++) {
        const pair = group.pairs[i];
        sequenceNumber++;

        const chunkId = `conv_${session.id}_pair_${sequenceNumber}`;
        const prevChunkId =
          sequenceNumber > 1
            ? `conv_${session.id}_pair_${sequenceNumber - 1}`
            : undefined;
        const nextChunkId =
          i < group.pairs.length - 1 ||
          group !== topicGroups[topicGroups.length - 1]
            ? `conv_${session.id}_pair_${sequenceNumber + 1}`
            : undefined;

        // Combine user message and assistant response with context
        const content = this.formatChunkContent(pair, group.topic);

        const chunk: ConversationChunk = {
          chunk_id: chunkId,
          session_id: session.id,
          sequence_number: sequenceNumber,
          chunk_type: 'message_pair',
          content,
          user_message: pair.userMessage?.content,
          assistant_message: pair.assistantMessage?.content,
          timestamp: pair.timestamp,
          project_path: session.project_path || undefined,
          message_count:
            (pair.userMessage ? 1 : 0) + (pair.assistantMessage ? 1 : 0),
          previous_chunk: prevChunkId,
          next_chunk: nextChunkId,
          topic_group: group.topic,
          token_count: 0, // Will be set during embedding
          processing_date: new Date().toISOString(),
        };

        chunks.push(chunk);
      }
    }

    return chunks;
  }

  /**
   * Create message pairs from conversation messages.
   * Pairs user questions with their assistant responses.
   */
  private createMessagePairs(messages: Message[]): MessagePair[] {
    const pairs: MessagePair[] = [];

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      if (message.role === 'user') {
        // Look for corresponding assistant response
        const nextMessage = messages[i + 1];
        const assistantResponse =
          nextMessage && nextMessage.role === 'assistant'
            ? nextMessage
            : undefined;

        pairs.push({
          userMessage: message,
          assistantMessage: assistantResponse,
          timestamp: assistantResponse?.timestamp || message.timestamp,
        });

        // Skip the assistant message if we paired it
        if (assistantResponse) i++;
      } else if (message.role === 'assistant') {
        // Standalone assistant message (no preceding user message)
        pairs.push({
          assistantMessage: message,
          timestamp: message.timestamp,
        });
      }
    }

    return pairs;
  }

  /**
   * Detect topic groups using keyword extraction and time gaps.
   * Groups consecutive related pairs together.
   */
  private detectTopicGroups(pairs: MessagePair[]): TopicGroup[] {
    if (pairs.length === 0) return [];

    const groups: TopicGroup[] = [];

    let currentGroup: TopicGroup = {
      topic: this.extractTopic(pairs[0]),
      pairs: [pairs[0]],
    };

    for (let i = 1; i < pairs.length; i++) {
      const pair = pairs[i];
      const pairTopic = this.extractTopic(pair);

      // Detect topic boundary:
      // - Time gap > 30 minutes, OR
      // - Topic keyword changes significantly
      const timeGap = this.getTimeGapMinutes(
        currentGroup.pairs[currentGroup.pairs.length - 1].timestamp,
        pair.timestamp
      );

      const topicSimilar = this.isTopicSimilar(currentGroup.topic, pairTopic);

      if (timeGap > 30 || !topicSimilar) {
        // Start new topic group
        groups.push(currentGroup);
        currentGroup = {
          topic: pairTopic,
          pairs: [pair],
        };
      } else {
        // Continue current group
        currentGroup.pairs.push(pair);
      }
    }

    groups.push(currentGroup);
    return groups;
  }

  /**
   * Extract topic from message pair using keyword matching.
   */
  private extractTopic(pair: MessagePair): string {
    const text =
      (pair.userMessage?.content || '') +
      ' ' +
      (pair.assistantMessage?.content || '');

    // Look for technical keywords
    const keywords = text.toLowerCase().match(
      /\b(?:react|database|git|typescript|python|api|server|component|function|error|bug|feature|implement|create|build|fix|test|optimization|performance|security|authentication|deployment|docker|npm|package|library|framework|mcp|claude|hook|skill|command|vector|embedding|search|index|sqlite|chromadb)\b/g
    );

    if (keywords && keywords.length > 0) {
      // Return most frequent keyword as topic
      const keywordCounts = keywords.reduce(
        (acc, keyword) => {
          acc[keyword] = (acc[keyword] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      const topKeyword = Object.entries(keywordCounts).sort(
        ([, a], [, b]) => b - a
      )[0][0];

      return topKeyword;
    }

    return 'general';
  }

  /**
   * Check if two topics are similar (same or related).
   */
  private isTopicSimilar(topic1: string, topic2: string): boolean {
    if (topic1 === topic2) return true;

    // Related topic groups
    const topicGroups = [
      ['react', 'component', 'typescript', 'javascript'],
      ['database', 'sqlite', 'sql', 'query', 'chromadb'],
      ['git', 'commit', 'branch', 'repository'],
      ['server', 'api', 'endpoint', 'http'],
      ['test', 'testing', 'jest', 'spec'],
      ['deployment', 'docker', 'container', 'build'],
      ['mcp', 'claude', 'hook', 'skill', 'command'],
      ['vector', 'embedding', 'search', 'index'],
    ];

    for (const group of topicGroups) {
      if (group.includes(topic1) && group.includes(topic2)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate time gap between timestamps in minutes.
   */
  private getTimeGapMinutes(timestamp1: string, timestamp2: string): number {
    const time1 = new Date(timestamp1).getTime();
    const time2 = new Date(timestamp2).getTime();
    return Math.abs(time2 - time1) / (1000 * 60);
  }

  /**
   * Format chunk content for embedding.
   * Includes topic prefix and both messages.
   */
  private formatChunkContent(pair: MessagePair, topic: string): string {
    const maxChunkChars = 20000; // ~6,700 tokens (conservative for Nomic's 8192 limit)

    let content = `Topic: ${topic}\n\n`;

    if (pair.userMessage) {
      const userContent = this.truncateIfNeeded(
        pair.userMessage.content,
        10000
      );
      content += `User: ${userContent}\n\n`;
    }

    if (pair.assistantMessage) {
      const assistantContent = this.truncateIfNeeded(
        pair.assistantMessage.content,
        10000
      );
      content += `Assistant: ${assistantContent}`;
    }

    // Final safety check on total chunk size
    if (content.length > maxChunkChars) {
      content = content.substring(0, maxChunkChars) + '...[truncated]';
    }

    return content.trim();
  }

  /**
   * Truncate text if it exceeds limit, preserving readability.
   */
  private truncateIfNeeded(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;

    // Try to truncate at a sentence boundary
    const truncated = text.substring(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');

    // Use the last period or newline for a cleaner break
    const cutPoint = Math.max(lastPeriod, lastNewline);
    if (cutPoint > maxChars * 0.8) {
      return truncated.substring(0, cutPoint + 1) + '...[truncated]';
    }

    return truncated + '...[truncated]';
  }

  /**
   * Get adjacent chunks for context expansion.
   */
  getAdjacentChunks(
    chunks: ConversationChunk[],
    targetChunkId: string,
    context: number = 2
  ): ConversationChunk[] {
    const targetIndex = chunks.findIndex(
      (chunk) => chunk.chunk_id === targetChunkId
    );
    if (targetIndex === -1) return [];

    const start = Math.max(0, targetIndex - context);
    const end = Math.min(chunks.length, targetIndex + context + 1);

    return chunks.slice(start, end);
  }
}
