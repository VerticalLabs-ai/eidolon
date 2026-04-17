import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DbInstance } from "../types.js";

interface TemplateAgentConfig {
  name: string;
  role: string;
  title: string;
  provider: string;
  model: string;
  systemPrompt: string | null;
  capabilities: string[];
  budgetMonthlyCents: number;
  reportsTo: string | null; // "role:<role>" reference for portability
}

interface TemplateGoalConfig {
  title: string;
  description: string | null;
  level: string;
}

interface TemplatePromptConfig {
  name: string;
  category: string;
  content: string;
  variables: string[];
}

export interface CompanyTemplateConfig {
  name: string;
  description: string | null;
  mission: string | null;
  budgetMonthlyCents: number;
  agents: TemplateAgentConfig[];
  goals: TemplateGoalConfig[];
  prompts: TemplatePromptConfig[];
}

export class TemplateService {
  constructor(private db: DbInstance) {}

  /**
   * Export a company as a reusable template.
   * Strips IDs, API keys, and sensitive data for portability.
   */
  async exportCompany(companyId: string): Promise<CompanyTemplateConfig> {
    const { companies, agents, goals, promptTemplates } = this.db.schema;

    // 1. Load company
    const [company] = await this.db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!company) throw new Error(`Company ${companyId} not found`);

    // 2. Load all agents
    const agentRows = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .all();

    // Build agent ID -> role map for resolving reportsTo
    const idToRole = new Map<string, string>();
    for (const a of agentRows) {
      idToRole.set(a.id, a.role);
    }

    const templateAgents: TemplateAgentConfig[] = agentRows.map((a) => ({
      name: a.name,
      role: a.role,
      title: a.title ?? a.role,
      provider: a.provider,
      model: a.model,
      systemPrompt: a.systemPrompt,
      capabilities: a.capabilities as string[],
      budgetMonthlyCents: a.budgetMonthlyCents,
      reportsTo: a.reportsTo
        ? `role:${idToRole.get(a.reportsTo) ?? "ceo"}`
        : null,
    }));

    // 3. Load goals
    const goalRows = await this.db.drizzle
      .select()
      .from(goals)
      .where(eq(goals.companyId, companyId))
      .all();

    const templateGoals: TemplateGoalConfig[] = goalRows.map((g) => ({
      title: g.title,
      description: g.description,
      level: g.level,
    }));

