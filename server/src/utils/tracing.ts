import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

/**
 * Optional OpenTelemetry SDK initialization.
 *
 * The SDK is started only when `EIDOLON_OTEL_ENABLED` is set to `1` or
 * `true`. When unconfigured, `initTracing()` returns `null` and the
 * module is a complete no-op — no exporters, no instrumentations, no
 * behavior change.
 *
 * When enabled, the OTLP trace exporter is configured via
 * `EIDOLON_OTEL_EXPORTER_OTLP_ENDPOINT` (falls back to the SDK default
 * `http://localhost:4318/v1/traces` when unset). Auto-instrumentations
 * patch Express, HTTP, and Postgres (pg / postgres.js) at module-load
 * time, so this module MUST be imported before any instrumented module
 * is loaded.
 *
 * In `server/src/index.ts` the import follows `./env.js` (which loads
 * `.env`) and precedes `./bootstrap.js` (which loads Express, drizzle,
 * and postgres.js). In `server/src/bootstrap.ts` it is the first import
 * so the Vercel Function entry (`api/index.js`) also initializes tracing
 * before instrumented modules load.
 */

let sdk: NodeSDK | null = null;

/** Returns `true` when `EIDOLON_OTEL_ENABLED` is `1` or `true`. */
export function isTracingEnabled(): boolean {
  const value = process.env.EIDOLON_OTEL_ENABLED;
  return value === '1' || value === 'true';
}

/**
 * Initialize the OpenTelemetry SDK if `EIDOLON_OTEL_ENABLED` is set.
 * Returns the started `NodeSDK` instance, or `null` when tracing is
 * disabled. Safe to call multiple times — only the first call with
 * tracing enabled creates and starts the SDK.
 */
export function initTracing(): NodeSDK | null {
  if (!isTracingEnabled()) {
    return null;
  }

  if (sdk) {
    return sdk;
  }

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const endpoint = process.env.EIDOLON_OTEL_EXPORTER_OTLP_ENDPOINT;
  const traceExporter = new OTLPTraceExporter(endpoint ? { url: endpoint } : {});

  sdk = new NodeSDK({
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy, low-value instrumentations.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Flush pending spans on shutdown.
  const gracefulShutdown = (): void => {
    sdk?.shutdown().catch((err) => {
      diag.error('Error shutting down OpenTelemetry SDK', err);
    });
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  return sdk;
}

/** Returns the active SDK instance, or `null` when tracing is disabled. */
export function getTracingSdk(): NodeSDK | null {
  return sdk;
}

/**
 * Reset internal state. Intended ONLY for tests that need to call
 * `initTracing()` multiple times with different env configurations.
 */
export function __resetForTesting(): void {
  sdk = null;
}

// Auto-initialize on import. This runs during module evaluation, before
// the importing module's subsequent imports (Express, HTTP, Postgres) are
// evaluated, so auto-instrumentations can patch them at load time.
initTracing();
