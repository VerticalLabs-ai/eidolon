// ---------------------------------------------------------------------------
// Provider API-key resolution with server-level fallback
// ---------------------------------------------------------------------------
//
// Agents may carry a per-agent encrypted API key (apiKeyEncrypted) for their
// configured provider. When an agent has NO per-agent key, the agentic loop
// falls back to the server-level environment variable for that provider so
// agents provisioned without a per-agent key (e.g. via the validation API in
// a shared-key deployment) can still run. This is the production-relevant
// default: a missing per-agent key uses the server default rather than
// failing with "has no API key configured for provider ...".
// ---------------------------------------------------------------------------

/**
 * Map of LLM provider name → the server-level env var holding its API key.
 * Providers not listed here (ollama, local) require no API key.
 */
const PROVIDER_ENV_KEY: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

/**
 * The env var name the server consults for `providerName`, or `undefined` for
 * providers that have no server-level key mapping (e.g. ollama/local).
 */
export function providerEnvKeyName(providerName: string): string | undefined {
  return PROVIDER_ENV_KEY[providerName];
}

/**
 * Return the server-level API key for `providerName` read from the
 * environment, or `undefined` when none is set or the provider has no env
 * mapping.
 */
export function getServerProviderApiKey(providerName: string): string | undefined {
  const envKey = providerEnvKeyName(providerName);
  if (!envKey) return undefined;
  const value = process.env[envKey];
  return value && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the API key to use for an agent: prefer the decrypted per-agent
 * key, falling back to the server-level env var for the provider. Returns
 * `undefined` only when neither source provides a key.
 */
export function resolveProviderApiKey(
  providerName: string,
  perAgentKey: string | undefined,
): string | undefined {
  if (perAgentKey) return perAgentKey;
  return getServerProviderApiKey(providerName);
}
