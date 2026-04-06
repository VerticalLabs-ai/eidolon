// ---------------------------------------------------------------------------
// Agent Executor -- Runs AI provider completions for agent tasks
// ---------------------------------------------------------------------------

import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getProvider } from '../providers/index.js';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../providers/types.js';
import { decrypt } from './crypto.js';
import { BudgetEnforcer } from './budget-enforcer.js';
import { KnowledgeService } from './knowledge.js';
import { MemoryService } from './memory.js';
import eventBus from '../realtime/events.js';
import logger from '../utils/logger.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  executionId: string;
  agentId: string;
  taskId: string;
  status: 'completed' | 'failed';
  completion: CompletionResult | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// AgentExecutor
// ---------------------------------------------------------------------------

export class AgentExecutor {
  private budgetEnforcer: BudgetEnforcer;
  private knowledgeService: KnowledgeService;
  private memoryService: MemoryService;

  constructor(private db: DbInstance) {
    this.budgetEnforcer = new BudgetEnforcer(db);
    this.knowledgeService = new KnowledgeService(db);
    this.memoryService = new MemoryService(db);
  }

  /**
   * Execute an agent against a specific task.
   *
   * Orchestrates the full lifecycle:
   *   1. Load agent, task, and company data
   *   2. Validate budget and agent state
   *   3. Build prompt context
   *   4. Call the AI provider
   *   5. Record execution, cost, and update task status
   */
  async executeTask(
    agentId: string,
    taskId: string,
    companyId: string,
  ): Promise<ExecutionResult> {
    const { agents, tasks, companies, agentExecutions } = this.db.schema;

    // ------------------------------------------------------------------
    // 1. Load agent
    // ------------------------------------------------------------------
    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1);

    if (!agent) {
      throw new Error(`Agent ${agentId} not found in company ${companyId}`);
    }

    // ------------------------------------------------------------------
    // 2. Load task
    // ------------------------------------------------------------------
    const [task] = await this.db.drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
      .limit(1);

    if (!task) {
      throw new Error(`Task ${taskId} not found in company ${companyId}`);
    }

