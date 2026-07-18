// ---------------------------------------------------------------------------
// AI Provider / ServerAdapter Registry
// ---------------------------------------------------------------------------

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import type {
  AIProvider,
  ServerAdapter,
  ServerAdapterCapabilities,
  ServerAdapterDescriptor,
} from './types.js';

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

function descriptorFromAdapter(adapter: ServerAdapter): ServerAdapterDescriptor {
  return {
    id: adapter.id ?? `provider:${adapter.name}`,
    name: adapter.name,
    kind: adapter.kind ?? 'provider',
    locality: adapter.locality ?? (adapter.capabilities.local ? 'local' : 'cloud'),
    description: adapter.description ?? `${adapter.name} provider runtime`,
    supportedModes: adapter.supportedModes ?? ['on_demand'],
    capabilities: adapter.capabilities,
    models: adapter.models,
  };
}

const baseRuntimeCapabilities: ServerAdapterCapabilities = {
  runtime: true,
  streaming: true,
  tools: true,
  mcp: true,
  skills: true,
  vision: false,
  browser: false,
  voice: false,
  shell: false,
  filesystem: false,
  reasoning: true,
  jsonMode: true,
  systemPrompt: true,
  costTracking: false,
  requiresApiKey: false,
  local: true,
  sessionResume: true,
  energyTelemetry: false,
};

const runtimeOnlyAdapters: ServerAdapterDescriptor[] = [
  {
    id: 'codex_local',
    name: 'Codex Local',
    kind: 'process',
    locality: 'local',
    description: 'Runs the Codex CLI for platform operators through a required external sandbox, with structured transcripts and resumable sessions.',
    supportedModes: ['on_demand', 'scheduled'],
    capabilities: {
      ...baseRuntimeCapabilities,
      shell: true,
      filesystem: true,
      browser: false,
    },
    models: [{ id: 'codex-default', label: 'Codex CLI default' }],
  },
  {
    id: 'claude_local',
    name: 'Claude Local',
    kind: 'process',
    locality: 'local',
    description: 'Runs Claude Code for platform operators through a required external sandbox, with stream-JSON transcripts and resumable sessions.',
    supportedModes: ['on_demand', 'scheduled'],
    capabilities: {
      ...baseRuntimeCapabilities,
      shell: true,
      filesystem: true,
      browser: false,
    },
    models: [{ id: 'claude-default', label: 'Claude Code default' }],
  },
  {
    id: 'process:local',
    name: 'process',
    kind: 'process',
    locality: 'local',
    description: 'Generic local process adapter for CLI agents such as Codex, Claude Code, Cursor, Gemini, or custom shells.',
    supportedModes: ['on_demand', 'scheduled', 'continuous'],
    capabilities: {
      ...baseRuntimeCapabilities,
      shell: true,
      filesystem: true,
      sessionResume: false,
    },
    models: [{ id: 'process-command', label: 'Process command' }],
  },
  {
    id: 'http:remote',
    name: 'http',
    kind: 'http',
    locality: 'hybrid',
    description: 'Generic HTTP adapter for webhooked or remotely hosted agent runtimes.',
    supportedModes: ['on_demand', 'scheduled'],
    capabilities: {
      ...baseRuntimeCapabilities,
      streaming: false,
      local: false,
      shell: false,
      filesystem: false,
      sessionResume: false,
    },
    models: [{ id: 'http-endpoint', label: 'HTTP endpoint' }],
  },
  {
    id: 'openclaw:webhook',
    name: 'OpenClaw Webhook',
    kind: 'http',
    locality: 'hybrid',
    description: 'Wakes an OpenClaw agent through its authenticated HTTP hook with the required message, agent, and delivery fields.',
    supportedModes: ['on_demand', 'scheduled'],
    capabilities: {
      ...baseRuntimeCapabilities,
      streaming: false,
      local: false,
      browser: true,
      voice: true,
      shell: false,
      filesystem: false,
      sessionResume: false,
    },
    models: [{ id: 'openclaw-agent', label: 'OpenClaw agent' }],
  },
  {
    id: 'mcp:tool-runtime',
    name: 'mcp',
    kind: 'mcp',
    locality: 'hybrid',
    description: 'MCP-backed runtime that dispatches work through a configured MCP server and tool.',
    supportedModes: ['on_demand', 'scheduled'],
    capabilities: {
      ...baseRuntimeCapabilities,
      local: false,
      shell: false,
      filesystem: false,
    },
    models: [{ id: 'mcp-tool', label: 'MCP tool' }],
  },
  {
    id: 'openjarvis:local',
    name: 'openjarvis-local',
    kind: 'openjarvis-local',
    locality: 'local',
    description: 'Local-first OpenJarvis runtime for daily briefing, deep research, scheduled monitor, and code assistant presets.',
    supportedModes: ['on_demand', 'scheduled', 'continuous'],
    capabilities: {
      ...baseRuntimeCapabilities,
      browser: true,
      voice: true,
      shell: true,
      filesystem: true,
      energyTelemetry: true,
    },
    models: [
      { id: 'chat-simple', label: 'OpenJarvis Chat Simple' },
      { id: 'morning-digest', label: 'OpenJarvis Morning Digest' },
      { id: 'deep-research', label: 'OpenJarvis Deep Research' },
      { id: 'scheduled-monitor', label: 'OpenJarvis Scheduled Monitor' },
      { id: 'code-assistant', label: 'OpenJarvis Code Assistant' },
    ],
  },
];

export function listRuntimeAdapterDescriptors(): ServerAdapterDescriptor[] {
  const providerDescriptors = listAdapters().map(descriptorFromAdapter);
  return [...providerDescriptors, ...runtimeOnlyAdapters];
}

export * from './types.js';
export { calculateCostCents } from './cost.js';
