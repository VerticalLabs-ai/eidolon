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
//
// Scrutiny round 2 (non-blocking): The fake client now models a postgres-js
// Query object (extends Promise, has Symbol.species → Promise, supports
// modifier chaining) instead of returning a native Promise, so tests reflect
// real postgres-js semantics.
// ---------------------------------------------------------------------------

/**
 * A postgres-js-like Query that extends Promise and has modifier methods.
 * The real postgres.js Query has `static get [Symbol.species]() { return
 * Promise }`, meaning .then() returns a native Promise (not a Query). This
 * fake replicates that behavior so tests model real modifier chaining.
 */
class FakeQuery extends Promise<unknown[]> {
  constructor(
    executor: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) => void,
  ) {
    super(
      executor as (
        resolve: (value: unknown[] | PromiseLike<unknown[]>) => void,
        reject: (reason?: unknown) => void,
      ) => void,
    );
  }

  static get [Symbol.species]() {
    return Promise;
  }

  simple(): this {
    return this;
  }

  raw(): this {
    return this;
  }

  values(): this {
    return this;
  }

  cursor(): this {
    return this;
  }
}

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
    // Model a postgres-js-like callable that returns a Query (extends
    // Promise) with modifier methods, rather than a native Promise.
    const fakeClient = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        new FakeQuery((resolve) => resolve([{ id: 1, query: strings.join('?'), values }])),
      {
        unsafe: (sql: string) => new FakeQuery((resolve) => resolve([{ sql }])),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);

    // Execute a query via the main callable (tagged template).
    // Verify the returned object preserves Query modifier methods.
    const queryResult = wrapped`SELECT 1`;
    expect(queryResult).toBeInstanceOf(FakeQuery);
    expect(typeof queryResult.simple).toBe('function');
    expect(typeof queryResult.values).toBe('function');
    await queryResult;

    // Execute a query via .unsafe() with modifier chaining.
    const unsafeResult = wrapped.unsafe('SELECT 1');
    expect(unsafeResult).toBeInstanceOf(FakeQuery);
    expect(typeof unsafeResult.raw).toBe('function');
    await unsafeResult;

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const spanNames = spans.map((s) => s.name);

    expect(spanNames).toContain('db.query');
    expect(spanNames).toContain('db.unsafe');
  });

  it('passes through non-traced methods unchanged', async () => {
    const fakeClient = Object.assign(() => new FakeQuery((resolve) => resolve([])), {
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
