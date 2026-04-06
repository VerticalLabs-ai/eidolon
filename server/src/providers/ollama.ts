// ---------------------------------------------------------------------------
// Ollama Provider -- Direct fetch to local Ollama API
// ---------------------------------------------------------------------------

import type { AIProvider, ChatMessage, CompletionResult, ProviderConfig, StreamChunk } from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';

  async chat(messages: ChatMessage[], config: ProviderConfig): Promise<CompletionResult> {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/api/chat`;

    const startMs = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
          options: {
            temperature: config.temperature ?? 0.7,
            ...(config.maxTokens ? { num_predict: config.maxTokens } : {}),
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${errorBody}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const latencyMs = Date.now() - startMs;

      return {
        content: data.message?.content ?? '',
        model: data.model ?? config.model,
        provider: this.name,
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        costCents: 0, // Local models are free
        finishReason: data.done_reason ?? (data.done ? 'stop' : 'unknown'),
        latencyMs,
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async *chatStream(messages: ChatMessage[], config: ProviderConfig): AsyncIterable<StreamChunk> {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/api/chat`;

    const startMs = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: true,
          options: {
            temperature: config.temperature ?? 0.7,
            ...(config.maxTokens ? { num_predict: config.maxTokens } : {}),
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Ollama API error (${response.status}): ${errorBody}`);
      }

      if (!response.body) {
        throw new Error('Ollama streaming response has no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = 'unknown';
      let model = config.model;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Ollama streams newline-delimited JSON
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const chunk = JSON.parse(trimmed) as OllamaChatResponse;
            model = chunk.model ?? model;

            if (chunk.message?.content) {
              fullContent += chunk.message.content;
              yield { type: 'text', text: chunk.message.content };
            }

            if (chunk.done) {
              finishReason = chunk.done_reason ?? 'stop';
              inputTokens = chunk.prompt_eval_count ?? inputTokens;
              outputTokens = chunk.eval_count ?? outputTokens;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      const latencyMs = Date.now() - startMs;

      yield {
        type: 'done',
        result: {
          content: fullContent,
          model,
          provider: this.name,
          inputTokens,
          outputTokens,
          costCents: 0,
          finishReason,
          latencyMs,
        },
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private wrapError(error: unknown): Error {
    if (error instanceof Error) {
      if (error.message.startsWith('Ollama')) return error;
      // Common case: Ollama is not running
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        return new Error(
          'Ollama connection refused. Is the Ollama server running? Start it with: ollama serve',
        );
      }
      return new Error(`Ollama provider error: ${error.message}`);
    }
    return new Error(`Ollama provider error: ${String(error)}`);
  }
}
