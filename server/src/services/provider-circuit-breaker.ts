type CircuitState = {
  consecutiveFailures: number;
  openUntil: number;
};

const circuits = new Map<string, CircuitState>();

export class ProviderCircuitOpenError extends Error {
  constructor(provider: string, retryAfterMs: number) {
    super(
      `Provider "${provider}" is temporarily unavailable after repeated failures. Retry in ${Math.ceil(retryAfterMs / 1000)} seconds.`,
    );
    this.name = 'ProviderCircuitOpenError';
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function failureThreshold(): number {
  return positiveInteger(process.env.EIDOLON_PROVIDER_CIRCUIT_FAILURE_THRESHOLD, 5);
}

function resetTimeoutMs(): number {
  return positiveInteger(process.env.EIDOLON_PROVIDER_CIRCUIT_RESET_MS, 30_000);
}

export async function withProviderCircuitBreaker<T>(
  provider: string,
  operation: () => Promise<T>,
  now = Date.now,
): Promise<T> {
  const state = circuits.get(provider) ?? { consecutiveFailures: 0, openUntil: 0 };
  const currentTime = now();

  if (state.openUntil > currentTime) {
    throw new ProviderCircuitOpenError(provider, state.openUntil - currentTime);
  }

  try {
    const result = await operation();
    circuits.delete(provider);
    return result;
  } catch (error) {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= failureThreshold()) {
      state.openUntil = currentTime + resetTimeoutMs();
    }
    circuits.set(provider, state);
    throw error;
  }
}

export function resetProviderCircuitsForTests(): void {
  circuits.clear();
}
