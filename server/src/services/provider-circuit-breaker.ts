import { createHash } from 'node:crypto';

type CircuitState = {
  consecutiveFailures: number;
  openUntil: number;
};

const circuits = new Map<string, CircuitState>();

/**
 * Build a circuit key for an outbound dependency whose address is
 * tenant-supplied.
 *
 * Each distinct endpoint needs its own circuit — one company's dead MCP server
 * must not suppress calls for every other company — but circuit keys surface in
 * the metrics registry, so the address is reduced to a short digest rather than
 * carried verbatim. A hostname is customer configuration, not telemetry.
 */
export function externalCircuitKey(kind: string, address: string): string {
  const digest = createHash('sha256').update(address).digest('hex').slice(0, 12);
  return `${kind}:${digest}`;
}

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

export type ProviderCircuitStatus = {
  provider: string;
  consecutiveFailures: number;
  open: boolean;
  /** Milliseconds until a probe is allowed; `0` when the circuit is closed. */
  retryAfterMs: number;
};

/**
 * Read-only view of every tracked circuit.
 *
 * Without this an open circuit is only observable by triggering the failure it
 * is suppressing, which is exactly when an operator cannot afford to
 * experiment.
 */
export function getProviderCircuitSnapshot(now = Date.now): ProviderCircuitStatus[] {
  const currentTime = now();
  return Array.from(circuits.entries())
    .map(([provider, state]) => ({
      provider,
      consecutiveFailures: state.consecutiveFailures,
      open: state.openUntil > currentTime,
      retryAfterMs: Math.max(0, state.openUntil - currentTime),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
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
