// ---------------------------------------------------------------------------
// Agentic Loop Runtime -- Multi-step autonomous agent execution
// ---------------------------------------------------------------------------
//
// Implements the Observe -> Think -> Act -> Reflect pattern for agents.
// Each iteration the model can choose to use tools (via MCP) or complete
// the task. The loop continues until completion, failure, or max iterations.
// ---------------------------------------------------------------------------

import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getProvider } from '../providers/index.js';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../providers/types.js';
import { KnowledgeService } from './knowledge.js';
import { MemoryService } from './memory.js';
import { MCPClientService } from './mcp-client.js';
import { BudgetEnforcer } from './budget-enforcer.js';
import { decrypt } from './crypto.js';
import { continuationRetryDueAt, retryDueAt } from './execution-retry.js';
import eventBus from '../realtime/events.js';
import logger from '../utils/logger.js';
import type { DbInstance } from '../types.js';

export const MAX_CONTINUATION_RETRIES = 3;

type AgenticLoopRetryMetadata = {
  retryAttempt: number;
  retryStatus: 'none' | 'scheduled' | 'exhausted';
  retryDueAt: Date | null;
  failureCategory: string | null;
};

export function buildAgenticLoopRetryMetadata(
  status: LoopResult['status'],
  completedAt: Date,
  currentRetryAttempt: number,
): AgenticLoopRetryMetadata {
  const nextAttempt = currentRetryAttempt + 1;

  if (status === 'failed') {
    if (nextAttempt > MAX_CONTINUATION_RETRIES) {
      return {
        retryAttempt: currentRetryAttempt,
        retryStatus: 'exhausted',
        retryDueAt: null,
        failureCategory: 'agentic_loop_error',
      };
    }

    return {
      retryAttempt: nextAttempt,
      retryStatus: 'scheduled',
      retryDueAt: retryDueAt(completedAt, nextAttempt),
      failureCategory: 'agentic_loop_error',
    };
  }

  if (status === 'max_steps_reached') {
    if (nextAttempt > MAX_CONTINUATION_RETRIES) {
      return {
        retryAttempt: currentRetryAttempt,
        retryStatus: 'exhausted',
        retryDueAt: null,
        failureCategory: 'max_steps_reached',
      };
    }

    return {
      retryAttempt: nextAttempt,
      retryStatus: 'scheduled',
      retryDueAt: continuationRetryDueAt(completedAt),
      failureCategory: 'max_steps_reached',
    };
  }

  return {
    retryAttempt: currentRetryAttempt,
    retryStatus: 'none',
    retryDueAt: null,
    failureCategory: null,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopStep {
  phase: 'observe' | 'think' | 'act' | 'reflect';
  content: string;
  toolCalls?: Array<{
    tool: string;
    serverId?: string;
    args: Record<string, unknown>;
    result: string;
  }>;
  timestamp: string;
}

export interface LoopResult {
  executionId: string;
  agentId: string;
  taskId: string;
  status: 'completed' | 'failed' | 'needs_input' | 'max_steps_reached';
  steps: LoopStep[];
  finalOutput: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  iterations: number;
}

// ---------------------------------------------------------------------------
// AgenticLoop
// ---------------------------------------------------------------------------

export class AgenticLoop {
  private maxIterations: number;
  private knowledgeService: KnowledgeService;
  private memoryService: MemoryService;
  private mcpService: MCPClientService;
  private budgetEnforcer: BudgetEnforcer;

  constructor(
    private db: DbInstance,
    options?: { maxIterations?: number },
  ) {
    this.maxIterations = options?.maxIterations ?? 10;
    this.knowledgeService = new KnowledgeService(db);
    this.memoryService = new MemoryService(db);
    this.mcpService = new MCPClientService(db);
    this.budgetEnforcer = new BudgetEnforcer(db);
  }

  /**
   * Run the full agentic loop for a given agent and task.
   */
  async run(agentId: string, taskId: string, companyId: string): Promise<LoopResult> {
    const { agents, tasks, companies, agentExecutions } = this.db.schema;

    // ------------------------------------------------------------------
    // 1. Load agent, task, company
    // ------------------------------------------------------------------
    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1);

    const [task] = await this.db.drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
      .limit(1);

    const [company] = await this.db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!agent) throw new Error(`Agent ${agentId} not found in company ${companyId}`);
    if (!task) throw new Error(`Task ${taskId} not found in company ${companyId}`);
    if (!company) throw new Error(`Company ${companyId} not found`);

    // ------------------------------------------------------------------
    // 2. Check budget
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
    // 3. Decrypt API key
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

    const providerName: string = agent.provider;
    if (!apiKey && providerName !== 'ollama' && providerName !== 'local') {
      throw new Error(
        `Agent ${agent.name} has no API key configured for provider "${providerName}".`,
      );
    }

    const provider = getProvider(providerName);
    const providerConfig: ProviderConfig = {
      apiKey,
      model: agent.model,
      temperature: agent.temperature ?? 0.7,
      maxTokens: agent.maxTokens ?? 4096,
    };

    // ------------------------------------------------------------------
    // 4. Build initial context
    // ------------------------------------------------------------------
    const taskDesc = `${task.title} ${task.description ?? ''}`;

    let knowledgeContext = '';
    try {
      knowledgeContext = await this.knowledgeService.getContextForAgent(companyId, agentId, taskDesc);
    } catch (err) {
      logger.warn({ err, agentId, taskId }, 'Failed to fetch knowledge context (non-fatal)');
    }

    let memoryContext = '';
    try {
      memoryContext = await this.memoryService.buildMemoryContext(agentId, taskDesc);
    } catch (err) {
      logger.warn({ err, agentId, taskId }, 'Failed to fetch memory context (non-fatal)');
    }

    let mcpTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; serverId: string; serverName: string }> = [];
    try {
      mcpTools = await this.mcpService.getAvailableTools(companyId);
    } catch (err) {
      logger.warn({ err, companyId }, 'Failed to fetch MCP tools (non-fatal)');
    }

    // ------------------------------------------------------------------
    // 5. Build system prompt and initial messages
    // ------------------------------------------------------------------
    const systemPrompt = this.buildSystemPrompt(agent, company, knowledgeContext, memoryContext, mcpTools);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: this.buildTaskPrompt(task) },
    ];

    // ------------------------------------------------------------------
    // 6. Create execution record
    // ------------------------------------------------------------------
    const execId = randomUUID();
    const startedAt = new Date();

    await this.db.drizzle.insert(agentExecutions).values({
      id: execId,
      companyId,
      agentId,
      taskId,
      status: 'running',
      startedAt,
      modelUsed: agent.model,
      provider: providerName,
      executionMode: 'agentic-loop',
      lastEventAt: startedAt,
      createdAt: startedAt,
    });

    // Set agent to working
    await this.db.drizzle
      .update(agents)
      .set({ status: 'working', updatedAt: startedAt })
      .where(eq(agents.id, agentId));

    // Set task to in_progress
    await this.db.drizzle
      .update(tasks)
      .set({ status: 'in_progress', startedAt, updatedAt: startedAt })
      .where(eq(tasks.id, taskId));

    eventBus.emitEvent({
      type: 'execution.started',
      companyId,
      payload: {
        executionId: execId,
        agentId,
        taskId,
        agentName: agent.name,
        taskTitle: task.title,
        mode: 'agentic-loop',
      },
      timestamp: startedAt.toISOString(),
    });

    // ------------------------------------------------------------------
    // 7. Run the agentic loop
    // ------------------------------------------------------------------
    const steps: LoopStep[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostCents = 0;
    let iterations = 0;
    let status: LoopResult['status'] = 'completed';
    let finalOutput = '';

    for (let i = 0; i < this.maxIterations; i++) {
      iterations++;

      try {
        const result: CompletionResult = await provider.chat(messages, providerConfig);

        totalInputTokens += result.inputTokens;
        totalOutputTokens += result.outputTokens;
        totalCostCents += result.costCents;

        // Build step record
        const step: LoopStep = {
          phase: 'act',
          content: result.content,
          timestamp: new Date().toISOString(),
        };

        // Check for tool call pattern in output
        const toolCallMatch = result.content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);

        if (toolCallMatch) {
          // ---- TOOL CALL BRANCH ----
          try {
            const toolCall = JSON.parse(toolCallMatch[1]);
            const toolServerId = toolCall.serverId || this.resolveServerId(mcpTools, toolCall.name);

            const toolResult = await this.mcpService.callTool(
              toolServerId,
              toolCall.name,
              toolCall.args ?? {},
            );

            const toolResultText = toolResult.content
              .map((c) => c.text ?? '')
              .filter(Boolean)
              .join('\n');

            step.toolCalls = [{
              tool: toolCall.name,
              serverId: toolServerId,
              args: toolCall.args ?? {},
              result: toolResultText,
            }];

            // Feed tool result back into the conversation
            messages.push({ role: 'assistant', content: result.content });
            messages.push({
              role: 'user',
              content: `Tool result for "${toolCall.name}":\n${toolResultText}`,
            });
          } catch (toolErr) {
            const errorMsg = toolErr instanceof Error ? toolErr.message : 'Unknown tool error';
            step.toolCalls = [{
              tool: 'unknown',
              args: {},
              result: `Error: ${errorMsg}`,
            }];

            messages.push({ role: 'assistant', content: result.content });
            messages.push({
              role: 'user',
              content: `Tool error: ${errorMsg}\n\nPlease continue with the task or try a different approach.`,
            });
          }

          steps.push(step);

          // Emit progress
          eventBus.emitEvent({
            type: 'execution.log',
            companyId,
            payload: {
              executionId: execId,
              agentId,
              step,
              iteration: i + 1,
              totalIterations: this.maxIterations,
            },
            timestamp: step.timestamp,
          });

          continue; // Loop back for model to process tool result
        }

        // ---- NO TOOL CALL -- CHECK FOR COMPLETION ----
        steps.push(step);

        const isComplete =
          result.content.includes('<task_complete>') ||
          result.content.includes('TASK COMPLETE') ||
          (result.finishReason === 'stop' && i > 0); // First iteration stop is not completion

        // Emit progress
        eventBus.emitEvent({
          type: 'execution.log',
          companyId,
          payload: {
            executionId: execId,
            agentId,
            step,
            iteration: i + 1,
            totalIterations: this.maxIterations,
            isComplete,
          },
          timestamp: step.timestamp,
        });

        if (isComplete) {
          // Clean completion markers from output
          finalOutput = result.content
            .replace(/<task_complete>/g, '')
            .replace(/TASK COMPLETE/g, '')
            .trim();
          status = 'completed';
          break;
        }

        if (i === this.maxIterations - 1) {
          // Last iteration -- extract whatever we have
          finalOutput = result.content.trim();
          status = 'max_steps_reached';
          break;
        }

        // Continue the loop
        messages.push({ role: 'assistant', content: result.content });
        messages.push({
          role: 'user',
          content: 'Continue working on the task. If you are done, include <task_complete> in your response.',
        });

      } catch (err) {
        status = 'failed';
        finalOutput = err instanceof Error ? err.message : 'Unknown error during execution';

        steps.push({
          phase: 'reflect',
          content: `Error during iteration ${i + 1}: ${finalOutput}`,
          timestamp: new Date().toISOString(),
        });

        logger.error(
          { err, agentId, taskId, execId, iteration: i + 1 },
          'Agentic loop iteration failed',
        );

        break;
      }
    }

    // ------------------------------------------------------------------
    // 8. Finalize execution
    // ------------------------------------------------------------------
    const completedAt = new Date();

    const summary = finalOutput.length > 500
      ? finalOutput.slice(0, 497) + '...'
      : finalOutput;

    const [currentExecution] = await this.db.drizzle
      .select({ retryAttempt: agentExecutions.retryAttempt })
      .from(agentExecutions)
      .where(eq(agentExecutions.id, execId))
      .limit(1);

    // Update execution record
    const retryMetadata = buildAgenticLoopRetryMetadata(
      status,
      completedAt,
      currentExecution?.retryAttempt ?? 0,
    );

    await this.db.drizzle
      .update(agentExecutions)
      .set({
        status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'completed',
        completedAt,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        costCents: totalCostCents,
        summary,
        error: status === 'failed' ? finalOutput : null,
        lastEventAt: completedAt,
        ...retryMetadata,
        log: steps.map((s, idx) => ({
          timestamp: s.timestamp,
          level: s.phase === 'reflect' && status === 'failed' ? 'error' : 'info',
          // Short line for terminal-style scroll views
          message: `[${s.phase}] Iteration ${idx + 1}: ${s.content.slice(0, 200)}`,
          // Full structured fields for the transcript view
          phase: s.phase,
          iteration: idx + 1,
          content: s.content,
          toolCalls: s.toolCalls,
        })),
      })
      .where(eq(agentExecutions.id, execId));

    // Record cost
    if (totalCostCents > 0) {
      await this.budgetEnforcer.recordCost(agentId, totalCostCents, {
        taskId,
        provider: providerName,
        model: agent.model,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      });
    }

    // Update task status
    const taskStatus = status === 'completed' ? 'review' : status === 'failed' ? 'in_progress' : 'review';
    await this.db.drizzle
      .update(tasks)
      .set({
        status: taskStatus,
        actualTokens: totalInputTokens + totalOutputTokens,
        updatedAt: completedAt,
      })
      .where(eq(tasks.id, taskId));

    // Reset agent to idle
    await this.db.drizzle
      .update(agents)
      .set({
        status: status === 'failed' ? 'error' : 'idle',
        updatedAt: completedAt,
      })
      .where(eq(agents.id, agentId));

    // Store memory of execution
    if (status === 'completed' || status === 'max_steps_reached') {
      try {
        await this.memoryService.remember(agentId, companyId, {
          content: `Completed task "${task.title}" via agentic loop (${iterations} iterations). Result: ${summary.slice(0, 300)}`,
          memoryType: 'observation',
          importance: task.priority === 'critical' ? 9 : task.priority === 'high' ? 7 : 5,
          sourceTaskId: taskId,
          sourceExecutionId: execId,
          tags: ['execution', 'agentic-loop', 'task-completion', task.type],
        });
      } catch (err) {
        logger.warn({ err, agentId, taskId }, 'Failed to store execution memory (non-fatal)');
      }
    }

    // Emit completion event
    eventBus.emitEvent({
      type: 'execution.completed',
      companyId,
      payload: {
        executionId: execId,
        agentId,
        taskId,
        status,
        iterations,
        totalCostCents,
        totalInputTokens,
        totalOutputTokens,
        mode: 'agentic-loop',
      },
      timestamp: completedAt.toISOString(),
    });

    logger.info(
      {
        execId,
        agentId,
        taskId,
        status,
        iterations,
        totalInputTokens,
        totalOutputTokens,
        totalCostCents,
      },
      'Agentic loop completed',
    );

    return {
      executionId: execId,
      agentId,
      taskId,
      status,
      steps,
      finalOutput,
      totalInputTokens,
      totalOutputTokens,
      totalCostCents,
      iterations,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve which MCP server owns a tool by name.
   */
  private resolveServerId(
    tools: Array<{ name: string; serverId: string }>,
    toolName: string,
  ): string {
    const match = tools.find((t) => t.name === toolName);
    return match?.serverId ?? '';
  }

  /**
   * Build the comprehensive system prompt for the agentic loop.
   */
  private buildSystemPrompt(
    agent: Record<string, any>,
    company: Record<string, any>,
    knowledgeContext: string,
    memoryContext: string,
    mcpTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; serverId: string; serverName: string }>,
  ): string {
    const sections: string[] = [];

    // Agent identity
    sections.push(`# Agent Identity
You are ${agent.name}, ${agent.title || agent.role} at ${company.name}.
${agent.instructions || agent.systemPrompt || ''}`);

    // Company context
    sections.push(`# Company Context
Company: ${company.name}
${company.mission ? `Mission: ${company.mission}` : ''}
${company.description ? `Description: ${company.description}` : ''}`);

    // Operating protocol
    sections.push(`# Operating Protocol
You work in an autonomous loop. For each task:
1. OBSERVE: Review the task requirements and all available context carefully.
2. THINK: Plan your approach step by step before acting.
3. ACT: Execute your plan. If you need to use a tool, format it as:
   <tool_call>{"name": "tool_name", "serverId": "server_id", "args": {...}}</tool_call>
4. REFLECT: Evaluate if the task is complete and the output quality is sufficient.

When you have fully completed the task, include <task_complete> at the end of your final response.
Do NOT include <task_complete> until you are confident the task is done.`);

    // Knowledge context
    if (knowledgeContext && knowledgeContext.trim().length > 0) {
      sections.push(`# Company Knowledge\n${knowledgeContext}`);
    }

    // Memory context
    if (memoryContext && memoryContext.trim().length > 0) {
      sections.push(`# Your Memory\n${memoryContext}`);
    }

    // MCP tools
    if (mcpTools.length > 0) {
      const toolDescriptions = mcpTools
        .map((t) => {
          const schema = JSON.stringify(t.inputSchema, null, 2);
          return `## ${t.name} (server: ${t.serverName}, id: ${t.serverId})\n${t.description}\nInput schema:\n\`\`\`json\n${schema}\n\`\`\``;
        })
        .join('\n\n');
      sections.push(`# Available Tools\n${toolDescriptions}`);
    }

    // Capabilities
    if (agent.capabilities && agent.capabilities.length > 0) {
      sections.push(`# Your Capabilities\n${(agent.capabilities as string[]).join(', ')}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Build the user prompt for the task.
   */
  private buildTaskPrompt(task: Record<string, any>): string {
    const parts: string[] = [
      `# Task: ${task.title}`,
      task.description || 'No additional description provided.',
      '',
      `Priority: ${task.priority}`,
      `Type: ${task.type}`,
    ];

    if (task.tags && task.tags.length > 0) {
      parts.push(`Tags: ${task.tags.join(', ')}`);
    }

    parts.push('', 'Please complete this task. Work through it step by step.');

    return parts.join('\n');
  }
}
