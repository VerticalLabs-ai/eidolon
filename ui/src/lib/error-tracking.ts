import * as Sentry from '@sentry/react';

let initialized = false;

/**
 * Initialize the UI Sentry SDK.
 *
 * Sentry is only initialized when `VITE_SENTRY_DSN` is set. When unconfigured,
 * this is a no-op with no behavior change — no SDK starts, no events are sent,
 * and the returned flag is `false`. This mirrors the server's
 * `initializeErrorTracking` pattern in `server/src/utils/error-tracking.ts`.
 *
 * No personal data is attached to events: `sendDefaultPii` is `false`, and we
 * only set non-identifying context (release, environment). User IDs, emails,
 * prompts, transcripts, and credentials are never attached to Sentry events
 * from the UI.
 *
 * @returns `true` when Sentry was initialized (or already initialized),
 *          `false` when the DSN is unset.
 */
export function initializeErrorTracking(): boolean {
  if (initialized) {
    return Boolean(Sentry.getClient());
  }

  // Vite exposes env vars prefixed with VITE_ at build time via
  // import.meta.env. This is a build-time constant, not a runtime secret.
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    return false;
  }

  const tracesSampleRate = Number.parseFloat(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? '0');

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE ?? 'development',
    release: import.meta.env.VITE_APP_VERSION,
    tracesSampleRate:
      Number.isFinite(tracesSampleRate) && tracesSampleRate >= 0
        ? Math.min(tracesSampleRate, 1)
        : 0,
    // Never send personally identifiable information with events.
    sendDefaultPii: false,
  });
  initialized = true;
  return true;
}

/**
 * Report an error to Sentry from the UI.
 *
 * When Sentry is not initialized this is a no-op. Only non-identifying context
 * (e.g. a route tag) should be attached — never user IDs, emails, prompts,
 * transcripts, or credentials.
 *
 * Tags are filtered to a whitelist of safe, non-identifying keys to prevent
 * accidental leakage of sensitive data through Sentry tags.
 */
const ALLOWED_TAG_KEYS = new Set([
  'route',
  'component',
  'action',
  'feature',
  'view',
  'source',
  'error_type',
  'error_code',
  'browser',
  'platform',
  'environment',
  'attempt',
]);

export function captureUIError(
  error: unknown,
  context?: Record<string, string | number | boolean>,
): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (ALLOWED_TAG_KEYS.has(key)) {
          scope.setTag(key, value);
        }
      }
    }
    Sentry.captureException(error);
  });
}

/** Whether Sentry has been initialized in this browser session. */
export function isErrorTrackingEnabled(): boolean {
  return initialized;
}

/**
 * Reset the initialization flag. Intended only for tests so the module can be
 * re-evaluated across cases without reloading the browser.
 */
export function __resetErrorTrackingForTesting(): void {
  initialized = false;
}
