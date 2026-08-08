import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import { AgenticLoop } from '../services/agentic-loop.js';
import { getProvider } from '../providers/index.js';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../providers/types.js';
import type { DbInstance } from '../types.js';

/**
 * Integration test for the server-level API key fallback.
 *
 * Agents created through the validation API have provider/model set but no
 * per-agent apiKeyEncrypted. The agentic loop must fall back to the
 * server-level ANTHROPIC_API_KEY (OPENAI_API_KEY for openai) instead of
 * failing with "has no API key configured for provider ...".
 *
 * This test creates an agent with no per-agent key, stubs the server-level
 * env var, mocks the provider so no real LLM call is made, runs the loop,
 * and asserts the loop used the server-level key and completed.
 */
describe('Agentic loop server-level API key fallback', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let agentId: string;
  let chatSpy: MockInstance<
    (messages: ChatMessage[], config: ProviderConfig) => Promise<CompletionResult>
  >;

  beforeEach(async () => {
    // Stub the server-level key BEFORE the loop reads it.
    vi.stubEnv('ANTHROPIC_API_KEY', 'server-level-anthropic-key');

    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Key Fallback Corp', budgetMonthlyCents: 100000 })
      .expect(201);
    companyId = company.body.data.id;

    // Create an agent with provider/model set but NO per-agent apiKeyEncrypted.
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'No-Key Agent', role: 'engineer', provider: 'anthropic' })
      .expect(201);
    agentId = agent.body.data.id;

    // Confirm the agent truly has no per-agent key.
    const [row] = await db.drizzle
      .select()
      .from(db.schema.agents)
      .where(eq(db.schema.agents.id, agentId))
      .limit(1);
    expect(row?.apiKeyEncrypted).toBeNull();

    // Mock the provider so no real LLM call is made. Capture the apiKey the
    // loop passes in the ProviderConfig. The loop calls provider.chat(...).
    const provider = getProvider('anthropic');
    chatSpy = vi.spyOn(provider, 'chat').mockResolvedValue({
      content: '<task_complete>Done using the server-level key.</task_complete>',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      costCents: 1,
      finishReason: 'stop',
      latencyMs: 12,
    } satisfies CompletionResult);
  });

  afterEach(() => {
    chatSpy?.mockRestore();
    vi.unstubAllEnvs();
  });

  it('runs the agentic loop using the server-level ANTHROPIC_API_KEY when the agent has no per-agent key', async () => {
    const taskId = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.tasks).values({
      id: taskId,
      companyId,
      title: 'Fallback key task',
      description: 'Produce a short summary.',
      type: 'feature',
      priority: 'medium',
      status: 'todo',
      assigneeAgentId: agentId,
      dependencies: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const loop = new AgenticLoop(db, { maxIterations: 3 });
    const result = await loop.run(agentId, taskId, companyId);

    // The loop must NOT fail with the "no API key" error.
    expect(result.status).toBe('completed');
    expect(result.finalOutput).toContain('Done using the server-level key.');
    expect(result.finalOutput).not.toMatch(/no API key configured/);

    // The provider must have been invoked with the server-level key.
    expect(chatSpy).toHaveBeenCalledTimes(1);
    const passedConfig = chatSpy.mock.calls[0][1];
    expect(passedConfig.apiKey).toBe('server-level-anthropic-key');
  });

  it('throws a clear error when neither a per-agent key nor a server-level key is configured', async () => {
    // Remove the server-level key so no fallback is available.
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const taskId = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.tasks).values({
      id: taskId,
      companyId,
      title: 'No key anywhere task',
      description: 'Should fail fast.',
      type: 'feature',
      priority: 'medium',
      status: 'todo',
      assigneeAgentId: agentId,
      dependencies: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    });

    const loop = new AgenticLoop(db, { maxIterations: 3 });
    await expect(loop.run(agentId, taskId, companyId)).rejects.toThrow(
      /no API key configured for provider "anthropic"/,
    );
    // The provider must never have been called.
    expect(chatSpy).not.toHaveBeenCalled();
  });
});
