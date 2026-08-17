import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';

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
 * patch Express, HTTP, and Postgres (pg) at module-load time, so this
 * module MUST be imported before any instrumented module is loaded.
 *
 * Eidolon uses postgres-js (drizzle-orm/postgres-js), which is NOT
 * covered by the auto-instrumentation's pg instrumentation. To fill that
 * gap, `wrapClientWithTracing()` creates manual spans around postgres-js
 * query calls. See the dedicated section below.
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

// ---------------------------------------------------------------------------
// Postgres-js DB query tracing
//
// The auto-instrumentations include `@opentelemetry/instrumentation-pg` which
// patches the `pg` library, but Eidolon uses postgres-js (drizzle-orm/
// postgres-js) — a different driver that is NOT covered. To fill this gap,
// `wrapClientWithTracing()` wraps the postgres.js `Sql` callable and its
// `.unsafe()` method with a Proxy that creates an OpenTelemetry span for each
// query. When the SDK is not enabled, the global tracer is a no-op tracer
// and the wrapper adds negligible overhead (spans are no-ops).
// ---------------------------------------------------------------------------

let dbTracer: Tracer | null = null;

/** Returns a tracer for DB query spans (cached after first call). */
export function getDbTracer(): Tracer {
  if (!dbTracer) {
    dbTracer = trace.getTracer('eidolon-db');
  }
  return dbTracer;
}

/**
 * Trace a single async/sync DB operation with a span. Sets status and
 * records exceptions on failure. Returns the operation's result.
 */
function traceDbOperation<T>(operation: string, fn: () => T): T {
  const tracer = getDbTracer();
  return tracer.startActiveSpan(`db.${operation}`, (span: Span) => {
    try {
      const result = fn();
      // Handle promises (postgres.js queries are thenable).
      if (result instanceof Promise) {
        return result.then(
          (value: unknown) => {
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return value as T;
          },
          (err: Error) => {
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            span.end();
            throw err;
          },
        ) as T;
      }
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      span.recordException(err as Error);
      span.end();
      throw err;
    }
  });
}

/** postgres.js methods that issue SQL queries and should be traced. */
const TRACED_METHODS = new Set(['unsafe']);

/**
 * Wrap a postgres.js `Sql` client so each query is traced with an
 * OpenTelemetry span. The wrapper intercepts:
 *
 * - The main callable (tagged template: `sql\`SELECT ...\``) → `db.query`
 * - `.unsafe()` (raw SQL string) → `db.unsafe`
 *
 * All other properties and methods pass through unchanged. When tracing is
 * disabled, the global tracer is a no-op so the wrapper adds only the cost
 * of a Proxy `get`/`apply` trap per call.
 *
 * This fills the gap left by `@opentelemetry/instrumentation-pg`, which only
 * instruments the `pg` library — not postgres.js.
 */
export function wrapClientWithTracing<T extends object>(client: T): T {
  return new Proxy(client, {
    apply(target, thisArg, argArray) {
      return traceDbOperation('query', () =>
        Reflect.apply(target as () => unknown, thisArg, argArray),
      );
    },
    get(target, prop, receiver) {
      // Only intercept string-named methods in the traced set.
      if (typeof prop === 'string' && TRACED_METHODS.has(prop)) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original === 'function') {
          return function (...args: unknown[]) {
            return traceDbOperation(prop, () => original.apply(target, args));
          };
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

// ---------------------------------------------------------------------------
// Test helper: create a NodeSDK with a custom span exporter for verifying
// real span creation in tests (InMemorySpanExporter). Production code uses
// initTracing() which reads env vars and creates an OTLP exporter.
// ---------------------------------------------------------------------------

/**
 * Create and start a `NodeSDK` with a custom trace exporter. Intended for
 * tests that need to verify spans are actually created and exported (e.g.
 * with `InMemorySpanExporter`). The caller is responsible for shutting
 * down the returned SDK after the test.
 *
 * Unlike `initTracing()`, this does not check `EIDOLON_OTEL_ENABLED` and
 * does not register auto-instrumentations (which patch modules at load
 * time and are unsafe in a shared test process).
 */
export function createTracingSdkForTest(exporter: SpanExporter): NodeSDK {
  const testSdk = new NodeSDK({
    traceExporter: exporter,
  });
  testSdk.start();
  return testSdk;
}

/**
 * Reset internal state. Intended ONLY for tests that need to call
 * `initTracing()` multiple times with different env configurations.
 */
export function __resetForTesting(): void {
  sdk = null;
  dbTracer = null;
}

// Auto-initialize on import. This runs during module evaluation, before
// the importing module's subsequent imports (Express, HTTP, Postgres) are
// evaluated, so auto-instrumentations can patch them at load time.
initTracing();
