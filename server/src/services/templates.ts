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

const BUILT_IN_TEMPLATE_DATE = new Date('2026-04-29T00:00:00.000Z');

const BUILT_IN_TEMPLATES = [
  {
    id: 'builtin-demo-saas-operator',
    name: 'SaaS Operator Demo',
    description:
      'A guided demo company with executive, product, engineering, marketing, and support agents so new users can inspect Eidolon workflows immediately.',
    category: 'software' as const,
    author: 'Eidolon',
    version: '1.0.0',
    config: {
      name: 'Demo SaaS Operator',
      description: 'A sample AI company configured to run a focused SaaS operating cadence.',
      mission:
        'Show how Eidolon coordinates specialized AI agents across planning, delivery, growth, and customer feedback loops.',
      budgetMonthlyCents: 250000,
      agents: [
        {
          name: 'Avery',
          role: 'ceo',
          title: 'AI CEO',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          systemPrompt:
            'Coordinate the demo company. Keep strategy, priorities, and operating cadence aligned across every agent.',
          capabilities: ['strategy', 'planning', 'executive-review'],
          budgetMonthlyCents: 60000,
          reportsTo: null,
        },
        {
          name: 'Mira',
          role: 'cto',
          title: 'AI CTO',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          systemPrompt:
            'Own technical architecture, delivery risk, and engineering execution for the demo product.',
          capabilities: ['architecture', 'code-review', 'delivery-planning'],
          budgetMonthlyCents: 55000,
          reportsTo: 'role:ceo',
        },
        {
          name: 'Rowan',
          role: 'engineer',
          title: 'Product Engineer',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          systemPrompt:
            'Break product opportunities into implementation tasks, surface blockers, and keep delivery work testable.',
          capabilities: ['implementation', 'testing', 'issue-triage'],
          budgetMonthlyCents: 50000,
          reportsTo: 'role:cto',
        },
        {
          name: 'Sol',
          role: 'marketer',
          title: 'Growth Lead',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          systemPrompt:
            'Turn product progress into positioning, launch plans, and customer-facing narratives.',
          capabilities: ['positioning', 'launch-planning', 'customer-research'],
          budgetMonthlyCents: 40000,
          reportsTo: 'role:ceo',
        },
        {
          name: 'Iris',
          role: 'support',
          title: 'Customer Operations',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          systemPrompt:
            'Convert customer questions and issues into actionable feedback for product and growth.',
          capabilities: ['support-triage', 'feedback-analysis', 'knowledge-base'],
          budgetMonthlyCents: 45000,
          reportsTo: 'role:ceo',
        },
      ],
      goals: [
        {
          title: 'Ship a credible onboarding demo',
          description:
            'Give new users a preconfigured company they can inspect to understand agents, goals, tasks, prompts, and operating rhythm.',
          level: 'company',
        },
        {
          title: 'Prepare first customer-ready workflow',
          description:
            'Define a narrow workflow that demonstrates cross-agent collaboration from intake through execution review.',
          level: 'team',
        },
      ],
      prompts: [
        {
          name: 'Weekly Operator Review',
          category: 'planning',
          content:
            'Summarize company progress for {{company_name}}. Include wins, risks, next decisions, and which agent owns each follow-up.',
          variables: ['company_name'],
        },
        {
          name: 'Customer Feedback Triage',
          category: 'support',
          content:
            'Turn the following customer feedback into product themes, severity, affected workflow, and recommended next action: {{feedback}}',
          variables: ['feedback'],
        },
      ],
    } satisfies CompanyTemplateConfig,
    agentCount: 5,
    isPublic: 1,
    downloadCount: 0,
    tags: ['demo', 'onboarding', 'saas', 'agents'],
    previewImage: null,
    createdAt: BUILT_IN_TEMPLATE_DATE,
    updatedAt: BUILT_IN_TEMPLATE_DATE,
  },
];

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
      .where(eq(agents.companyId, companyId));

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
      .where(eq(goals.companyId, companyId));

    const templateGoals: TemplateGoalConfig[] = goalRows.map((g) => ({
      title: g.title,
      description: g.description,
      level: g.level,
    }));

    // 4. Load prompt templates
    const promptRows = await this.db.drizzle
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.companyId, companyId));

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
    const includeBuiltIns = !category || category === "all";
    const builtIns = includeBuiltIns
      ? BUILT_IN_TEMPLATES
      : BUILT_IN_TEMPLATES.filter((template) => template.category === category);

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
        .then((templates) => [...builtIns, ...templates]);
    }

    return this.db.drizzle
      .select()
      .from(companyTemplates)
      .then((templates) => [...builtIns, ...templates]);
  }

  /**
   * Get a single template by ID.
   */
  async getTemplate(id: string) {
    const builtIn = BUILT_IN_TEMPLATES.find((template) => template.id === id);
    if (builtIn) return builtIn;

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
