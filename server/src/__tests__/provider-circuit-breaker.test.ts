import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderCircuitOpenError,
  resetProviderCircuitsForTests,
  withProviderCircuitBreaker,
} from '../services/provider-circuit-breaker.js';

describe('provider circuit breaker', () => {
  afterEach(() => {
    resetProviderCircuitsForTests();
    vi.unstubAllEnvs();
  });

  it('opens after the configured consecutive failure threshold', async () => {
    vi.stubEnv('EIDOLON_PROVIDER_CIRCUIT_FAILURE_THRESHOLD', '2');
    vi.stubEnv('EIDOLON_PROVIDER_CIRCUIT_RESET_MS', '30000');
    const failedCall = vi.fn(async () => {
      throw new Error('provider unavailable');
    });

    await expect(withProviderCircuitBreaker('openai', failedCall, () => 0)).rejects.toThrow(
      'provider unavailable',
    );
    await expect(withProviderCircuitBreaker('openai', failedCall, () => 0)).rejects.toThrow(
      'provider unavailable',
    );

    const blockedCall = vi.fn(async () => 'unreachable');
    await expect(withProviderCircuitBreaker('openai', blockedCall, () => 1)).rejects.toBeInstanceOf(
      ProviderCircuitOpenError,
    );
    expect(blockedCall).not.toHaveBeenCalled();
  });

  it('allows a probe after the reset timeout and closes on success', async () => {
    vi.stubEnv('EIDOLON_PROVIDER_CIRCUIT_FAILURE_THRESHOLD', '1');
    vi.stubEnv('EIDOLON_PROVIDER_CIRCUIT_RESET_MS', '100');

    await expect(
      withProviderCircuitBreaker(
        'anthropic',
        async () => {
          throw new Error('provider unavailable');
        },
        () => 0,
      ),
    ).rejects.toThrow('provider unavailable');

    await expect(
      withProviderCircuitBreaker(
        'anthropic',
        async () => 'recovered',
        () => 100,
      ),
    ).resolves.toBe('recovered');
    await expect(
      withProviderCircuitBreaker(
        'anthropic',
        async () => 'healthy',
        () => 101,
      ),
    ).resolves.toBe('healthy');
  });
});