    // 4. Load prompt templates
    const promptRows = await this.db.drizzle
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.companyId, companyId))
      .all();

    const templatePrompts: TemplatePromptConfig[] = promptRows.map((p) => ({
      name: p.name,
      category: p.category,
      content: p.content,
      variables: p.variables as string[],
    }));

    return {
      name: company.name,
      description: company.description,
      mission: company.mission,
      budgetMonthlyCents: company.budgetMonthlyCents,
      agents: templateAgents,
      goals: templateGoals,
      prompts: templatePrompts,
    };
  }

  /**
   * Import a template to create a new company with all agents, goals, and prompts.
   */
  async importTemplate(
    templateConfig: CompanyTemplateConfig,
    overrides?: { companyName?: string; budgetMultiplier?: number },
  ) {
    const { companies, agents, goals, promptTemplates } = this.db.schema;
    const now = new Date();
    const multiplier = overrides?.budgetMultiplier ?? 1;

    // 1. Create the company
    const companyId = randomUUID();
    await this.db.drizzle.insert(companies).values({
      id: companyId,
      name: overrides?.companyName ?? templateConfig.name,
      description: templateConfig.description,
      mission: templateConfig.mission,
      status: "active",
      budgetMonthlyCents: Math.round(
        templateConfig.budgetMonthlyCents * multiplier,
      ),
      spentMonthlyCents: 0,
      settings: {},
      createdAt: now,
      updatedAt: now,
    });

    // 2. Create agents in two passes: first without reportsTo, then resolve references
    const roleToId = new Map<string, string>();
    const agentInserts: Array<{
      id: string;
      role: string;
      reportsToRef: string | null;
    }> = [];

    for (const agentConfig of templateConfig.agents) {
      const agentId = randomUUID();
      roleToId.set(agentConfig.role, agentId);
      agentInserts.push({
        id: agentId,
        role: agentConfig.role,
        reportsToRef: agentConfig.reportsTo,
      });

      await this.db.drizzle.insert(agents).values({
        id: agentId,
        companyId,
        name: agentConfig.name,
        role: agentConfig.role as any,
        title: agentConfig.title,
        provider: agentConfig.provider as any,
        model: agentConfig.model,
        status: "idle",
        capabilities: agentConfig.capabilities,
        systemPrompt: agentConfig.systemPrompt,
        budgetMonthlyCents: Math.round(
          agentConfig.budgetMonthlyCents * multiplier,
        ),
        spentMonthlyCents: 0,
        config: {},
        metadata: {},
        permissions: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    // Resolve reportsTo references (e.g., "role:ceo" -> actual ID)
    for (const insert of agentInserts) {
      if (insert.reportsToRef) {
        const refRole = insert.reportsToRef.replace("role:", "");
        const managerId = roleToId.get(refRole);
        if (managerId) {
          await this.db.drizzle
            .update(agents)
            .set({ reportsTo: managerId })
            .where(eq(agents.id, insert.id));
        }
      }
    }

    // 3. Create goals
    for (const goalConfig of templateConfig.goals) {
      await this.db.drizzle.insert(goals).values({
        companyId,
        title: goalConfig.title,
        description: goalConfig.description,
        level: goalConfig.level as
          | "company"
          | "department"
          | "team"
          | "individual",
        status: "draft",
        progress: 0,
        metrics: {},
        createdAt: now,
        updatedAt: now,
      });
    }

    // 4. Create prompt templates
    for (const promptConfig of templateConfig.prompts) {
      await this.db.drizzle.insert(promptTemplates).values({
        id: randomUUID(),
        companyId,
        name: promptConfig.name,
        category: promptConfig.category as any,
        content: promptConfig.content,
        variables: promptConfig.variables,
        version: 1,
        isGlobal: 0,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    void templateConfig; // template imported; audit logging is handled by the event bus
    return { companyId };
  }

  /**
   * List available templates (public + built-in).
   */
  async listTemplates(category?: string) {
    const { companyTemplates } = this.db.schema;

    if (category && category !== "all") {
      const cat = category as
        | "general"
        | "software"
        | "marketing"
        | "ecommerce"
        | "consulting"
        | "content";
      return this.db.drizzle
        .select()
        .from(companyTemplates)
        .where(eq(companyTemplates.category, cat))
        .all();
    }

    return this.db.drizzle.select().from(companyTemplates).all();
  }

  /**
   * Get a single template by ID.
   */
  async getTemplate(id: string) {
    const { companyTemplates } = this.db.schema;

    const [template] = await this.db.drizzle
      .select()
      .from(companyTemplates)
      .where(eq(companyTemplates.id, id))
      .limit(1);

    return template ?? null;
  }

  /**
   * Save a new template (from export or manual creation).
   */
  async saveTemplate(data: {
    name: string;
    description?: string;
    category?: string;
    author?: string;
    version?: string;
    config: CompanyTemplateConfig;
    tags?: string[];
    isPublic?: boolean;
  }) {
    const { companyTemplates } = this.db.schema;
    const id = randomUUID();
    const now = new Date();

    const [template] = await this.db.drizzle
      .insert(companyTemplates)
      .values({
        id,
        name: data.name,
        description: data.description ?? null,
        category: (data.category as any) ?? "general",
        author: data.author ?? null,
        version: data.version ?? "1.0.0",
        config: data.config as any,
        agentCount: data.config.agents.length,
        isPublic: data.isPublic ? 1 : 0,
        downloadCount: 0,
        tags: data.tags ?? [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return template;
  }

  /**
   * Increment download count when a template is imported.
   */
  async incrementDownloadCount(templateId: string) {
    const { companyTemplates } = this.db.schema;

    await this.db.drizzle
      .update(companyTemplates)
      .set({
        downloadCount: sql`${companyTemplates.downloadCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(companyTemplates.id, templateId));
  }

}
