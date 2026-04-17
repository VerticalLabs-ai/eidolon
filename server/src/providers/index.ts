// ---------------------------------------------------------------------------
// AI Provider / ServerAdapter Registry
// ---------------------------------------------------------------------------

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import type { AIProvider, ServerAdapter } from './types.js';

const ollama = new OllamaProvider();

const adapters = new Map<string, ServerAdapter>([
  ['anthropic', new AnthropicProvider()],
  ['openai', new OpenAIProvider()],
  ['google', new GoogleProvider()],
  ['ollama', ollama],
  // "local" is a canonical alias for ollama until we add more local runtimes
  ['local', ollama],
]);

/**
 * Get an AI provider (legacy alias) by name. Returns the full ServerAdapter
 * instance — the narrower AIProvider type is preserved for back-compat with
 * existing call sites.
 */
export function getProvider(name: string): AIProvider {
  return getAdapter(name);
}

export function getAdapter(name: string): ServerAdapter {
  const adapter = adapters.get(name);
  if (!adapter) {
    const available = Array.from(adapters.keys()).join(', ');
    throw new Error(`Unknown adapter: "${name}". Available: ${available}`);
  }
  return adapter;
}

/**
 * List all registered adapter names (includes aliases like "local").
 */
export function listProviders(): string[] {
  return Array.from(adapters.keys());
}

/**
 * List all registered adapters with their capability metadata. Primary
 * identity is deduplicated so "local" (alias for ollama) doesn't appear twice
 * in the returned set.
 */
export function listAdapters(): ServerAdapter[] {
  const seen = new Set<string>();
  const out: ServerAdapter[] = [];
  for (const adapter of adapters.values()) {
    if (seen.has(adapter.name)) continue;
    seen.add(adapter.name);
    out.push(adapter);
  }
  return out;
}

export * from './types.js';
export { calculateCostCents } from './cost.js';
