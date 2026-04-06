// ---------------------------------------------------------------------------
// OpenAI Provider -- Uses the openai SDK
// ---------------------------------------------------------------------------

import OpenAI from 'openai';
import type { AIProvider, ChatMessage, CompletionResult, ProviderConfig, StreamChunk } from './types.js';
import { calculateCostCents } from './cost.js';

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';

  async chat(messages: ChatMessage[], config: ProviderConfig): Promise<CompletionResult> {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    const client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });

    const startMs = Date.now();

    try {
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const latencyMs = Date.now() - startMs;
      const choice = response.choices[0];
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      const costCents = calculateCostCents(this.name, config.model, inputTokens, outputTokens);

      return {
        content: choice?.message?.content ?? '',
        model: response.model,
        provider: this.name,
        inputTokens,
        outputTokens,
        costCents,
        finishReason: choice?.finish_reason ?? 'unknown',
        latencyMs,
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async *chatStream(messages: ChatMessage[], config: ProviderConfig): AsyncIterable<StreamChunk> {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    const client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });

    const startMs = Date.now();
    let fullContent = '';
    let finishReason = 'unknown';
    let model = config.model;

    try {
      const stream = await client.chat.completions.create({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          fullContent += delta.content;
          yield { type: 'text', text: delta.content };
        }

        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        // Usage arrives in the final chunk when stream_options.include_usage = true
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }

      const latencyMs = Date.now() - startMs;
      const costCents = calculateCostCents(this.name, config.model, inputTokens, outputTokens);

      yield {
        type: 'done',
        result: {
          content: fullContent,
          model,
          provider: this.name,
          inputTokens,
          outputTokens,
          costCents,
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
    if (error instanceof OpenAI.APIError) {
      const status = error.status;
      if (status === 401) {
        return new Error('OpenAI authentication failed: invalid API key');
      }
      if (status === 429) {
        return new Error('OpenAI rate limit exceeded. Please retry after a short delay.');
      }
      if (status === 503) {
        return new Error('OpenAI service temporarily unavailable. Please retry later.');
      }
      return new Error(`OpenAI API error (${status}): ${error.message}`);
    }
    if (error instanceof Error) {
      return new Error(`OpenAI provider error: ${error.message}`);
    }
    return new Error(`OpenAI provider error: ${String(error)}`);
  }
}
