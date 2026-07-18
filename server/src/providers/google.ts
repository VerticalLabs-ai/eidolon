// ---------------------------------------------------------------------------
// Google Gemini Provider -- Direct fetch to the Generative Language API
// ---------------------------------------------------------------------------

import type {
  AdapterModel,
  ChatMessage,
  CompletionResult,
  ModelDiscoveryConfig,
  ProviderConfig,
  ServerAdapter,
  ServerAdapterCapabilities,
  StreamChunk,
} from './types.js';
import { calculateCostCents } from './cost.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GeminiCandidate {
  content: { parts: Array<{ text: string }>; role: string };
  finishReason: string;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion?: string;
}

export class GoogleProvider implements ServerAdapter {
  readonly name = 'google';
  readonly id = 'provider:google';
  readonly kind = 'provider' as const;
  readonly locality = 'cloud' as const;
  readonly supportedModes = ['on_demand', 'scheduled'] as const;
  readonly description = 'Cloud Google Gemini runtime.';

  readonly capabilities: ServerAdapterCapabilities = {
    runtime: true,
    streaming: true,
    tools: true,
    mcp: false,
    skills: false,
    vision: true,
    browser: false,
    voice: false,
    shell: false,
    filesystem: false,
    reasoning: false,
    jsonMode: true,
    systemPrompt: true,
    costTracking: true,
    requiresApiKey: true,
    local: false,
    sessionResume: false,
    energyTelemetry: false,
  };

  readonly models: AdapterModel[] = [
    {
      id: 'gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro',
      maxContextTokens: 2_000_000,
      maxOutputTokens: 64_000,
    },
    {
      id: 'gemini-3-flash-preview',
      label: 'Gemini 3.0 Flash',
      maxContextTokens: 1_000_000,
      maxOutputTokens: 64_000,
    },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', maxContextTokens: 2_000_000, maxOutputTokens: 64_000 },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', maxContextTokens: 1_000_000, maxOutputTokens: 64_000 },
  ];

  async discoverModels(config: ModelDiscoveryConfig): Promise<AdapterModel[]> {
    if (!config.authorization) {
      throw new Error('Google API key is required to refresh models');
    }

    const signal = AbortSignal.timeout(config.timeoutMs ?? 10_000);
    const models: AdapterModel[] = [];
    let pageCursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      const url = new URL(`${DEFAULT_BASE_URL}/models`);
      url.searchParams.set('pageSize', '1000');
      if (pageCursor) {
        url.searchParams.set('pageToken', pageCursor);
      }

      const response = await fetch(url, {
        headers: { 'x-goog-api-key': config.authorization },
        signal,
      });

      if (!response.ok) {
        throw new Error(`Google model discovery failed with HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        models?: Array<{
          name?: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
        }>;
        nextPageToken?: string;
      };

      models.push(
        ...(data.models ?? [])
          .filter(
            (model): model is {
              name: string;
              displayName?: string;
              supportedGenerationMethods?: string[];
            } =>
              typeof model.name === 'string' &&
              (model.supportedGenerationMethods ?? []).includes('generateContent'),
          )
          .map((model) => {
            const id = model.name.replace(/^models\//, '');
            return { id, label: model.displayName ?? id };
          }),
      );

      const nextCursor = data.nextPageToken;
      if (!nextCursor) {
        return models;
      }
      if (nextCursor === pageCursor) {
        throw new Error('Google model discovery returned an invalid page token');
      }
      pageCursor = nextCursor;
    }

    throw new Error('Google model discovery exceeded the pagination limit');
  }

  async chat(messages: ChatMessage[], config: ProviderConfig): Promise<CompletionResult> {
    if (!config.apiKey) {
      throw new Error('Google API key is required');
    }

    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const { systemInstruction, contents } = this.buildGeminiPayload(messages);

    const url = `${baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`;
    const startMs = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemInstruction ? { systemInstruction } : {}),
          contents,
          generationConfig: {
            temperature: config.temperature ?? 0.7,
            maxOutputTokens: config.maxTokens ?? 4096,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Google Gemini API error (${response.status}): ${errorBody}`);
      }

      const data = (await response.json()) as GeminiResponse;
      const latencyMs = Date.now() - startMs;

      const candidate = data.candidates?.[0];
      const content = candidate?.content?.parts?.map((p) => p.text).join('') ?? '';
      const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
      const costCents = calculateCostCents(this.name, config.model, inputTokens, outputTokens);

      return {
        content,
        model: data.modelVersion ?? config.model,
        provider: this.name,
        inputTokens,
        outputTokens,
        costCents,
        finishReason: candidate?.finishReason ?? 'unknown',
        latencyMs,
      };
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async *chatStream(messages: ChatMessage[], config: ProviderConfig): AsyncIterable<StreamChunk> {
    if (!config.apiKey) {
      throw new Error('Google API key is required');
    }

    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const { systemInstruction, contents } = this.buildGeminiPayload(messages);

    const url = `${baseUrl}/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;
    const startMs = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemInstruction ? { systemInstruction } : {}),
          contents,
          generationConfig: {
            temperature: config.temperature ?? 0.7,
            maxOutputTokens: config.maxTokens ?? 4096,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Google Gemini API error (${response.status}): ${errorBody}`);
      }

      if (!response.body) {
        throw new Error('Google Gemini streaming response has no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = 'unknown';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from the buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(jsonStr) as GeminiResponse;
            const candidate = chunk.candidates?.[0];
            const text = candidate?.content?.parts?.map((p) => p.text).join('') ?? '';

            if (text) {
              fullContent += text;
              yield { type: 'text', text };
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }

            if (chunk.usageMetadata) {
              inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
              outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
            }
          } catch {
            // Skip malformed JSON lines in stream
          }
        }
      }

      const latencyMs = Date.now() - startMs;
      const costCents = calculateCostCents(this.name, config.model, inputTokens, outputTokens);

      yield {
        type: 'done',
        result: {
          content: fullContent,
          model: config.model,
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

  private buildGeminiPayload(messages: ChatMessage[]): {
    systemInstruction: { parts: Array<{ text: string }> } | undefined;
    contents: GeminiContent[];
  } {
    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return {
      systemInstruction:
        systemParts.length > 0
          ? { parts: [{ text: systemParts.join('\n\n') }] }
          : undefined,
      contents,
    };
  }

  private wrapError(error: unknown): Error {
    if (error instanceof Error) {
      // Already wrapped
      if (error.message.startsWith('Google Gemini')) return error;
      return new Error(`Google provider error: ${error.message}`);
    }
    return new Error(`Google provider error: ${String(error)}`);
  }
}
