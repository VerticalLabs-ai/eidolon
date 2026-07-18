import { afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';
import {
  discoverAdapterModels,
  getAdapter,
  getConfiguredProviderBaseUrl,
  listAdapters,
} from '../providers/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Adapter registry', () => {
  it('exposes the four first-party adapters deduplicated', () => {
    const names = listAdapters().map((a) => a.name);
    expect(names).toEqual(['anthropic', 'openai', 'google', 'ollama']);
  });

  it('retrieves adapters by alias', () => {
    expect(getAdapter('local').name).toBe('ollama');
  });

  it('declares anthropic as streaming+tools+vision+reasoning, remote, paid', () => {
    const anthropic = getAdapter('anthropic');
    expect(anthropic.capabilities).toMatchObject({
      streaming: true,
      tools: true,
      vision: true,
      reasoning: true,
      systemPrompt: true,
      costTracking: true,
      requiresApiKey: true,
      local: false,
    });
    expect(anthropic.models.length).toBeGreaterThan(0);
    expect(anthropic.models.find((m) => m.id === 'claude-opus-4-7')).toBeDefined();
  });

  it('declares ollama as local/free with tools disabled', () => {
    const ollama = getAdapter('ollama');
    expect(ollama.capabilities.local).toBe(true);
    expect(ollama.capabilities.requiresApiKey).toBe(false);
    expect(ollama.capabilities.costTracking).toBe(false);
    expect(ollama.capabilities.tools).toBe(false);
  });

  it('throws with a helpful message for unknown adapter names', () => {
    expect(() => getAdapter('bogus')).toThrow(/Unknown adapter.*Available/);
  });
});

describe('GET /api/adapters', () => {
  it('returns adapter capabilities and supported models', async () => {
    const db = await createTestDb();
    const app = createTestApp(db);

    const res = await request(app).get('/api/adapters').expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const anthropic = res.body.data.find((a: any) => a.name === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic.capabilities.streaming).toBe(true);
    expect(
      anthropic.models.some((m: any) => m.id === 'claude-opus-4-7'),
    ).toBe(true);
  });
});

describe('Adapter model discovery', () => {
  it('loads installed Ollama models from the live adapter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [{ name: 'qwen3:8b' }, { model: 'embeddinggemma' }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capabilities: ['completion'] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capabilities: ['embedding'] }), {
          status: 200,
        }),
      );
    vi.stubGlobal(
      'fetch',
      fetchMock,
    );

    const result = await discoverAdapterModels('ollama', {
      baseUrl: 'http://ollama.internal:11435',
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      adapter: 'ollama',
      source: 'live',
      status: 'success',
      models: [{ id: 'qwen3:8b', label: 'qwen3:8b' }],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://ollama.internal:11435/api/show',
      expect.objectContaining({
        body: JSON.stringify({ model: 'qwen3:8b' }),
      }),
    );
  });

  it('uses only the operator-owned Ollama base URL configuration', () => {
    vi.stubEnv(
      'EIDOLON_OLLAMA_BASE_URL',
      'http://ollama.internal:11435/',
    );

    expect(getConfiguredProviderBaseUrl('local')).toBe(
      'http://ollama.internal:11435',
    );
    expect(getConfiguredProviderBaseUrl('openai')).toBeUndefined();
  });

  it('rejects credentials embedded in the Ollama base URL', () => {
    vi.stubEnv(
      'EIDOLON_OLLAMA_BASE_URL',
      'http://operator:fixture@ollama.internal:11435',
    );

    expect(() => getConfiguredProviderBaseUrl('ollama')).toThrow(
      'without embedded credentials',
    );
  });

  it('keeps the static catalog when live discovery fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Ollama is not reachable')),
    );

    const result = await discoverAdapterModels('ollama', { timeoutMs: 100 });

    expect(result.source).toBe('static');
    expect(result.status).toBe('error');
    expect(result.models).toEqual(getAdapter('ollama').models);
    expect(result.diagnostic).toContain('Ollama is not reachable');
    expect(result.diagnostic).toContain('static catalog remains available');
  });

  it('returns an actionable credential diagnostic for cloud adapters', async () => {
    const result = await discoverAdapterModels('openai', {});

    expect(result.source).toBe('static');
    expect(result.status).toBe('error');
    expect(result.diagnostic).toContain('OpenAI API key is required');
  });

  it('filters non-chat OpenAI models from the live catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-5.4' },
              { id: 'gpt-image-1' },
              { id: 'gpt-4o-realtime-preview' },
              { id: 'o3-deep-research' },
              { id: 'o4-mini' },
              { id: 'ft:gpt-4o-mini:org:customer-search:abc' },
              { id: 'gpt-5-pro' },
              { id: 'gpt-4o-search-preview' },
              { id: 'gpt-audio' },
              { id: 'chat-latest' },
              { id: 'chatgpt-4o-latest' },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await discoverAdapterModels('openai', {
      authorization: 'fixture',
    });

    expect(result.models.map((model) => model.id)).toEqual([
      'chat-latest',
      'chatgpt-4o-latest',
      'ft:gpt-4o-mini:org:customer-search:abc',
      'gpt-4o-search-preview',
      'gpt-5.4',
      'gpt-audio',
      'o4-mini',
    ]);
  });

  it('paginates Anthropic model discovery', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'claude-first', display_name: 'Claude First' }],
            has_more: true,
            last_id: 'claude-first',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'claude-second', display_name: 'Claude Second' }],
            has_more: false,
            last_id: 'claude-second',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverAdapterModels('anthropic', {
      authorization: 'fixture',
    });

    expect(result.models.map((model) => model.id)).toEqual([
      'claude-first',
      'claude-second',
    ]);
    expect(
      (fetchMock.mock.calls[1][0] as URL).searchParams.get('after_id'),
    ).toBe('claude-first');
  });

  it('paginates Google models and keeps authorization out of the URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-first',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
            nextPageToken: 'cursor',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-second',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/text-embedding',
                supportedGenerationMethods: ['embedContent'],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverAdapterModels('google', {
      authorization: 'fixture',
    });

    expect(result.models.map((model) => model.id)).toEqual([
      'gemini-first',
      'gemini-second',
    ]);
    const firstUrl = fetchMock.mock.calls[0][0] as URL;
    const secondUrl = fetchMock.mock.calls[1][0] as URL;
    expect(firstUrl.searchParams.has('key')).toBe(false);
    expect(secondUrl.searchParams.get('pageToken')).toBe('cursor');
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: { 'x-goog-api-key': expect.any(String) },
      }),
    );
  });
});
