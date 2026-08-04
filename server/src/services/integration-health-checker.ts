import http from 'node:http';
import https from 'node:https';
import { eq } from 'drizzle-orm';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HealthStatus = 'healthy' | 'degraded' | 'error' | 'unknown';
export type HealthCheckMethod = 'http_head' | 'http_get' | 'manual' | 'none';

export interface HealthCheckResult {
  healthStatus: HealthStatus;
  healthCheckMethod: HealthCheckMethod;
  healthError: string | null;
  message: string;
  testedAt: string;
  /** True only when a real network round-trip completed successfully. */
  realCheckPerformed: boolean;
  /** HTTP status code observed when a real request was made. */
  httpStatus?: number;
}

/**
 * Minimal shape of an integration row needed by the checker. Decoupled from
 * the Drizzle row type so the service is testable in isolation.
 */
export interface IntegrationRow {
  id: string;
  type: string;
  provider: string;
  config: unknown;
  credentialsEncrypted: string | null;
}

// ---------------------------------------------------------------------------
// Constants — bounded HTTP checks
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Integration types that support real HTTP connectivity checks. These perform
 * a bounded HEAD request against the configured URL.
 */
const HTTP_CHECKABLE_TYPES = new Set(['custom_api', 'webhook_out']);

/**
 * Catalog providers that do not yet have an implemented automated health
 * checker. They return `unknown` rather than guessing `healthy`.
 */
const CATALOG_PROVIDERS_WITHOUT_CHECKERS = new Set([
  'github',
  'slack',
  'notion',
  'linear',
  'gmail',
  'calendar',
  'stripe',
  'hubspot',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseConfig(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asRecord(value);
}

function resolveConfigUrl(config: Record<string, unknown>): string | null {
  // Accept either `url` (webhook_out) or `baseUrl` (custom_api).
  const url = typeof config.url === 'string' ? config.url : null;
  if (url && url.trim()) return url.trim();
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : null;
  if (baseUrl && baseUrl.trim()) return baseUrl.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Bounded HTTP HEAD request
// ---------------------------------------------------------------------------

interface BoundedHeadResult {
  status: number;
  statusText: string;
}

/**
 * Perform a bounded HEAD request to `targetUrl`.
 *
 * Bounds:
 * - Finite timeout (default 30s, capped at 30s).
 * - Redirects are NOT followed (3xx is treated as a non-success response).
 * - Response body consumption is capped at MAX_RESPONSE_BYTES.
 * - `agent: false` disables connection pooling.
 */
function boundedHead(
  targetUrl: URL,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedHeadResult> {
  const transport = targetUrl.protocol === 'https:' ? https : http;
  const timeoutSignal = AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMEOUT_MS));
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      targetUrl,
      {
        method: 'HEAD',
        headers: { 'user-agent': 'eidolon-health-check/1.0' },
        signal: combined,
        agent: false,
      },
      (response) => {
        // Drain and bound the response body so it cannot exhaust resources.
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error(`Health check response exceeded ${MAX_RESPONSE_BYTES} bytes.`));
            return;
          }
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
          });
        });
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a real, truthful health check for a single integration.
 *
 * Truthfulness invariant: this function NEVER returns `healthy` without making
 * a real network request and receiving a 2xx response.
 */
export async function checkIntegrationHealth(
  integration: IntegrationRow,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HealthCheckResult> {
  const testedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hasCredentials = !!integration.credentialsEncrypted;

  // 1. Integrations without credentials → unknown.
  if (!hasCredentials) {
    return {
      healthStatus: 'unknown',
      healthCheckMethod: 'none',
      healthError: null,
      message: 'No credentials configured — health cannot be verified.',
      testedAt,
      realCheckPerformed: false,
    };
  }

  // 2. HTTP-based integrations (custom_api, webhook_out) → real HEAD request.
  if (HTTP_CHECKABLE_TYPES.has(integration.type)) {
    const config = parseConfig(integration.config);
    const url = resolveConfigUrl(config);

    if (!url) {
      return {
        healthStatus: 'unknown',
        healthCheckMethod: 'none',
        healthError: null,
        message: `No URL configured for ${integration.type} integration — health cannot be verified.`,
        testedAt,
        realCheckPerformed: false,
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        healthStatus: 'error',
        healthCheckMethod: 'http_head',
        healthError: `Configured URL "${url}" is not a valid URL.`,
        message: 'Health check failed: invalid URL.',
        testedAt,
        realCheckPerformed: true,
      };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        healthStatus: 'error',
        healthCheckMethod: 'http_head',
        healthError: `Configured URL must use http or https (got ${parsedUrl.protocol}).`,
        message: 'Health check failed: unsupported protocol.',
        testedAt,
        realCheckPerformed: true,
      };
    }

    try {
      const result = await boundedHead(parsedUrl, timeoutMs, options.signal);
      const ok = result.status >= 200 && result.status < 300;

      if (ok) {
        return {
          healthStatus: 'healthy',
          healthCheckMethod: 'http_head',
          healthError: null,
          message: `Connection successful (HTTP ${result.status}).`,
          testedAt,
          realCheckPerformed: true,
          httpStatus: result.status,
        };
      }

      return {
        healthStatus: 'error',
        healthCheckMethod: 'http_head',
        healthError: `HTTP ${result.status} ${result.statusText}`.trim(),
        message: `Health check failed: HTTP ${result.status}.`,
        testedAt,
        realCheckPerformed: true,
        httpStatus: result.status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout =
        error instanceof Error &&
        (error.name === 'AbortError' || /timeout|aborted/i.test(error.message));
      return {
        healthStatus: 'error',
        healthCheckMethod: 'http_head',
        healthError: isTimeout
          ? `Health check timed out after ${Math.min(timeoutMs, MAX_TIMEOUT_MS)}ms.`
          : message,
        message: isTimeout
          ? 'Health check failed: request timed out.'
          : `Health check failed: ${message}`,
        testedAt,
        realCheckPerformed: true,
      };
    }
  }

  // 3. Catalog providers without implemented checkers → unknown.
  if (CATALOG_PROVIDERS_WITHOUT_CHECKERS.has(integration.type)) {
    return {
      healthStatus: 'unknown',
      healthCheckMethod: 'none',
      healthError: null,
      message: `No automated health check available for "${integration.type}" — provider connectivity is not verified.`,
      testedAt,
      realCheckPerformed: false,
    };
  }

  // 4. Unknown integration type → unknown (never healthy without a real check).
  return {
    healthStatus: 'unknown',
    healthCheckMethod: 'none',
    healthError: null,
    message: `No automated health check available for integration type "${integration.type}".`,
    testedAt,
    realCheckPerformed: false,
  };
}

/**
 * Persist a health check result onto the integration row.
 */
export async function persistHealthResult(
  db: DbInstance,
  integrationId: string,
  result: HealthCheckResult,
): Promise<void> {
  const { integrations } = db.schema;
  const now = new Date();
  await db.drizzle
    .update(integrations)
    .set({
      healthStatus: result.healthStatus,
      lastHealthCheckAt: now,
      healthError: result.healthError,
      healthCheckMethod: result.healthCheckMethod,
      updatedAt: now,
    })
    .where(eq(integrations.id, integrationId));
}
