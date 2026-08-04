import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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
// SSRF protection — private/loopback address rejection and DNS pinning
// ---------------------------------------------------------------------------

interface PinnedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Expand an IPv6 address to its full 8-group form so we can inspect bit
 * patterns reliably. Handles `::` compression and dotted-decimal tails
 * (IPv4-mapped addresses like `::ffff:127.0.0.1`).
 */
function expandIPv6(ip: string): number[] {
  // Handle IPv4-mapped tail (e.g. ::ffff:127.0.0.1)
  const v4TailMatch = ip.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  let normalized = ip;
  if (v4TailMatch) {
    const v4Parts = v4TailMatch[1].split('.').map(Number);
    const group1 = ((v4Parts[0] << 8) | v4Parts[1]).toString(16);
    const group2 = ((v4Parts[2] << 8) | v4Parts[3]).toString(16);
    normalized = ip.slice(0, ip.length - v4TailMatch[1].length) + group1 + ':' + group2;
  }

  const parts = normalized.split('::');
  if (parts.length === 1) {
    return parts[0].split(':').map((g) => parseInt(g, 16));
  }
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const middle = Array(missing).fill('0');
  return [...left, ...middle, ...right].map((g) => parseInt(g || '0', 16));
}

/**
 * Returns true when `address` is a private, loopback, link-local, or
 * unspecified IP address that must never be the target of a health check.
 *
 * Blocked ranges:
 *   IPv4: 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
 *         172.16.0.0/12, 192.168.0.0/16
 *   IPv6: ::1, ::, fc00::/7, fe80::/10, and IPv4-mapped variants
 */
function isPrivateOrLoopbackAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();
  const family = net.isIP(ip);

  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 0) return true; // 0.0.0.0/8
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 127) return true; // 127.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    return false;
  }

  if (family === 6) {
    if (ip === '::1') return true; // loopback
    if (ip === '::') return true; // unspecified

    // IPv4-mapped IPv6 in dotted-decimal form (::ffff:a.b.c.d)
    const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Mapped) {
      return isPrivateOrLoopbackAddress(v4Mapped[1]);
    }

    const groups = expandIPv6(ip);

    // IPv4-mapped IPv6 in hex form (::ffff:xxxx:xxxx) — groups[5] === 0xffff
    if (
      groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
      groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
    ) {
      const a = (groups[6] >> 8) & 0xff;
      const b = groups[6] & 0xff;
      const c = (groups[7] >> 8) & 0xff;
      const d = groups[7] & 0xff;
      return isPrivateOrLoopbackAddress(`${a}.${b}.${c}.${d}`);
    }

    // fc00::/7 — unique local addresses (first 7 bits = 1111110)
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 — link-local (first 10 bits = 1111111010)
    if ((groups[0] & 0xffc0) === 0xfe80) return true;
    return false;
  }

  return false;
}

/**
 * When `EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE` is set to a truthy value, private
 * address checks are skipped. This is intended for test environments that
 * bind local servers on 127.0.0.1.
 */
function privateAddressCheckEnabled(): boolean {
  const flag = process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE;
  return flag !== 'true' && flag !== '1';
}

// ---------------------------------------------------------------------------
// Injectable DNS resolver (for testing)
// ---------------------------------------------------------------------------

type DnsLookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

const realDnsLookup: DnsLookupFn = (hostname, options) =>
  dns.lookup(hostname, options);

let dnsLookupFn: DnsLookupFn = realDnsLookup;

/**
 * Override the DNS lookup function used by the health checker. Intended for
 * testing DNS pre-resolution and pinning behavior without real DNS.
 */
export function _setDnsLookupForTesting(fn: DnsLookupFn): void {
  dnsLookupFn = fn;
}

/**
 * Restore the real DNS lookup function.
 */
export function _resetDnsLookupForTesting(): void {
  dnsLookupFn = realDnsLookup;
}

/**
 * Resolve a URL hostname via dns.lookup, reject private/loopback/link-local
 * addresses, and return a pinned target so the request cannot be redirected
 * to a different address by DNS rebinding.
 */
