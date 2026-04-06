// ---------------------------------------------------------------------------
// AI Provider Registry
// ---------------------------------------------------------------------------

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import type { AIProvider } from './types.js';

const providers = new Map<string, AIProvider>([
  ['anthropic', new AnthropicProvider()],
  ['openai', new OpenAIProvider()],
  ['google', new GoogleProvider()],
  ['ollama', new OllamaProvider()],
  // "local" is an alias for ollama
  ['local', new OllamaProvider()],
]);

/**
 * Get an AI provider by name.
 * Throws if the provider is not registered.
 */
export function getProvider(name: string): AIProvider {
  const provider = providers.get(name);
  if (!provider) {
    const available = Array.from(providers.keys()).join(', ');
    throw new Error(`Unknown AI provider: "${name}". Available providers: ${available}`);
  }
  return provider;
}

/**
 * List all registered provider names.
 */
export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export * from './types.js';
export { calculateCostCents } from './cost.js';
