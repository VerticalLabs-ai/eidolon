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

type TemplateCategory =
  | "general"
  | "software"
  | "marketing"
  | "ecommerce"
  | "consulting"
  | "content";

interface CompanyTemplateRecord {
  id: string;
  name: string;
  description: string | null;
  category: TemplateCategory;
  author: string | null;
  version: string;
  config: CompanyTemplateConfig;
  agentCount: number;
  isPublic: number;
  downloadCount: number;
  tags: string[];
  previewImage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const BUILT_IN_TEMPLATE_DATE = new Date("2026-04-29T00:00:00.000Z");
const BUILT_IN_TEMPLATE_VERSION = "1.0.0";

function builtInTemplate(
  template: Omit<
    CompanyTemplateRecord,
    | "author"
    | "version"
    | "agentCount"
    | "isPublic"
    | "downloadCount"
    | "previewImage"
    | "createdAt"
    | "updatedAt"
  >,
): CompanyTemplateRecord {
  return {
    ...template,
    author: "Eidolon",
    version: BUILT_IN_TEMPLATE_VERSION,
    agentCount: template.config.agents.length,
    isPublic: 1,
    downloadCount: 0,
    previewImage: null,
    createdAt: BUILT_IN_TEMPLATE_DATE,
    updatedAt: BUILT_IN_TEMPLATE_DATE,
  };
}

function nextPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return "1.0.1";
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

const BUILT_IN_TEMPLATES = [
  builtInTemplate({
    id: "builtin-demo-saas-operator",
    name: "SaaS Operator Demo",
    description:
      "A guided demo company with executive, product, engineering, marketing, and support agents so new users can inspect Eidolon workflows immediately.",
    category: "software",
    tags: ["demo", "onboarding", "saas", "agents"],
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
    },
  }),
  builtInTemplate({
    id: "builtin-growth-marketing-studio",
    name: "Growth Marketing Studio",
    description:
      "A launch-ready marketing team for positioning, campaigns, lifecycle experiments, and creative review.",
    category: "marketing",
    tags: ["growth", "campaigns", "lifecycle", "creative"],
    config: {
      name: "Growth Marketing Studio",
      description: "A marketing operator company for shipping campaigns and learning from the funnel.",
      mission:
        "Coordinate positioning, channel experiments, content production, and performance review around a focused growth motion.",
      budgetMonthlyCents: 180000,
      agents: [
        {
          name: "Noa",
          role: "cmo",
          title: "AI CMO",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Set marketing strategy, pick the campaign thesis, and keep every channel tied to measurable pipeline.",
          capabilities: ["positioning", "campaign-strategy", "funnel-review"],
          budgetMonthlyCents: 55000,
          reportsTo: null,
        },
        {
          name: "Vale",
          role: "growth",
          title: "Growth Experiment Lead",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Design channel tests, define success metrics, and turn results into the next experiment queue.",
          capabilities: ["experimentation", "analytics", "channel-testing"],
          budgetMonthlyCents: 45000,
          reportsTo: "role:cmo",
        },
        {
          name: "Lena",
          role: "content",
          title: "Content Strategist",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Create content briefs, nurture assets, and campaign copy that are specific to the audience and offer.",
          capabilities: ["content-strategy", "copywriting", "editorial-planning"],
          budgetMonthlyCents: 40000,
          reportsTo: "role:cmo",
        },
        {
          name: "Quinn",
          role: "creative",
          title: "Creative Reviewer",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Review creative assets for clarity, brand consistency, offer strength, and conversion risks.",
          capabilities: ["creative-review", "brand-consistency", "ad-critique"],
          budgetMonthlyCents: 40000,
          reportsTo: "role:cmo",
        },
      ],
      goals: [
        {
          title: "Launch the first campaign sprint",
          description:
            "Ship a campaign with a clear audience, offer, channel plan, and review cadence.",
          level: "company",
        },
        {
          title: "Build a reusable experiment backlog",
          description:
            "Convert funnel observations into prioritized growth tests with owner and metric definitions.",
          level: "team",
        },
      ],
      prompts: [
        {
          name: "Campaign Brief",
          category: "marketing",
          content:
            "Create a campaign brief for {{offer}} targeting {{audience}}. Include positioning, channels, assets, risks, and measurement.",
          variables: ["offer", "audience"],
        },
        {
          name: "Funnel Retrospective",
          category: "analytics",
          content:
            "Review this funnel data and propose the next three experiments with reasoning: {{funnel_data}}",
          variables: ["funnel_data"],
        },
      ],
    },
  }),
  builtInTemplate({
    id: "builtin-ecommerce-ops-hub",
    name: "E-commerce Ops Hub",
    description:
      "A commerce team for merchandising, lifecycle retention, customer operations, and storefront optimization.",
    category: "ecommerce",
    tags: ["commerce", "merchandising", "retention", "support"],
    config: {
      name: "E-commerce Ops Hub",
      description: "An AI commerce company configured around catalog, conversion, and retention workflows.",
      mission:
        "Improve store performance by coordinating product merchandising, promotion planning, customer insights, and support loops.",
      budgetMonthlyCents: 220000,
      agents: [
        {
          name: "Mara",
          role: "gm",
          title: "AI Commerce GM",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Own commercial priorities, trading cadence, and cross-functional decisions for the store.",
          capabilities: ["commerce-strategy", "trading-review", "prioritization"],
          budgetMonthlyCents: 60000,
          reportsTo: null,
        },
        {
          name: "Pax",
          role: "merchandiser",
          title: "Merchandising Lead",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Plan category focus, product storytelling, bundle ideas, and landing page improvements.",
          capabilities: ["merchandising", "catalog-analysis", "offer-planning"],
          budgetMonthlyCents: 50000,
          reportsTo: "role:gm",
        },
        {
          name: "Rin",
          role: "retention",
          title: "Lifecycle Marketer",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Build email, SMS, and loyalty workflows that lift repeat purchase and customer lifetime value.",
          capabilities: ["email", "sms", "retention-analysis"],
          budgetMonthlyCents: 45000,
          reportsTo: "role:gm",
        },
        {
          name: "Tess",
          role: "support",
          title: "Customer Insights Lead",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Turn customer questions, returns, and reviews into product, content, and operations improvements.",
          capabilities: ["support-triage", "review-analysis", "customer-insights"],
          budgetMonthlyCents: 35000,
          reportsTo: "role:gm",
        },
        {
          name: "Oren",
          role: "analyst",
          title: "Store Performance Analyst",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Analyze conversion, AOV, repeat purchase, and inventory signals to recommend weekly actions.",
          capabilities: ["analytics", "conversion-review", "forecasting"],
          budgetMonthlyCents: 30000,
          reportsTo: "role:gm",
        },
      ],
      goals: [
        {
          title: "Improve storefront conversion",
          description:
            "Identify and ship the highest-impact merchandising and offer improvements for the store.",
          level: "company",
        },
        {
          title: "Close the customer feedback loop",
          description:
            "Turn support and review themes into specific improvements across products, pages, and lifecycle messages.",
          level: "team",
        },
      ],
      prompts: [
        {
          name: "Weekly Trading Review",
          category: "analytics",
          content:
            "Review this commerce performance snapshot and recommend priority actions for merchandising, retention, and support: {{store_metrics}}",
          variables: ["store_metrics"],
        },
        {
          name: "Product Page Improvement",
          category: "conversion",
          content:
            "Improve this product page for {{product_name}} using the following customer objections and reviews: {{customer_signals}}",
          variables: ["product_name", "customer_signals"],
        },
      ],
    },
  }),
  builtInTemplate({
    id: "builtin-consulting-delivery-office",
    name: "Consulting Delivery Office",
    description:
      "A client-services operating model for discovery, delivery planning, research, and stakeholder reporting.",
    category: "consulting",
    tags: ["client-services", "delivery", "research", "reporting"],
    config: {
      name: "Consulting Delivery Office",
      description: "A consulting team designed to run client discovery through delivery review.",
      mission:
        "Keep client engagements crisp by connecting discovery, research, work planning, and executive communication.",
      budgetMonthlyCents: 200000,
      agents: [
        {
          name: "Cass",
          role: "partner",
          title: "Engagement Partner",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Own client outcomes, engagement scope, executive communication, and decision quality.",
          capabilities: ["client-strategy", "scope-management", "executive-review"],
          budgetMonthlyCents: 65000,
          reportsTo: null,
        },
        {
          name: "Eli",
          role: "pm",
          title: "Delivery Manager",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Break engagement goals into plans, milestones, risks, and clear owner assignments.",
          capabilities: ["project-planning", "risk-management", "status-reporting"],
          budgetMonthlyCents: 50000,
          reportsTo: "role:partner",
        },
        {
          name: "Sage",
          role: "researcher",
          title: "Research Lead",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Run structured research, synthesize evidence, and separate findings from assumptions.",
          capabilities: ["research", "synthesis", "market-analysis"],
          budgetMonthlyCents: 45000,
          reportsTo: "role:partner",
        },
        {
          name: "Niko",
          role: "analyst",
          title: "Business Analyst",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Translate client data, interviews, and operating context into decisions, options, and tradeoffs.",
          capabilities: ["analysis", "modeling", "recommendations"],
          budgetMonthlyCents: 40000,
          reportsTo: "role:pm",
        },
      ],
      goals: [
        {
          title: "Create the engagement operating plan",
          description:
            "Define scope, milestones, research questions, stakeholder cadence, and delivery risks.",
          level: "company",
        },
        {
          title: "Produce the first client-ready recommendation",
          description:
            "Synthesize evidence into a practical recommendation with tradeoffs and next actions.",
          level: "team",
        },
      ],
      prompts: [
        {
          name: "Client Discovery Synthesis",
          category: "research",
          content:
            "Synthesize these client discovery notes into goals, constraints, unknowns, risks, and next questions: {{discovery_notes}}",
          variables: ["discovery_notes"],
        },
        {
          name: "Executive Status Update",
          category: "reporting",
          content:
            "Write an executive status update for {{client_name}} covering progress, blockers, decisions needed, and next milestones.",
          variables: ["client_name"],
        },
      ],
    },
  }),
  builtInTemplate({
    id: "builtin-content-production-desk",
    name: "Content Production Desk",
    description:
      "A publishing team for editorial planning, research, writing, editing, distribution, and performance review.",
    category: "content",
    tags: ["editorial", "publishing", "research", "distribution"],
    config: {
      name: "Content Production Desk",
      description: "An editorial operating company for running a consistent content machine.",
      mission:
        "Plan, produce, edit, distribute, and learn from content with a clear editorial standard and cadence.",
      budgetMonthlyCents: 160000,
      agents: [
        {
          name: "June",
          role: "editor",
          title: "Managing Editor",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Own editorial strategy, calendar quality, review standards, and publication readiness.",
          capabilities: ["editorial-strategy", "editing", "calendar-planning"],
          budgetMonthlyCents: 50000,
          reportsTo: null,
        },
        {
          name: "Arlo",
          role: "researcher",
          title: "Research Producer",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Gather credible source material, identify angles, and prepare research packets for writers.",
          capabilities: ["research", "source-review", "angle-development"],
          budgetMonthlyCents: 35000,
          reportsTo: "role:editor",
        },
        {
          name: "Bea",
          role: "writer",
          title: "Lead Writer",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Draft clear, specific, audience-aware content from approved briefs and research packets.",
          capabilities: ["writing", "storytelling", "drafting"],
          budgetMonthlyCents: 40000,
          reportsTo: "role:editor",
        },
        {
          name: "Kai",
          role: "distribution",
          title: "Distribution Lead",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt:
            "Turn published content into channel-specific distribution, repurposing, and performance learnings.",
          capabilities: ["distribution", "repurposing", "performance-review"],
          budgetMonthlyCents: 35000,
          reportsTo: "role:editor",
        },
      ],
      goals: [
        {
          title: "Ship the first editorial cycle",
          description:
            "Move topics from brief through research, draft, edit, publish, and distribution.",
          level: "company",
        },
        {
          title: "Build the reusable content standards",
          description:
            "Define quality bars, review steps, and performance signals for future publishing cycles.",
          level: "team",
        },
      ],
      prompts: [
        {
          name: "Editorial Brief",
          category: "content",
          content:
            "Create an editorial brief for {{topic}} aimed at {{audience}}. Include angle, thesis, outline, sources needed, and distribution notes.",
          variables: ["topic", "audience"],
        },
        {
          name: "Content Repurposing Plan",
          category: "distribution",
          content:
            "Repurpose this published piece into channel-specific assets for newsletter, social, and sales enablement: {{content_url_or_text}}",
          variables: ["content_url_or_text"],
        },
      ],
    },
  }),
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
   * Update an existing user-created template and bump its version by default.
   */
  async updateTemplate(
    templateId: string,
    data: Partial<{
      name: string;
      description: string | null;
      category: TemplateCategory;
      author: string | null;
      version: string;
      config: CompanyTemplateConfig;
      tags: string[];
      isPublic: boolean;
    }>,
  ) {
    if (BUILT_IN_TEMPLATES.some((template) => template.id === templateId)) {
      throw new Error("Cannot update built-in templates");
    }

    const { companyTemplates } = this.db.schema;
    const [current] = await this.db.drizzle
      .select()
      .from(companyTemplates)
      .where(eq(companyTemplates.id, templateId))
      .limit(1);

    if (!current) return null;

    const [template] = await this.db.drizzle
      .update(companyTemplates)
      .set({
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined
          ? { description: data.description }
          : {}),
        ...(data.category !== undefined
          ? { category: data.category as any }
          : {}),
        ...(data.author !== undefined ? { author: data.author } : {}),
        version: data.version ?? nextPatchVersion(current.version),
        ...(data.config !== undefined
          ? {
              config: data.config as any,
              agentCount: data.config.agents.length,
            }
          : {}),
        ...(data.tags !== undefined ? { tags: data.tags } : {}),
        ...(data.isPublic !== undefined
          ? { isPublic: data.isPublic ? 1 : 0 }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(companyTemplates.id, templateId))
      .returning();

    return template;
  }

  /**
   * Delete a user-created template.
   */
  async deleteTemplate(templateId: string) {
    if (BUILT_IN_TEMPLATES.some((template) => template.id === templateId)) {
      throw new Error("Cannot delete built-in templates");
    }

    const { companyTemplates } = this.db.schema;
    const [template] = await this.db.drizzle
      .delete(companyTemplates)
      .where(eq(companyTemplates.id, templateId))
      .returning({ id: companyTemplates.id });

    return template ?? null;
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
