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

export interface ServerAdapterCapabilities {
  /** Adapter supports token-by-token streaming via chatStream(). */
  streaming: boolean;
  /** Native function / tool calling. */
  tools: boolean;
  /** Accepts image inputs alongside text. */
  vision: boolean;
  /** Supports extended thinking / reasoning-effort knobs. */
  reasoning: boolean;
  /** Native JSON / structured output mode. */
  jsonMode: boolean;
  /** Honors a separate system prompt (vs. prepending to user turn). */
  systemPrompt: boolean;
  /** Reports usage tokens AND has a price entry in TOKEN_COSTS_PER_MILLION. */
  costTracking: boolean;
  /** API key is required before the adapter will complete a call. */
  requiresApiKey: boolean;
  /** Runs locally — no network egress to a third-party provider. */
  local: boolean;
}

export interface AdapterModel {
  id: string;
  label: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /** Per-model overrides that layer on top of adapter-level capabilities. */
  capabilitiesOverride?: Partial<ServerAdapterCapabilities>;
}

export interface AIProvider {
  readonly name: string;
  chat(messages: ChatMessage[], config: ProviderConfig): Promise<CompletionResult>;
  chatStream(messages: ChatMessage[], config: ProviderConfig): AsyncIterable<StreamChunk>;
}

/**
 * ServerAdapter is the canonical shape for anything the platform can invoke as
 * an agent runtime. Paperclip ships parallel adapters (claude-local,
 * codex-local, openclaw-gateway, …); Eidolon's first-party adapters are the AI
 * providers in this directory. The extra metadata lets UI and orchestration
 * introspect what each runtime can actually do before dispatch.
 */
export interface ServerAdapter extends AIProvider {
  readonly capabilities: ServerAdapterCapabilities;
  readonly models: AdapterModel[];
}
