import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import { wrapClientWithTracing, __resetForTesting } from '../utils/tracing.js';

// ---------------------------------------------------------------------------
// VAL-OBS-007 (supplement): Verify that spans are actually created and
// exported when the OpenTelemetry SDK is enabled. Unlike tracing.test.ts
// (which mocks all OTel packages to test initialization logic), this file
// uses the REAL OpenTelemetry API + SDK with an InMemorySpanExporter to
// assert that spans are genuinely produced, exported, and carry the correct
// attributes. A BasicTracerProvider with a SimpleSpanProcessor is used so
// spans are exported synchronously on end (no batch flush timing issues).
// ---------------------------------------------------------------------------

describe('Distributed tracing — real span creation (EID-105)', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    __resetForTesting();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    // Register as the global tracer provider so trace.getTracer() uses it.
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    // Reset the global tracer provider to the default no-op.
    trace.disable();
    __resetForTesting();
  });

  it('creates and exports a span when the SDK is enabled', async () => {
    const tracer = trace.getTracer('test-tracer');

    await tracer.startActiveSpan('test-operation', async (span) => {
      span.setAttribute('test.key', 'test-value');
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test-operation');
    expect(spans[0].attributes['test.key']).toBe('test-value');
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
  });

  it('creates multiple spans and they are all exported', async () => {
    const tracer = trace.getTracer('test-tracer');

    for (let i = 0; i < 3; i++) {
      await tracer.startActiveSpan(`operation-${i}`, async (span) => {
        span.end();
      });
    }

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.name).sort()).toEqual(['operation-0', 'operation-1', 'operation-2']);
  });

  it('records error status on failed spans', async () => {
    const tracer = trace.getTracer('test-tracer');

    await tracer.startActiveSpan('failing-operation', (span) => {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'something went wrong' });
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].status.message).toBe('something went wrong');
  });

  it('creates db.query spans via wrapClientWithTracing', async () => {
    // Create a fake postgres.js-like callable that returns a promise.
    // We only need the callable interface to verify span creation.
    const fakeClient = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) =>
        Promise.resolve([{ id: 1, query: strings.join('?'), values }]),
      {
        unsafe: (sql: string) => Promise.resolve([{ sql }]),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);

    // Execute a query via the main callable (tagged template).
    await wrapped`SELECT 1`;

    // Execute a query via .unsafe().
    await wrapped.unsafe('SELECT 1');

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    expect(spanNames).toContain('db.query');
    expect(spanNames).toContain('db.unsafe');
  });

  it('passes through non-traced methods unchanged', async () => {
    const fakeClient = Object.assign(async () => Promise.resolve([]), {
      end: () => Promise.resolve(),
      options: { max: 10 },
    });

    const wrapped = wrapClientWithTracing(fakeClient);

    // Non-traced properties pass through.
    expect(wrapped.options).toEqual({ max: 10 });
    expect(typeof wrapped.end).toBe('function');

    await wrapped.end();

    // No spans should be created for .end() (it's not in TRACED_METHODS).
    const spans = exporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);
    expect(spanNames).not.toContain('db.end');
  });
});
