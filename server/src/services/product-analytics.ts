/**
 * Product analytics instrumentation.
 *
 * A provider-agnostic event emitter with a typed taxonomy and runtime
 * redaction. No vendor SDK is embedded in product code; the transport is a
 * function that receives a sanitised event and can be wired to any sink.
 *
 * Off by default. The `productAnalytics` feature flag (EID-121) gates emission
 * per company, so analytics can be disabled without a deploy.
 *
 * @see docs/security/data-handling.md for the data constraints this module enforces.
 */

import type { DbInstance } from '../types.js';
import { logger } from '../utils/logger.js';
import { isFeatureEnabled, type FeatureFlagName } from './feature-flags.js';

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/** Stable event names for the core operator journeys. */
export const ANALYTICS_EVENT_NAMES = [
  'company.created',
  'company.joined',
  'task.created',
  'task.completed',
  'agent.invoked',
  'artifact.created',
  'project.created',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/** Typed payload for each event. Only non-sensitive, aggregate fields. */
export type AnalyticsEventPayload = {
  'company.created': { companyId: string; plan: string | null };
  'company.joined': { companyId: string; role: string };
  'task.created': { companyId: string; projectId: string | null };
  'task.completed': { companyId: string; projectId: string | null; durationMs: number };
  'agent.invoked': { companyId: string; agentId: string };
  'artifact.created': { companyId: string; kind: string };
  'project.created': { companyId: string };
};

export type AnalyticsEvent<N extends AnalyticsEventName = AnalyticsEventName> = {
  name: N;
  payload: AnalyticsEventPayload[N];
  timestamp: string;
};

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Field names that must never appear in an analytics event.
 *
 * This is a denylist because an allowlist per event is already enforced by the
 * typed payload. The denylist catches a future field that slips through the
 * type system (e.g. via `any` or a cast) and would carry sensitive data.
 */
const SENSITIVE_FIELD_PATTERNS = [
  /prompt/i,
  /transcript/i,
  /credential/i,
  /password/i,
  /secret/i,
  /token/i,
  /apiKey/i,
  /email/i,
  /phone/i,
  /name$/i, // personal names (givenName, familyName, displayName)
  /address/i,
  /content/i, // artifact/document content
  /body/i, // message/task body
  /description/i, // free-text descriptions
  /metadata/i, // arbitrary key-value maps
];

/**
 * Runtime redaction. Recursively walks the payload and nulls any field whose
 * name matches a sensitive pattern. This is a safety net — the typed payload
 * should already prevent these fields from being attached.
 *
 * Returns a deep copy with sensitive fields replaced by `null`.
 */
export function redactPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      result[key] = null;
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactPayload(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Assert at runtime that the payload contains no sensitive fields.
 * Throws if a sensitive field is found, so a bug that tries to attach one
 * is caught immediately rather than silently redacted.
 */
export function assertNoSensitiveFields(payload: unknown, event: string): void {
  if (typeof payload !== 'object' || payload === null) {
    return;
  }
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error(
        `Analytics event "${event}" contains a sensitive field "${key}". ` +
          'This is a bug: the event payload type should not allow it.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A transport receives a sanitised event and sends it to a sink. */
export type AnalyticsTransport = (event: AnalyticsEvent) => void;

/** No-op transport. The default, so analytics is off unless configured. */
export const noopTransport: AnalyticsTransport = () => {};

/** Logging transport for development. */
export const consoleTransport: AnalyticsTransport = (event) => {
  logger.info({ analyticsEvent: event }, 'analytics event emitted');
};

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

const PRODUCT_ANALYTICS_FLAG: FeatureFlagName = 'productAnalytics';

export class ProductAnalytics {
  private readonly transport: AnalyticsTransport;

  constructor(transport: AnalyticsTransport = noopTransport) {
    this.transport = transport;
  }

  /**
   * Emit an analytics event for a company, gated by the `productAnalytics`
   * feature flag. If the flag is off, the event is dropped silently.
   *
   * The payload is redacted before being passed to the transport, so even a
   * type-system escape cannot leak sensitive data.
   */
  async emit<N extends AnalyticsEventName>(
    db: DbInstance,
    companyId: string,
    name: N,
    payload: AnalyticsEventPayload[N],
  ): Promise<void> {
    if (!isFeatureEnabled(PRODUCT_ANALYTICS_FLAG, companyId)) {
      return;
    }

    assertNoSensitiveFields(payload, name);

    const event: AnalyticsEvent = {
      name,
      payload: redactPayload(payload) as AnalyticsEventPayload[N],
      timestamp: new Date().toISOString(),
    };

    this.transport(event);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ProductAnalytics | null = null;

/**
 * Get the global ProductAnalytics instance. The transport is configured once
 * at startup from the environment; product code calls `emit` without knowing
 * where the events go.
 */
export function getProductAnalytics(): ProductAnalytics {
  if (instance) {
    return instance;
  }
  const transport =
    process.env.PRODUCT_ANALYTICS_TRANSPORT === 'console' ? consoleTransport : noopTransport;
  instance = new ProductAnalytics(transport);
  return instance;
}
