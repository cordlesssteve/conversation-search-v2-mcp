/**
 * Embedding Service
 *
 * Generates embeddings using Nomic via Ollama.
 * Nomic-embed-text produces 768-dimensional embeddings.
 */

export interface EmbeddingResult {
  embedding: number[];
  token_count: number;
}

export class EmbeddingService {
  private baseUrl: string;
  private model: string;

  constructor(
    baseUrl: string = 'http://localhost:11434',
    model: string = 'nomic-embed-text'
  ) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.statusText}`);
    }

    const data = await response.json() as { embedding: number[] };

    return {
      embedding: data.embedding,
      token_count: this.estimateTokens(text),
    };
  }

  /**
   * Generate embeddings for multiple texts in batch.
   * Uses concurrent requests for better GPU utilization.
   */
  async embedBatch(texts: string[], concurrency: number = 50): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = new Array(texts.length);
    const queue = texts.map((text, index) => ({ text, index }));
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const idx = cursor++;
        if (idx >= queue.length) break;
        const { text, index } = queue[idx];
        try {
          results[index] = await this.embed(text);
        } catch (error) {
          // On error, create a zero embedding to avoid breaking the batch
          console.error(`Embedding failed for text ${index}:`, error);
          results[index] = { embedding: new Array(768).fill(0), token_count: 0 };
        }
      }
    };

    // Launch concurrent workers
    const workers = Array(Math.min(concurrency, texts.length))
      .fill(null)
      .map(() => worker());

    await Promise.all(workers);
    return results;
  }

  /**
   * Estimate token count for text.
   * Rough approximation: ~4 characters per token.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Check if Ollama is available and model is loaded.
   */
  async healthCheck(): Promise<{ available: boolean; model_loaded: boolean; error?: string }> {
    try {
      // Check if Ollama is running
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return { available: false, model_loaded: false, error: 'Ollama not responding' };
      }

      const data = await response.json() as { models: Array<{ name: string }> };
      const models = data.models || [];
      const modelLoaded = models.some(m => m.name.includes(this.model));

      return {
        available: true,
        model_loaded: modelLoaded,
        error: modelLoaded ? undefined : `Model ${this.model} not loaded. Run: ollama pull ${this.model}`,
      };
    } catch (error) {
      return {
        available: false,
        model_loaded: false,
        error: `Cannot connect to Ollama at ${this.baseUrl}`,
      };
    }
  }
}
