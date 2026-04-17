import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';
import { listAdapters, getAdapter } from '../providers/index.js';

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
    const db = createTestDb();
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
