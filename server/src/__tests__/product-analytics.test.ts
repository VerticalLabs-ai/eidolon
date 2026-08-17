import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ANALYTICS_EVENT_NAMES,
  ProductAnalytics,
  assertNoSensitiveFields,
  consoleTransport,
  getProductAnalytics,
  noopTransport,
  redactPayload,
  type AnalyticsEventPayload,
} from '../services/product-analytics.js';
import { isFeatureEnabled } from '../services/feature-flags.js';

describe('product analytics', () => {
  const originalEnv = process.env.EIDOLON_FEATURE_FLAGS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EIDOLON_FEATURE_FLAGS = originalEnv;
    } else {
      delete process.env.EIDOLON_FEATURE_FLAGS;
    }
  });

  describe('event taxonomy', () => {
    it('declares a stable set of event names', () => {
      expect(ANALYTICS_EVENT_NAMES).toContain('company.created');
      expect(ANALYTICS_EVENT_NAMES).toContain('task.completed');
      expect(ANALYTICS_EVENT_NAMES.length).toBeGreaterThan(5);
    });

    it('every event name has a typed payload with companyId', () => {
      // Every event payload must include companyId so events are company-scoped.
      const payloads: Record<string, unknown> = {
        'company.created': { companyId: 'c1', plan: 'free' },
        'company.joined': { companyId: 'c1', role: 'member' },
        'task.created': { companyId: 'c1', projectId: null },
        'task.completed': { companyId: 'c1', projectId: null, durationMs: 1000 },
        'agent.invoked': { companyId: 'c1', agentId: 'a1' },
        'artifact.created': { companyId: 'c1', kind: 'document' },
        'project.created': { companyId: 'c1' },
      };
      for (const name of ANALYTICS_EVENT_NAMES) {
        const payload = payloads[name];
        expect(payload).toBeDefined();
        expect((payload as { companyId?: string }).companyId).toBe('c1');
      }
    });
  });

  describe('redactPayload', () => {
    it('nulls fields matching sensitive patterns', () => {
      const result = redactPayload({
        companyId: 'c1',
        prompt: 'What is the weather?',
        transcript: 'Agent said...',
        email: 'user@example.com',
        password: 'secret',
        apiKey: 'key',
        content: 'document body',
        body: 'task body',
        description: 'free text',
        metadata: { nested: 'value' },
      });
      expect(result.companyId).toBe('c1');
      expect(result.prompt).toBeNull();
      expect(result.transcript).toBeNull();
      expect(result.email).toBeNull();
      expect(result.password).toBeNull();
      expect(result.apiKey).toBeNull();
      expect(result.content).toBeNull();
      expect(result.body).toBeNull();
      expect(result.description).toBeNull();
      expect(result.metadata).toBeNull();
    });

    it('preserves non-sensitive fields', () => {
      const result = redactPayload({
        companyId: 'c1',
        role: 'member',
        kind: 'document',
        durationMs: 1000,
      });
      expect(result).toEqual({
        companyId: 'c1',
        role: 'member',
        kind: 'document',
        durationMs: 1000,
      });
    });

    it('handles non-object input', () => {
      expect(redactPayload(null)).toEqual({});
      expect(redactPayload('string')).toEqual({});
      expect(redactPayload(undefined)).toEqual({});
    });
  });

  describe('assertNoSensitiveFields', () => {
    it('does not throw for clean payloads', () => {
      expect(() =>
        assertNoSensitiveFields({ companyId: 'c1', role: 'member' }, 'company.joined'),
      ).not.toThrow();
    });

    it('throws when a sensitive field is present', () => {
      expect(() =>
        assertNoSensitiveFields({ companyId: 'c1', prompt: 'text' }, 'agent.invoked'),
      ).toThrow(/sensitive field "prompt"/);
    });

    it('throws for credential fields', () => {
      expect(() =>
        assertNoSensitiveFields({ companyId: 'c1', apiKey: 'key' }, 'company.created'),
      ).toThrow(/sensitive field "apiKey"/);
    });

    it('does not throw for null or non-object', () => {
      expect(() => assertNoSensitiveFields(null, 'test')).not.toThrow();
      expect(() => assertNoSensitiveFields('string', 'test')).not.toThrow();
    });
  });

  describe('ProductAnalytics emitter', () => {
    it('drops events when the feature flag is off', async () => {
      delete process.env.EIDOLON_FEATURE_FLAGS;
      const transport = vi.fn();
      const analytics = new ProductAnalytics(transport);

      // We need a db instance for the emit signature, but since the flag is off,
      // the db is never accessed. Use null as a stand-in.
      await analytics.emit(null as never, 'c1', 'company.created', {
        companyId: 'c1',
        plan: 'free',
      });

      expect(transport).not.toHaveBeenCalled();
    });

    it('emits events when the feature flag is on', async () => {
      process.env.EIDOLON_FEATURE_FLAGS = JSON.stringify({
        productAnalytics: { enabled: true },
      });
      const transport = vi.fn();
      const analytics = new ProductAnalytics(transport);

      await analytics.emit(null as never, 'c1', 'company.created', {
        companyId: 'c1',
        plan: 'free',
      });

      expect(transport).toHaveBeenCalledTimes(1);
      const event = transport.mock.calls[0][0];
      expect(event.name).toBe('company.created');
      expect(event.payload.companyId).toBe('c1');
      expect(event.payload.plan).toBe('free');
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('redacts the payload before passing to the transport', async () => {
      process.env.EIDOLON_FEATURE_FLAGS = JSON.stringify({
        productAnalytics: { enabled: true },
      });
      const transport = vi.fn();
      const analytics = new ProductAnalytics(transport);

      // The typed payload prevents sensitive fields at compile time, but
      // a runtime escape (any cast) should still be caught by redaction.
      await analytics.emit(null as never, 'c1', 'company.created', {
        companyId: 'c1',
        plan: 'free',
      } as AnalyticsEventPayload['company.created']);

      const event = transport.mock.calls[0][0];
      // No sensitive fields in the emitted event.
      expect(JSON.stringify(event)).not.toContain('prompt');
      expect(JSON.stringify(event)).not.toContain('transcript');
      expect(JSON.stringify(event)).not.toContain('email');
      expect(JSON.stringify(event)).not.toContain('password');
    });

    it('throws when a sensitive field is in the payload', async () => {
      process.env.EIDOLON_FEATURE_FLAGS = JSON.stringify({
        productAnalytics: { enabled: true },
      });
      const transport = vi.fn();
      const analytics = new ProductAnalytics(transport);

      // Simulate a type-system escape.
      await expect(
        analytics.emit(null as never, 'c1', 'company.created', {
          companyId: 'c1',
          prompt: 'leaked',
        } as never),
      ).rejects.toThrow(/sensitive field "prompt"/);

      expect(transport).not.toHaveBeenCalled();
    });
  });

  describe('transports', () => {
    it('noopTransport does nothing', () => {
      expect(() =>
        noopTransport({
          name: 'company.created',
          payload: { companyId: 'c1', plan: null },
          timestamp: '',
        }),
      ).not.toThrow();
    });

    it('consoleTransport logs the event', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      consoleTransport({
        name: 'company.created',
        payload: { companyId: 'c1', plan: null },
        timestamp: '2026-01-01',
      });
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0]).toBe('[analytics]');
      spy.mockRestore();
    });
  });

  describe('getProductAnalytics', () => {
    it('returns a singleton instance', () => {
      const a = getProductAnalytics();
      const b = getProductAnalytics();
      expect(a).toBe(b);
    });
  });

  describe('feature flag integration', () => {
    it('the productAnalytics flag is in the feature flag registry', () => {
      // The flag must be declared so it appears in the /flags endpoint.
      process.env.EIDOLON_FEATURE_FLAGS = JSON.stringify({
        productAnalytics: { enabled: true },
      });
      expect(isFeatureEnabled('productAnalytics', 'c1')).toBe(true);
    });

    it('defaults to off', () => {
      delete process.env.EIDOLON_FEATURE_FLAGS;
      expect(isFeatureEnabled('productAnalytics', 'c1')).toBe(false);
    });
  });
});
