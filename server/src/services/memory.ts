// ---------------------------------------------------------------------------
// Agent Memory Service -- Persistent memory across agent executions
// ---------------------------------------------------------------------------

import { eq, and, desc, gte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType = 'observation' | 'decision' | 'preference' | 'fact' | 'lesson';

export interface Memory {
  id: string;
  companyId: string;
  agentId: string;
  memoryType: MemoryType;
  content: string;
  importance: number;
  sourceTaskId: string | null;
  sourceExecutionId: string | null;
  tags: string[];
  expiresAt: Date | null;
  createdAt: Date;
}

export interface RememberInput {
  content: string;
  memoryType: MemoryType;
  importance?: number;
  sourceTaskId?: string;
  sourceExecutionId?: string;
  tags?: string[];
  expiresAt?: Date;
}

// ---------------------------------------------------------------------------
// MemoryService
// ---------------------------------------------------------------------------

export class MemoryService {
  constructor(private db: DbInstance) {}

  /**
   * Store a memory from an agent's execution.
   */
  async remember(
    agentId: string,
    companyId: string,
    data: RememberInput,
  ): Promise<Memory> {
    const { agentMemories } = this.db.schema;
    const now = new Date();

    const [row] = await this.db.drizzle
      .insert(agentMemories)
      .values({
        id: randomUUID(),
        companyId,
        agentId,
        memoryType: data.memoryType,
        content: data.content,
        importance: Math.min(10, Math.max(1, data.importance ?? 5)),
        sourceTaskId: data.sourceTaskId ?? null,
        sourceExecutionId: data.sourceExecutionId ?? null,
        tags: data.tags ?? [],
        expiresAt: data.expiresAt ?? null,
        createdAt: now,
      })
      .returning();

    return row as unknown as Memory;
  }

  /**
   * Retrieve relevant memories for a context string.
   * Scores by keyword relevance + importance + recency.
   */
  async recall(
    agentId: string,
    context: string,
    limit: number = 10,
  ): Promise<Memory[]> {
    const { agentMemories } = this.db.schema;
    const now = Date.now();

    // Get all non-expired memories for this agent
    const allMemories = await this.db.drizzle
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.agentId, agentId))
      .orderBy(desc(agentMemories.createdAt));

    // Filter expired
    const active = allMemories.filter((m) => {
      if (!m.expiresAt) return true;
      return new Date(m.expiresAt).getTime() > now;
    });

    // Score each memory
    const contextWords = context
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const scored = active.map((m) => {
      const contentLower = m.content.toLowerCase();
      const tagsStr = (m.tags as string[]).join(' ').toLowerCase();

      // Keyword match score (0-1)
      let matchCount = 0;
      for (const word of contextWords) {
        if (contentLower.includes(word) || tagsStr.includes(word)) {
          matchCount++;
        }
      }
      const keywordScore = contextWords.length > 0
        ? matchCount / contextWords.length
        : 0;

      // Importance score (0-1)
      const importanceScore = (m.importance ?? 5) / 10;

      // Recency score (0-1) -- memories from last 24h score 1.0, decay over 30 days
      const ageMs = now - new Date(m.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyScore = Math.max(0, 1 - ageDays / 30);

      // Weighted composite
      const totalScore =
        keywordScore * 0.5 +
        importanceScore * 0.3 +
        recencyScore * 0.2;

      return { memory: m, score: totalScore };
    });

    // Sort by score descending and return top N
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => s.memory as unknown as Memory);
  }

  /**
   * Get recent memories for an agent.
   */
  async getRecentMemories(
    agentId: string,
    limit: number = 20,
  ): Promise<Memory[]> {
    const { agentMemories } = this.db.schema;

    const rows = await this.db.drizzle
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.agentId, agentId))
      .orderBy(desc(agentMemories.createdAt))
      .limit(limit);

    return rows as unknown as Memory[];
  }

  /**
   * Get all memories for an agent in a company.
   */
  async getMemories(
    agentId: string,
    companyId: string,
    limit: number = 100,
  ): Promise<Memory[]> {
    const { agentMemories } = this.db.schema;

    const rows = await this.db.drizzle
      .select()
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.agentId, agentId),
          eq(agentMemories.companyId, companyId),
        ),
      )
      .orderBy(desc(agentMemories.createdAt))
      .limit(limit);

    return rows as unknown as Memory[];
  }

  /**
   * Delete a specific memory.
   */
  async forget(memoryId: string): Promise<void> {
    const { agentMemories } = this.db.schema;

    await this.db.drizzle
      .delete(agentMemories)
      .where(eq(agentMemories.id, memoryId));
  }

  /**
   * Clear all memories for an agent.
   */
  async clearMemories(agentId: string): Promise<void> {
    const { agentMemories } = this.db.schema;

    await this.db.drizzle
      .delete(agentMemories)
      .where(eq(agentMemories.agentId, agentId));
  }

  /**
   * Build a formatted memory context string for inclusion in agent prompts.
   */
  async buildMemoryContext(
    agentId: string,
    taskDescription: string,
  ): Promise<string> {
    const relevant = await this.recall(agentId, taskDescription, 15);

    if (relevant.length === 0) {
      return '';
    }

    const grouped: Record<string, Memory[]> = {};
    for (const mem of relevant) {
      const type = mem.memoryType || 'observation';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push(mem);
    }

    const sections: string[] = ['## Agent Memory\n'];

    const typeLabels: Record<string, string> = {
      decision: 'Past Decisions',
      observation: 'Observations',
      preference: 'Preferences',
      fact: 'Known Facts',
      lesson: 'Lessons Learned',
    };

    for (const [type, memories] of Object.entries(grouped)) {
      const label = typeLabels[type] || type;
      sections.push(`### ${label}`);
      for (const mem of memories) {
        const importance = mem.importance >= 8 ? ' [HIGH]' : '';
        sections.push(`- ${mem.content}${importance}`);
      }
      sections.push('');
    }

    return sections.join('\n');
  }
}
