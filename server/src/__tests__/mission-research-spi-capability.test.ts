import { describe, expect, it } from 'vitest';
import {
  RESEARCH_OPERATIONS,
  PROVIDER_OPERATIONS,
  isOperationSupported,
  getUnsupportedOperationError,
  validateOperationCapability,
} from '../services/mission/research/operations.js';
import {
  TAVILY_ORIGIN,
  FIRECRAWL_ORIGIN,
  PROVIDER_ORIGINS,
} from '../services/mission/research/origins.js';
import type { ResearchRequest } from '../services/mission/research/spi.js';
import { TavilyAdapter } from '../services/mission/research/tavily-adapter.js';
import { FirecrawlAdapter } from '../services/mission/research/firecrawl-adapter.js';

/**
 * VAL-RES-006: Provider capability enforcement.
 *
 * Request an operation unsupported by the selected provider with fallback
 * disabled; the operation must fail safely as unsupported before any
 * provider call, without silently translating it into different semantics.
 */

// ---------------------------------------------------------------------------
// Operation capability matrix
// ---------------------------------------------------------------------------

describe('VAL-RES-006: provider operation capability matrix', () => {
  it('exposes exactly four research operations', () => {
    expect(RESEARCH_OPERATIONS).toEqual(['search', 'extract', 'scrape', 'structured_extract']);
  });

  it('Tavily supports only search and extract', () => {
    expect(PROVIDER_OPERATIONS.tavily).toEqual(new Set(['search', 'extract']));
  });

  it('Firecrawl supports search, scrape, and structured_extract', () => {
    expect(PROVIDER_OPERATIONS.firecrawl).toEqual(
      new Set(['search', 'scrape', 'structured_extract']),
    );
  });

  it('isOperationSupported returns true for supported, false for unsupported', () => {
    expect(isOperationSupported('tavily', 'search')).toBe(true);
    expect(isOperationSupported('tavily', 'extract')).toBe(true);
    expect(isOperationSupported('tavily', 'scrape')).toBe(false);
    expect(isOperationSupported('tavily', 'structured_extract')).toBe(false);
    expect(isOperationSupported('firecrawl', 'search')).toBe(true);
    expect(isOperationSupported('firecrawl', 'scrape')).toBe(true);
    expect(isOperationSupported('firecrawl', 'structured_extract')).toBe(true);
    expect(isOperationSupported('firecrawl', 'extract')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unsupported operation rejection (no provider call, no semantic translation)
// ---------------------------------------------------------------------------

describe('VAL-RES-006: unsupported operation fails before any provider call', () => {
  it('validateOperationCapability rejects unsupported operations with a stable code', () => {
    const result = validateOperationCapability('tavily', 'scrape');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('UNSUPPORTED_OPERATION');
    expect(result.message).toContain('scrape');
    expect(result.message).toContain('tavily');
  });

  it('validateOperationCapability accepts supported operations', () => {
    const result = validateOperationCapability('tavily', 'search');
    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('getUnsupportedOperationError returns a safe error without translating semantics', () => {
    const err = getUnsupportedOperationError('firecrawl', 'extract');
    expect(err.code).toBe('UNSUPPORTED_OPERATION');
    expect(err.message).toContain('extract');
    expect(err.message).toContain('firecrawl');
    // The error must NOT suggest translating to a different operation.
    expect(err.message).not.toContain('scrape');
    expect(err.message).not.toContain('structured_extract');
  });
});

// ---------------------------------------------------------------------------
// Tavily adapter: unsupported operations
// ---------------------------------------------------------------------------

describe('VAL-RES-006: Tavily adapter rejects unsupported operations', () => {
  const adapter = new TavilyAdapter({
    apiKey: 'test-key-not-real',
    fetch: async () => new Response('{}', { status: 200 }),
  });

  it('supports() returns false for scrape and structured_extract', () => {
    expect(adapter.supports('search')).toBe(true);
    expect(adapter.supports('extract')).toBe(true);
    expect(adapter.supports('scrape')).toBe(false);
    expect(adapter.supports('structured_extract')).toBe(false);
  });

  it('execute() rejects scrape with UNSUPPORTED_OPERATION before any fetch', async () => {
    let fetchCalled = false;
    const adapterWithTracker = new TavilyAdapter({
      apiKey: 'test-key-not-real',
      fetch: async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      },
    });

    const request: ResearchRequest = {
      operation: 'scrape',
      urls: ['https://example.com'],
      maxResults: 1,
      timeoutMs: 5000,
    };

    await expect(adapterWithTracker.execute(request, {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    expect(fetchCalled).toBe(false);
  });

  it('execute() rejects structured_extract with UNSUPPORTED_OPERATION before any fetch', async () => {
    let fetchCalled = false;
    const adapterWithTracker = new TavilyAdapter({
      apiKey: 'test-key-not-real',
      fetch: async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      },
    });

    const request: ResearchRequest = {
      operation: 'structured_extract',
      urls: ['https://example.com'],
      schema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
      maxResults: 1,
      timeoutMs: 5000,
    };

    await expect(adapterWithTracker.execute(request, {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    expect(fetchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Firecrawl adapter: unsupported operations
// ---------------------------------------------------------------------------

describe('VAL-RES-006: Firecrawl adapter rejects unsupported operations', () => {
  const adapter = new FirecrawlAdapter({
    apiKey: 'test-key-not-real',
    fetch: async () => new Response('{}', { status: 200 }),
  });

  it('supports() returns false for extract (targeted text extraction)', () => {
    expect(adapter.supports('search')).toBe(true);
    expect(adapter.supports('scrape')).toBe(true);
    expect(adapter.supports('structured_extract')).toBe(true);
    expect(adapter.supports('extract')).toBe(false);
  });

  it('execute() rejects extract with UNSUPPORTED_OPERATION before any fetch', async () => {
    let fetchCalled = false;
    const adapterWithTracker = new FirecrawlAdapter({
      apiKey: 'test-key-not-real',
      fetch: async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      },
    });

    const request: ResearchRequest = {
      operation: 'extract',
      urls: ['https://example.com'],
      maxResults: 1,
      timeoutMs: 5000,
    };

    await expect(adapterWithTracker.execute(request, {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    expect(fetchCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixed provider origins
// ---------------------------------------------------------------------------

describe('VAL-RES-006: fixed provider origins are HTTPS-only and compile-time', () => {
  it('Tavily origin is https://api.tavily.com', () => {
    expect(TAVILY_ORIGIN).toBe('https://api.tavily.com');
    expect(TAVILY_ORIGIN.startsWith('https://')).toBe(true);
  });

  it('Firecrawl origin is https://api.firecrawl.dev', () => {
    expect(FIRECRAWL_ORIGIN).toBe('https://api.firecrawl.dev');
    expect(FIRECRAWL_ORIGIN.startsWith('https://')).toBe(true);
  });

  it('PROVIDER_ORIGINS maps both providers to their fixed origins', () => {
    expect(PROVIDER_ORIGINS.tavily).toBe('https://api.tavily.com');
    expect(PROVIDER_ORIGINS.firecrawl).toBe('https://api.firecrawl.dev');
  });
});

// ---------------------------------------------------------------------------
// Adapters never write artifacts or invoke tools
// ---------------------------------------------------------------------------

describe('VAL-RES-006: adapters are pure request/normalize (no artifact or tool writes)', () => {
  it('Tavily adapter does not expose any artifact or tool methods', () => {
    const adapter = new TavilyAdapter({
      apiKey: 'test-key-not-real',
      fetch: async () => new Response('{}', { status: 200 }),
    });
    expect(typeof (adapter as unknown as Record<string, unknown>).writeArtifact).toBe('undefined');
    expect(typeof (adapter as unknown as Record<string, unknown>).invokeTool).toBe('undefined');
    expect(typeof (adapter as unknown as Record<string, unknown>).commitArtifact).toBe('undefined');
  });

  it('Firecrawl adapter does not expose any artifact or tool methods', () => {
    const adapter = new FirecrawlAdapter({
      apiKey: 'test-key-not-real',
      fetch: async () => new Response('{}', { status: 200 }),
    });
    expect(typeof (adapter as unknown as Record<string, unknown>).writeArtifact).toBe('undefined');
    expect(typeof (adapter as unknown as Record<string, unknown>).invokeTool).toBe('undefined');
    expect(typeof (adapter as unknown as Record<string, unknown>).commitArtifact).toBe('undefined');
  });
});
