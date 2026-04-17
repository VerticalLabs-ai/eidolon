// ---------------------------------------------------------------------------
// Anthropic Provider -- Uses @anthropic-ai/sdk
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import type {
  AdapterModel,
  ChatMessage,
  CompletionResult,
  ProviderConfig,
  ServerAdapter,
  ServerAdapterCapabilities,
  StreamChunk,
} from './types.js';
import { calculateCostCents } from './cost.js';
import logger from '../utils/logger.js';

export class AnthropicProvider implements ServerAdapter {
  readonly name = 'anthropic';

  readonly capabilities: ServerAdapterCapabilities = {
    streaming: true,
    tools: true,
    vision: true,
    reasoning: true,
    jsonMode: false,
    systemPrompt: true,
    costTracking: true,
    requiresApiKey: true,
    local: false,
  };

  readonly models: AdapterModel[] = [
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', maxContextTokens: 200_000, maxOutputTokens: 32_000 },
    {
      id: 'claude-opus-4-7-1m',
      label: 'Claude Opus 4.7 (1M context)',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 32_000,
    },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', maxContextTokens: 200_000, maxOutputTokens: 32_000 },
    {
      id: 'claude-haiku-4-5-20251001',
      label: 'Claude Haiku 4.5',
      maxContextTokens: 200_000,
      maxOutputTokens: 16_000,
    },
  ];

  async chat(messages: ChatMessage[], config: ProviderConfig): Promise<CompletionResult> {
    if (!config.apiKey) {
      throw new Error('Anthropic API key is required');
    }

    const client = new Anthropic({ apiKey: config.apiKey });
    const { systemMessage, userMessages } = this.separateSystemMessage(messages);

    const startMs = Date.now();

    try {
      const response = await client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        ...(systemMessage ? { system: systemMessage } : {}),
        messages: userMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      const latencyMs = Date.now() - startMs;
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const costCents = calculateCostCents(this.name, config.model, inputTokens, outputTokens);

      const textContent = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        content: textContent,
        model: response.model,
        provider: this.name,
        inputTokens,
        outputTokens,
        costCents,
        finishReason: response.stop_reason ?? 'unknown',
        latencyMs,
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async *chatStream(messages: ChatMessage[], config: ProviderConfig): AsyncIterable<StreamChunk> {
    if (!config.apiKey) {
      throw new Error('Anthropic API key is required');
    }

    const client = new Anthropic({ apiKey: config.apiKey });
    const { systemMessage, userMessages } = this.separateSystemMessage(messages);

    const startMs = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'unknown';
    let model = config.model;
    let fullContent = '';

    try {
      const stream = client.messages.stream({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        ...(systemMessage ? { system: systemMessage } : {}),
        messages: userMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullContent += event.delta.text;
          yield { type: 'text', text: event.delta.text };
        } else if (event.type === 'message_start' && event.message) {
          model = event.message.model;
          inputTokens = event.message.usage?.input_tokens ?? 0;
        } else if (event.type === 'message_delta') {
          const delta = event as any;
          outputTokens = delta.usage?.output_tokens ?? outputTokens;
          finishReason = delta.delta?.stop_reason ?? finishReason;
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

  private separateSystemMessage(messages: ChatMessage[]): {
    systemMessage: string | undefined;
    userMessages: ChatMessage[];
  } {
    const systemParts: string[] = [];
    const userMessages: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      } else {
        userMessages.push(msg);
      }
    }

    return {
      systemMessage: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
      userMessages,
    };
  }

  private wrapError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      const status = error.status;
      if (status === 401) {
        return new Error(`Anthropic authentication failed: invalid API key`);
      }
      if (status === 429) {
        return new Error(`Anthropic rate limit exceeded. Please retry after a short delay.`);
      }
      if (status === 529) {
        return new Error(`Anthropic API overloaded. Please retry later.`);
      }
      return new Error(`Anthropic API error (${status}): ${error.message}`);
    }
    if (error instanceof Error) {
      return new Error(`Anthropic provider error: ${error.message}`);
    }
    return new Error(`Anthropic provider error: ${String(error)}`);
  }
}
