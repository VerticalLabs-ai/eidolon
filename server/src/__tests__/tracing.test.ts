import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Mock the OpenTelemetry packages so the tests verify initialization logic
// without actually starting auto-instrumentations in the test process.
// vi.hoisted ensures the mock values exist before vi.mock runs (both are
// hoisted above imports by vitest).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    sdkStart: vi.fn(),
    sdkShutdown: vi.fn().mockResolvedValue(undefined),
    sdkConfig: null as Record<string, unknown> | null,
    exporterConfig: null as Record<string, unknown> | null,
    instrumentationsConfig: null as Record<string, unknown> | null,
  };
});

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    mocks.sdkConfig = config;
    return {
      start: mocks.sdkStart,
      shutdown: mocks.sdkShutdown,
    };
  }),
}));

vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    mocks.instrumentationsConfig = config;
    return [{ name: 'mock-instrumentation' }];
  }),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    mocks.exporterConfig = config;
    return { _mockExporter: true };
  }),
}));

vi.mock('@opentelemetry/api', () => ({
  diag: {
    setLogger: vi.fn(),
    error: vi.fn(),
  },
  DiagConsoleLogger: vi.fn(),
  DiagLogLevel: { INFO: 1, ERROR: 2 },
}));

// Import after mocks are in place.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import {
  initTracing,
  isTracingEnabled,
  getTracingSdk,
  __resetForTesting,
} from '../utils/tracing.js';

describe('Distributed tracing (EID-105)', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.sdkConfig = null;
    mocks.exporterConfig = null;
    mocks.instrumentationsConfig = null;
    __resetForTesting();
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetForTesting();
  });

  // -------------------------------------------------------------------------
  // VAL-OBS-006: OpenTelemetry SDK initialization is optional and env-configured
  // -------------------------------------------------------------------------

  describe('optional initialization', () => {
    it('is disabled when EIDOLON_OTEL_ENABLED is unset', () => {
      delete process.env.EIDOLON_OTEL_ENABLED;
      expect(isTracingEnabled()).toBe(false);
    });

    it('is disabled when EIDOLON_OTEL_ENABLED is empty', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '');
      expect(isTracingEnabled()).toBe(false);
    });

    it('is enabled when EIDOLON_OTEL_ENABLED is 1', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      expect(isTracingEnabled()).toBe(true);
    });

    it('is enabled when EIDOLON_OTEL_ENABLED is true', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', 'true');
      expect(isTracingEnabled()).toBe(true);
    });

    it('returns null and does not start the SDK when unconfigured', () => {
      delete process.env.EIDOLON_OTEL_ENABLED;
      const result = initTracing();
      expect(result).toBeNull();
      expect(NodeSDK).not.toHaveBeenCalled();
      expect(mocks.sdkStart).not.toHaveBeenCalled();
    });

    it('initializes and starts the SDK when EIDOLON_OTEL_ENABLED is set', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      const result = initTracing();

      expect(result).not.toBeNull();
      expect(NodeSDK).toHaveBeenCalledTimes(1);
      expect(mocks.sdkStart).toHaveBeenCalledTimes(1);
    });

    it('configures the OTLP exporter with the endpoint when provided', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      vi.stubEnv('EIDOLON_OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector:4318/v1/traces');
      initTracing();

      expect(OTLPTraceExporter).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://collector:4318/v1/traces' }),
      );
    });

    it('uses the default exporter when no endpoint is provided', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      delete process.env.EIDOLON_OTEL_EXPORTER_OTLP_ENDPOINT;
      initTracing();

      expect(OTLPTraceExporter).toHaveBeenCalledWith({});
    });

    it('passes auto-instrumentations to the NodeSDK', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      initTracing();

      expect(getNodeAutoInstrumentations).toHaveBeenCalledTimes(1);
      expect(mocks.sdkConfig).not.toBeNull();
      expect(mocks.sdkConfig!.instrumentations).toBeDefined();
      expect(Array.isArray(mocks.sdkConfig!.instrumentations)).toBe(true);
    });

    it('disables fs and dns instrumentations to reduce noise', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      initTracing();

      expect(mocks.instrumentationsConfig).not.toBeNull();
      expect(mocks.instrumentationsConfig!['@opentelemetry/instrumentation-fs']).toEqual({
        enabled: false,
      });
      expect(mocks.instrumentationsConfig!['@opentelemetry/instrumentation-dns']).toEqual({
        enabled: false,
      });
    });

    it('does not create a second SDK on repeated initTracing calls', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      initTracing();
      initTracing();

      expect(NodeSDK).toHaveBeenCalledTimes(1);
      expect(mocks.sdkStart).toHaveBeenCalledTimes(1);
    });

    it('getTracingSdk returns the SDK after initialization', () => {
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');
      initTracing();
      expect(getTracingSdk()).not.toBeNull();
    });

    it('getTracingSdk returns null when tracing is disabled', () => {
      delete process.env.EIDOLON_OTEL_ENABLED;
      initTracing();
      expect(getTracingSdk()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-OBS-007: Trace propagation verified by tests
  // W3C traceparent headers still propagate correctly regardless of OTel.
  // -------------------------------------------------------------------------

  describe('trace header propagation', () => {
    it('generates X-Request-ID, X-Trace-ID, and traceparent for requests without trace context', async () => {
      const response = await request(app).get('/api/health').expect(200);

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
      expect(response.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it('preserves a valid W3C traceparent and continues the trace', async () => {
      const traceId = '0123456789abcdef0123456789abcdef';
      const response = await request(app)
        .get('/api/health')
        .set('traceparent', `00-${traceId}-0123456789abcdef-01`)
        .expect(200);

      expect(response.headers['x-trace-id']).toBe(traceId);
      expect(response.headers.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    });

    it('preserves a caller-supplied X-Request-ID when valid', async () => {
      const response = await request(app)
        .get('/api/health')
        .set('X-Request-ID', 'operator-check-456')
        .expect(200);

      expect(response.headers['x-request-id']).toBe('operator-check-456');
    });

    it('generates a fresh trace ID when the traceparent is malformed', async () => {
      const response = await request(app)
        .get('/api/health')
        .set('traceparent', '00-invalid-invalid-invalid')
        .expect(200);

      expect(response.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
      expect(response.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    });

    it('propagates trace headers correctly even when OTel is enabled (no behavior change)', async () => {
      // Enabling OTel should not alter the existing W3C traceparent
      // propagation in the observability middleware — the middleware
      // independently parses and propagates traceparent headers.
      vi.stubEnv('EIDOLON_OTEL_ENABLED', '1');

      const traceId = 'fedcba9876543210fedcba9876543210';
      const response = await request(app)
        .get('/api/health')
        .set('traceparent', `00-${traceId}-abcdef0123456789-01`)
        .expect(200);

      expect(response.headers['x-trace-id']).toBe(traceId);
      expect(response.headers.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    });
  });
});