    // ------------------------------------------------------------------
    // 3. Load company context
    // ------------------------------------------------------------------
    const [company] = await this.db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!company) {
      throw new Error(`Company ${companyId} not found`);
    }

    // ------------------------------------------------------------------
    // 4. Check budget
    // ------------------------------------------------------------------
    const budgetCheck = await this.budgetEnforcer.checkBudget(agentId);
    if (budgetCheck && !budgetCheck.withinBudget) {
      throw new Error(
        `Agent ${agent.name} has exceeded its monthly budget ` +
        `(spent ${budgetCheck.spentCents}c of ${budgetCheck.budgetCents}c). ` +
        `Execution blocked.`,
      );
    }

    // ------------------------------------------------------------------
    // 5. Decrypt API key
    // ------------------------------------------------------------------
    let apiKey: string | undefined;
    if (agent.apiKeyEncrypted) {
      try {
        apiKey = decrypt(agent.apiKeyEncrypted);
      } catch (err) {
        throw new Error(
          `Failed to decrypt API key for agent ${agent.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // For providers that require an API key, validate presence
    const providerName: string = agent.provider;
    if (!apiKey && providerName !== 'ollama' && providerName !== 'local') {
      throw new Error(
        `Agent ${agent.name} has no API key configured for provider "${providerName}". ` +
        `Set an encrypted API key on the agent before executing.`,
      );
    }

    // ------------------------------------------------------------------
    // 6. Build messages (with knowledge base + memory context)
    // ------------------------------------------------------------------
    let knowledgeContext = '';
    try {
      const taskDesc = `${task.title} ${task.description ?? ''}`;
      knowledgeContext = await this.knowledgeService.getContextForAgent(
        companyId,
        agentId,
        taskDesc,
      );
    } catch (err) {
      logger.warn({ err, agentId, taskId }, 'Failed to fetch knowledge context (non-fatal)');
    }

    let memoryContext = '';
    try {
      const taskDesc = `${task.title} ${task.description ?? ''}`;
      memoryContext = await this.memoryService.buildMemoryContext(agentId, taskDesc);
    } catch (err) {
      logger.warn({ err, agentId, taskId }, 'Failed to fetch memory context (non-fatal)');
    }

    const messages = this.buildContext(agent, task, company, knowledgeContext, memoryContext);

    // ------------------------------------------------------------------
    // 7. Create execution record
    // ------------------------------------------------------------------
    const execId = randomUUID();
    const now = new Date();

    await this.db.drizzle.insert(agentExecutions).values({
      id: execId,
      companyId,
      agentId,
      taskId,
      status: 'running',
      startedAt: now,
      modelUsed: agent.model,
      provider: providerName,
      createdAt: now,
    });

    // Update agent status to working
    await this.db.drizzle
      .update(agents)
      .set({ status: 'working', updatedAt: now })
      .where(eq(agents.id, agentId));

    eventBus.emitEvent({
      type: 'execution.started' as any,
      companyId,
      payload: { executionId: execId, agentId, taskId },
      timestamp: now.toISOString(),
    });

    // Update task status to in_progress
    await this.db.drizzle
      .update(tasks)
      .set({ status: 'in_progress', startedAt: now, updatedAt: now })
      .where(eq(tasks.id, taskId));

    // ------------------------------------------------------------------
    // 8. Call the AI provider
    // ------------------------------------------------------------------
    let completion: CompletionResult | null = null;

    try {
      const provider = getProvider(providerName);
      const providerConfig: ProviderConfig = {
        apiKey,
        model: agent.model,
        temperature: agent.temperature ?? 0.7,
        maxTokens: agent.maxTokens ?? 4096,
      };

      completion = await provider.chat(messages, providerConfig);

      logger.info(
        {
          agentId,
          taskId,
          execId,
          model: completion.model,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costCents: completion.costCents,
          latencyMs: completion.latencyMs,
        },
        'Agent execution completed successfully',
      );
    } catch (providerError) {
      // Provider call failed -- record error and return
      const errorMsg = providerError instanceof Error ? providerError.message : String(providerError);
      const failedAt = new Date();

      await this.db.drizzle
        .update(agentExecutions)
        .set({
          status: 'failed',
          completedAt: failedAt,
          error: errorMsg,
          log: [
            {
              timestamp: failedAt.toISOString(),
              level: 'error',
              message: `Provider call failed: ${errorMsg}`,
            },
          ],
        })
        .where(eq(agentExecutions.id, execId));

      // Reset agent status
      await this.db.drizzle
        .update(agents)
        .set({ status: 'error', updatedAt: failedAt })
        .where(eq(agents.id, agentId));

      eventBus.emitEvent({
        type: 'execution.completed' as any,
        companyId,
        payload: { executionId: execId, agentId, taskId, status: 'failed', error: errorMsg },
        timestamp: failedAt.toISOString(),
      });

      return {
        executionId: execId,
        agentId,
        taskId,
        status: 'failed',
        completion: null,
        error: errorMsg,
      };
    }

    // ------------------------------------------------------------------
    // 9. Record success
    // ------------------------------------------------------------------
    const completedAt = new Date();

    // Build a summary from the first 500 chars of the response
    const summary = completion.content.length > 500
      ? completion.content.slice(0, 497) + '...'
      : completion.content;

    await this.db.drizzle
      .update(agentExecutions)
      .set({
        status: 'completed',
        completedAt,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        costCents: completion.costCents,
        modelUsed: completion.model,
        provider: completion.provider,
        summary,
        log: [
          {
            timestamp: now.toISOString(),
            level: 'info',
            message: `Execution started with model ${completion.model}`,
          },
          {
            timestamp: completedAt.toISOString(),
            level: 'info',
            message: `Completed in ${completion.latencyMs}ms. Tokens: ${completion.inputTokens} in / ${completion.outputTokens} out. Cost: ${completion.costCents}c`,
          },
        ],
      })
      .where(eq(agentExecutions.id, execId));

    // Record cost via the budget enforcer
    if (completion.costCents > 0) {
      await this.budgetEnforcer.recordCost(agentId, completion.costCents, {
        taskId,
        provider: completion.provider,
        model: completion.model,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
    }

    // Update task with actual token usage
    await this.db.drizzle
      .update(tasks)
      .set({
        status: 'review',
        actualTokens: completion.inputTokens + completion.outputTokens,
        updatedAt: completedAt,
      })
      .where(eq(tasks.id, taskId));

    // Reset agent status to idle
    await this.db.drizzle
      .update(agents)
      .set({ status: 'idle', updatedAt: completedAt })
      .where(eq(agents.id, agentId));

    eventBus.emitEvent({
      type: 'execution.completed' as any,
      companyId,
      payload: {
        executionId: execId,
        agentId,
        taskId,
        status: 'completed',
        summary,
        costCents: completion.costCents,
        latencyMs: completion.latencyMs,
      },
      timestamp: completedAt.toISOString(),
    });

    // ------------------------------------------------------------------
    // 10. Store execution observation as agent memory
    // ------------------------------------------------------------------
    try {
      await this.memoryService.remember(agentId, companyId, {
        content: `Completed task "${task.title}" (${task.type}, ${task.priority} priority). Result: ${summary.slice(0, 200)}`,
        memoryType: 'observation',
        importance: task.priority === 'critical' ? 8 : task.priority === 'high' ? 7 : 5,
        sourceTaskId: taskId,
        sourceExecutionId: execId,
        tags: ['execution', 'task-completion', task.type],
      });
    } catch (err) {
      logger.warn({ err, agentId, taskId }, 'Failed to store execution memory (non-fatal)');
    }

    return {
      executionId: execId,
      agentId,
      taskId,
      status: 'completed',
      completion,
    };
  }

  // -------------------------------------------------------------------------
  // Context builder
  // -------------------------------------------------------------------------

  /**
   * Build the ChatMessage array for the AI provider.
   *
   * System message includes:
   *   - Agent identity (name, role, title)
   *   - Agent instructions / system prompt
   *   - Company context (name, mission)
   *
   * User message includes:
   *   - Task title, description, priority, type
   */
  buildContext(
    agent: Record<string, any>,
    task: Record<string, any>,
    company: Record<string, any>,
    knowledgeContext?: string,
    memoryContext?: string,
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // -- System message ---------------------------------------------------
    const systemParts: string[] = [];

    // Agent identity
    systemParts.push(
      `You are ${agent.name}, an AI agent with the role of ${agent.role}` +
      (agent.title ? ` (${agent.title})` : '') +
      ` at ${company.name}.`,
    );

    // Company context
    if (company.mission) {
      systemParts.push(`Company mission: ${company.mission}`);
    }
    if (company.description) {
      systemParts.push(`Company description: ${company.description}`);
    }

    // Agent instructions (highest priority -- comes last to override)
    if (agent.instructions) {
      systemParts.push(`Your instructions:\n${agent.instructions}`);
    } else if (agent.systemPrompt) {
      systemParts.push(`Your instructions:\n${agent.systemPrompt}`);
    }

    // Capabilities context
    if (agent.capabilities && agent.capabilities.length > 0) {
      systemParts.push(`Your capabilities: ${agent.capabilities.join(', ')}`);
    }

    // Knowledge base context (relevant documents for this task)
    if (knowledgeContext && knowledgeContext.trim().length > 0) {
      systemParts.push(knowledgeContext);
    }

    // Agent memory context (past decisions, observations, lessons)
    if (memoryContext && memoryContext.trim().length > 0) {
      systemParts.push(memoryContext);
    }

    messages.push({
      role: 'system',
      content: systemParts.join('\n\n'),
    });

    // -- User message (the task) ------------------------------------------
    const taskParts: string[] = [];
    taskParts.push(`Task: ${task.title}`);
    if (task.description) {
      taskParts.push(`Description: ${task.description}`);
    }
    taskParts.push(`Priority: ${task.priority}`);
    taskParts.push(`Type: ${task.type}`);

    if (task.tags && task.tags.length > 0) {
      taskParts.push(`Tags: ${task.tags.join(', ')}`);
    }

    messages.push({
      role: 'user',
      content: taskParts.join('\n'),
    });

    return messages;
  }
}