async function resolveHealthCheckTarget(
  url: URL,
  signal: AbortSignal,
): Promise<PinnedTarget> {
  // URL.hostname includes brackets for IPv6 (e.g. [::1]); strip them so
  // net.isIP and isPrivateOrLoopbackAddress work correctly.
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1).toLowerCase()
      : url.hostname.toLowerCase();
  const enforcePrivateCheck = privateAddressCheckEnabled();

  // Reject the literal "localhost" hostname explicitly.
  if (enforcePrivateCheck && hostname === 'localhost') {
    throw new Error(
      'Health check URL hostname "localhost" is not allowed — use a public hostname or IP address.',
    );
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (enforcePrivateCheck && isPrivateOrLoopbackAddress(hostname)) {
      throw new Error(
        `Health check URL resolves to a private/loopback address (${hostname}) which is blocked by SSRF protection.`,
      );
    }
    return { url, address: hostname, family: literalFamily as 4 | 6 };
  }

  // Pre-resolve the hostname and inspect every returned address.
  const addresses = await new Promise<Array<{ address: string; family: number }>>(
    (resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      void dnsLookupFn(hostname, { all: true, verbatim: true }).then(
        (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    },
  );

  if (enforcePrivateCheck) {
    const privateAddr = addresses.find((entry) =>
      isPrivateOrLoopbackAddress(entry.address),
    );
    if (privateAddr) {
      throw new Error(
        `Health check URL hostname "${hostname}" resolved to a private/loopback address (${privateAddr.address}) which is blocked by SSRF protection.`,
      );
    }
  }

  const pinned = addresses[0];
  if (!pinned) {
    throw new Error(`Health check URL hostname "${hostname}" did not resolve to any address.`);
  }
  return {
    url,
    address: pinned.address,
    family: (pinned.family === 6 ? 6 : 4) as 4 | 6,
  };
}

// ---------------------------------------------------------------------------
// Bounded HTTP HEAD request
// ---------------------------------------------------------------------------

interface BoundedHeadResult {
  status: number;
  statusText: string;
}

/**
 * Perform a bounded HEAD request to a pinned target.
 *
 * Bounds:
 * - Finite timeout (default 30s, capped at 30s).
 * - Redirects are NOT followed (3xx is treated as a non-success response).
 * - Response body consumption is capped at MAX_RESPONSE_BYTES.
 * - `agent: false` disables connection pooling.
 * - The resolved IP address is pinned via the `lookup` callback to prevent
 *   DNS rebinding attacks.
 */
function boundedHead(
  target: PinnedTarget,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedHeadResult> {
  const transport = target.url.protocol === 'https:' ? https : http;
  const timeoutSignal = AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMEOUT_MS));
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      target.url,
      {
        method: 'HEAD',
        headers: { 'user-agent': 'eidolon-health-check/1.0' },
        signal: combined,
        agent: false,
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{
              address: target.address,
              family: target.family,
            }]);
            return;
          }
          callback(null, target.address, target.family);
        },
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
        realCheckPerformed: false,
      };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        healthStatus: 'error',
        healthCheckMethod: 'http_head',
        healthError: `Configured URL must use http or https (got ${parsedUrl.protocol}).`,
        message: 'Health check failed: unsupported protocol.',
        testedAt,
        realCheckPerformed: false,
      };
    }

    // Track whether an actual HTTP request was attempted. Only set to true
    // right before boundedHead is called — DNS resolution failures, SSRF
    // rejections, and other pre-request errors leave it false.
    let requestAttempted = false;
    try {
      // Create a timeout signal that covers both DNS resolution and the
      // HTTP request so the total wall-clock stays bounded.
      const timeoutSignal = AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMEOUT_MS));
      const combined = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      // SSRF protection: pre-resolve the hostname, reject private/loopback
      // addresses, and pin the resolved address to prevent DNS rebinding.
      const target = await resolveHealthCheckTarget(parsedUrl, combined);

      requestAttempted = true;
      const result = await boundedHead(target, timeoutMs, options.signal);
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
        realCheckPerformed: requestAttempted,
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
