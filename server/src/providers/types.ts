// ---------------------------------------------------------------------------
// AI Provider Abstraction Layer -- Type Definitions
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResult {
  content: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  finishReason: string;
  latencyMs: number;
}

export interface StreamChunk {
  type: 'text' | 'done';
  text?: string;
  result?: CompletionResult;
}

export interface AIProvider {
  readonly name: string;
  chat(messages: ChatMessage[], config: ProviderConfig): Promise<CompletionResult>;
  chatStream(messages: ChatMessage[], config: ProviderConfig): AsyncIterable<StreamChunk>;
}
