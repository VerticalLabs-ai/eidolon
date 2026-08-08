import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  getServerProviderApiKey,
  providerEnvKeyName,
  resolveProviderApiKey,
} from './provider-key.js';

describe('provider-key resolution', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'server-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'server-openai-key');
    vi.stubEnv('GOOGLE_API_KEY', 'server-google-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('providerEnvKeyName', () => {
    it('maps each cloud provider to its server-level env var', () => {
      expect(providerEnvKeyName('anthropic')).toBe('ANTHROPIC_API_KEY');
      expect(providerEnvKeyName('openai')).toBe('OPENAI_API_KEY');
      expect(providerEnvKeyName('google')).toBe('GOOGLE_API_KEY');
    });

    it('returns undefined for keyless/local providers', () => {
      expect(providerEnvKeyName('ollama')).toBeUndefined();
      expect(providerEnvKeyName('local')).toBeUndefined();
    });
  });

  describe('getServerProviderApiKey', () => {
    it('reads the configured env var for a cloud provider', () => {
      expect(getServerProviderApiKey('anthropic')).toBe('server-anthropic-key');
      expect(getServerProviderApiKey('openai')).toBe('server-openai-key');
      expect(getServerProviderApiKey('google')).toBe('server-google-key');
    });

    it('returns undefined for keyless providers', () => {
      expect(getServerProviderApiKey('ollama')).toBeUndefined();
      expect(getServerProviderApiKey('local')).toBeUndefined();
    });

    it('returns undefined when the env var is absent or blank', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '   ');
      expect(getServerProviderApiKey('anthropic')).toBeUndefined();

      vi.stubEnv('ANTHROPIC_API_KEY', '');
      expect(getServerProviderApiKey('anthropic')).toBeUndefined();
    });

    it('trims whitespace from the env value', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '  trimmed-key  ');
      expect(getServerProviderApiKey('anthropic')).toBe('trimmed-key');
    });
  });

  describe('resolveProviderApiKey', () => {
    it('prefers the per-agent key over the server-level key', () => {
      expect(resolveProviderApiKey('anthropic', 'per-agent-key')).toBe('per-agent-key');
    });

    it('falls back to the server-level key when no per-agent key is set', () => {
      expect(resolveProviderApiKey('anthropic', undefined)).toBe('server-anthropic-key');
      expect(resolveProviderApiKey('openai', undefined)).toBe('server-openai-key');
    });

    it('returns undefined when neither source has a key', () => {
      expect(resolveProviderApiKey('ollama', undefined)).toBeUndefined();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      expect(resolveProviderApiKey('anthropic', undefined)).toBeUndefined();
    });
  });
});
