import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DbInstance } from "../types.js";
import logger from "../utils/logger.js";

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

    logger.info(
      {
        companyId,
        templateName: templateConfig.name,
        agents: templateConfig.agents.length,
      },
      "Template imported",
    );
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

  /**
   * Seed built-in templates if they don't exist yet.
   */
  async seedBuiltInTemplates() {
    const existing = await this.listTemplates();
    if (existing.length > 0) {
      logger.info("Templates already seeded, skipping");
      return;
    }

    const templates: Array<{
      name: string;
      description: string;
      category: string;
      tags: string[];
      config: CompanyTemplateConfig;
    }> = [
      {
        name: "Software Startup",
        description:
          "A lean software startup with a CEO, CTO, two engineers, a designer, and marketing lead. Perfect for building and launching SaaS products.",
        category: "software",
        tags: ["startup", "saas", "engineering", "agile"],
        config: {
          name: "My Software Startup",
          description: "An AI-powered software startup",
          mission:
            "Build innovative software products that solve real problems",
          budgetMonthlyCents: 50000,
          agents: [
            {
              name: "Atlas",
              role: "ceo",
              title: "Chief Executive Officer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the CEO of a software startup. Focus on strategy, product vision, and team coordination. Make decisions that balance growth with sustainability. Delegate technical decisions to the CTO and ensure alignment across all departments.",
              capabilities: [
                "strategy",
                "leadership",
                "decision_making",
                "planning",
              ],
              budgetMonthlyCents: 10000,
              reportsTo: null,
            },
            {
              name: "Nova",
              role: "cto",
              title: "Chief Technology Officer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the CTO. Own the technical architecture, code quality standards, and engineering culture. Review PRs, make technology choices, and mentor engineers. Translate business requirements into technical specifications.",
              capabilities: [
                "architecture",
                "code_review",
                "technical_planning",
                "mentoring",
              ],
              budgetMonthlyCents: 10000,
              reportsTo: "role:ceo",
            },
            {
              name: "Forge",
              role: "engineer",
              title: "Senior Software Engineer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are a senior software engineer. Write clean, tested, production-ready code. Focus on backend systems, APIs, and infrastructure. Follow best practices for security, performance, and maintainability.",
              capabilities: [
                "coding",
                "backend",
                "api_design",
                "testing",
                "devops",
              ],
              budgetMonthlyCents: 8000,
              reportsTo: "role:cto",
            },
            {
              name: "Pixel",
              role: "engineer",
              title: "Frontend Engineer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are a frontend engineer specializing in React and modern UI. Build responsive, accessible, and performant user interfaces. Collaborate closely with the designer to implement pixel-perfect designs.",
              capabilities: [
                "coding",
                "frontend",
                "react",
                "css",
                "accessibility",
              ],
              budgetMonthlyCents: 8000,
              reportsTo: "role:cto",
            },
            {
              name: "Prism",
              role: "designer",
              title: "Product Designer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the product designer. Create intuitive, beautiful user experiences. Conduct user research, create wireframes and prototypes, and establish the design system. Ensure accessibility and consistency across the product.",
              capabilities: [
                "ui_design",
                "ux_research",
                "prototyping",
                "design_systems",
              ],
              budgetMonthlyCents: 6000,
              reportsTo: "role:ceo",
            },
            {
              name: "Echo",
              role: "marketer",
              title: "Head of Marketing",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the head of marketing. Drive user acquisition, brand awareness, and growth. Create content strategies, manage campaigns, and analyze marketing metrics. Work closely with the CEO on positioning and messaging.",
              capabilities: [
                "content_creation",
                "seo",
                "analytics",
                "social_media",
                "copywriting",
              ],
              budgetMonthlyCents: 8000,
              reportsTo: "role:ceo",
            },
          ],
          goals: [
            {
              title: "Launch MVP",
              description: "Ship the minimum viable product to first users",
              level: "company",
            },
            {
              title: "Reach 100 Users",
              description: "Acquire first 100 active users",
              level: "company",
            },
            {
              title: "Establish CI/CD Pipeline",
              description: "Set up automated testing and deployment",
              level: "team",
            },
          ],
          prompts: [],
        },
      },
      {
        name: "Marketing Agency",
        description:
          "A full-service digital marketing agency with specialists in content, SEO, social media, and analytics.",
        category: "marketing",
        tags: ["agency", "marketing", "content", "seo", "social"],
        config: {
          name: "My Marketing Agency",
          description: "An AI-powered digital marketing agency",
          mission:
            "Deliver measurable marketing results through data-driven strategies",
          budgetMonthlyCents: 40000,
          agents: [
            {
              name: "Beacon",
              role: "ceo",
              title: "Marketing Director",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Marketing Director overseeing all marketing operations. Define campaign strategies, allocate budgets, and ensure all marketing efforts align with client objectives. Review performance metrics and adjust strategies accordingly.",
              capabilities: [
                "strategy",
                "leadership",
                "client_management",
                "analytics",
              ],
              budgetMonthlyCents: 10000,
              reportsTo: null,
            },
            {
              name: "Muse",
              role: "marketer",
              title: "Content Strategist",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Content Strategist. Plan and create compelling content across all channels. Develop editorial calendars, write blog posts, create email campaigns, and ensure brand voice consistency. Focus on content that drives engagement and conversions.",
              capabilities: [
                "content_creation",
                "copywriting",
                "editorial_planning",
                "brand_voice",
              ],
              budgetMonthlyCents: 8000,
              reportsTo: "role:ceo",
            },
            {
              name: "Cipher",
              role: "marketer",
              title: "SEO Specialist",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the SEO Specialist. Conduct keyword research, optimize on-page SEO, build link strategies, and monitor search rankings. Provide data-driven recommendations to improve organic visibility and traffic.",
              capabilities: [
                "seo",
                "keyword_research",
                "analytics",
                "technical_seo",
                "link_building",
              ],
              budgetMonthlyCents: 7000,
              reportsTo: "role:ceo",
            },
            {
              name: "Pulse",
              role: "marketer",
              title: "Social Media Manager",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Social Media Manager. Create and schedule engaging social content, manage community engagement, monitor brand mentions, and grow social following. Stay current with platform trends and algorithm changes.",
              capabilities: [
                "social_media",
                "community_management",
                "content_creation",
                "trend_analysis",
              ],
              budgetMonthlyCents: 7000,
              reportsTo: "role:ceo",
            },
            {
              name: "Lens",
              role: "custom",
              title: "Analytics Lead",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Analytics Lead. Track campaign performance, build dashboards, generate reports, and identify optimization opportunities. Use data to tell stories and drive strategic decisions across the agency.",
              capabilities: [
                "analytics",
                "reporting",
                "data_visualization",
                "a_b_testing",
              ],
              budgetMonthlyCents: 8000,
              reportsTo: "role:ceo",
            },
          ],
          goals: [
            {
              title: "Increase Organic Traffic 50%",
              description: "Grow organic search traffic by 50% over baseline",
              level: "company",
            },
            {
              title: "Launch Content Calendar",
              description:
                "Establish and maintain a consistent publishing schedule",
              level: "team",
            },
            {
              title: "Build Analytics Dashboard",
              description:
                "Create comprehensive marketing performance dashboard",
              level: "team",
            },
          ],
          prompts: [],
        },
      },
      {
        name: "E-commerce Business",
        description:
          "A complete e-commerce team with product management, development, marketing, and customer support.",
        category: "ecommerce",
        tags: ["ecommerce", "retail", "product", "customer_support"],
        config: {
          name: "My E-commerce Store",
          description: "An AI-powered e-commerce business",
          mission:
            "Deliver exceptional online shopping experiences with outstanding customer service",
          budgetMonthlyCents: 45000,
          agents: [
            {
              name: "Summit",
              role: "ceo",
              title: "Chief Executive Officer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the CEO of an e-commerce company. Focus on business growth, profitability, and customer satisfaction. Coordinate between product, engineering, marketing, and support teams. Make strategic decisions about product catalog, pricing, and expansion.",
              capabilities: [
                "strategy",
                "leadership",
                "business_analysis",
                "decision_making",
              ],
              budgetMonthlyCents: 10000,
              reportsTo: null,
            },
            {
              name: "Craft",
              role: "custom",
              title: "Product Manager",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Product Manager. Define product requirements, manage the product roadmap, and prioritize features. Analyze customer feedback and market trends to inform product decisions. Write clear specifications for engineering.",
              capabilities: [
                "product_management",
                "requirements",
                "roadmap_planning",
                "user_research",
              ],
              budgetMonthlyCents: 9000,
              reportsTo: "role:ceo",
            },
            {
              name: "Bolt",
              role: "engineer",
              title: "Full-Stack Developer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the full-stack developer for an e-commerce platform. Build and maintain the storefront, checkout flow, inventory system, and admin panel. Optimize for performance, security, and conversion rate.",
              capabilities: [
                "coding",
                "fullstack",
                "ecommerce_platforms",
                "payment_integration",
              ],
              budgetMonthlyCents: 9000,
              reportsTo: "role:ceo",
            },
            {
              name: "Spark",
              role: "marketer",
              title: "Growth Marketer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Growth Marketer for an e-commerce business. Drive traffic and sales through email marketing, paid ads, SEO, and social commerce. Optimize conversion funnels and manage promotional campaigns.",
              capabilities: [
                "email_marketing",
                "paid_ads",
                "conversion_optimization",
                "seo",
              ],
              budgetMonthlyCents: 9000,
              reportsTo: "role:ceo",
            },
            {
              name: "Haven",
              role: "support",
              title: "Customer Support Lead",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Customer Support Lead. Handle customer inquiries, resolve issues, manage returns and exchanges, and maintain high satisfaction scores. Identify common issues and suggest product or process improvements.",
              capabilities: [
                "customer_service",
                "conflict_resolution",
                "process_improvement",
                "knowledge_base",
              ],
              budgetMonthlyCents: 8000,
              reportsTo: "role:ceo",
            },
          ],
          goals: [
            {
              title: "Launch Online Store",
              description:
                "Get the storefront live with initial product catalog",
              level: "company",
            },
            {
              title: "Achieve 95% CSAT",
              description: "Maintain 95% or higher customer satisfaction score",
              level: "company",
            },
            {
              title: "Optimize Checkout Flow",
              description: "Reduce cart abandonment rate by 20%",
              level: "team",
            },
          ],
          prompts: [],
        },
      },
      {
        name: "Consulting Firm",
        description:
          "A professional consulting firm with partners, consultants, analysts, and research support.",
        category: "consulting",
        tags: ["consulting", "professional_services", "research", "analysis"],
        config: {
          name: "My Consulting Firm",
          description: "An AI-powered consulting practice",
          mission:
            "Deliver actionable insights and strategic recommendations that drive measurable business impact",
          budgetMonthlyCents: 40000,
          agents: [
            {
              name: "Apex",
              role: "ceo",
              title: "Managing Partner",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Managing Partner of a consulting firm. Lead client engagements, develop business strategy, and manage partner relationships. Ensure quality deliverables and drive revenue growth. Set the strategic direction for the practice.",
              capabilities: [
                "strategy",
                "client_management",
                "leadership",
                "business_development",
              ],
              budgetMonthlyCents: 10000,
              reportsTo: null,
            },
            {
              name: "Sage",
              role: "custom",
              title: "Senior Consultant",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are a Senior Consultant. Lead project workstreams, develop frameworks and methodologies, and deliver client presentations. Mentor junior team members and ensure analytical rigor in all deliverables.",
              capabilities: [
                "consulting",
                "frameworks",
                "presentations",
                "project_management",
                "mentoring",
              ],
              budgetMonthlyCents: 9000,
              reportsTo: "role:ceo",
            },
            {
              name: "Quant",
              role: "custom",
              title: "Business Analyst",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are a Business Analyst. Conduct quantitative and qualitative analysis, build financial models, and create data-driven recommendations. Support senior consultants with research and analysis for client deliverables.",
              capabilities: [
                "data_analysis",
                "financial_modeling",
                "research",
                "excel",
                "visualization",
              ],
              budgetMonthlyCents: 7000,
              reportsTo: "role:ceo",
            },
            {
              name: "Scout",
              role: "custom",
              title: "Research Lead",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Research Lead. Conduct market research, competitive analysis, and industry studies. Maintain a knowledge base of industry trends, best practices, and benchmarks. Synthesize complex information into clear insights.",
              capabilities: [
                "market_research",
                "competitive_analysis",
                "industry_analysis",
                "writing",
              ],
              budgetMonthlyCents: 7000,
              reportsTo: "role:ceo",
            },
            {
              name: "Core",
              role: "custom",
              title: "Operations & Admin",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are responsible for operations and administration. Manage project timelines, coordinate meetings, maintain documentation, handle invoicing, and ensure smooth firm operations. Support the team with logistics and process management.",
              capabilities: [
                "project_management",
                "documentation",
                "scheduling",
                "process_management",
              ],
              budgetMonthlyCents: 7000,
              reportsTo: "role:ceo",
            },
          ],
          goals: [
            {
              title: "Win First Client",
              description: "Secure the first paid consulting engagement",
              level: "company",
            },
            {
              title: "Build Framework Library",
              description:
                "Create reusable consulting frameworks and templates",
              level: "team",
            },
            {
              title: "Establish Research Process",
              description: "Define systematic approach to industry research",
              level: "team",
            },
          ],
          prompts: [],
        },
      },
      {
        name: "Content Studio",
        description:
          "A creative content production studio with writers, editors, SEO specialists, and social media managers.",
        category: "content",
        tags: ["content", "creative", "writing", "editorial", "media"],
        config: {
          name: "My Content Studio",
          description: "An AI-powered content production studio",
          mission:
            "Create compelling, high-quality content that educates, entertains, and converts",
          budgetMonthlyCents: 35000,
          agents: [
            {
              name: "Vision",
              role: "ceo",
              title: "Creative Director",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Creative Director. Set the creative vision, maintain brand standards, and oversee all content production. Review and approve content before publication. Guide the team on tone, style, and creative direction.",
              capabilities: [
                "creative_direction",
                "brand_management",
                "content_strategy",
                "quality_control",
              ],
              budgetMonthlyCents: 8000,
              reportsTo: null,
            },
            {
              name: "Quill",
              role: "custom",
              title: "Senior Writer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are a Senior Writer specializing in long-form content. Write blog posts, whitepapers, case studies, and thought leadership articles. Research topics thoroughly and craft engaging narratives that inform and persuade.",
              capabilities: [
                "long_form_writing",
                "research",
                "storytelling",
                "thought_leadership",
              ],
              budgetMonthlyCents: 6000,
              reportsTo: "role:ceo",
            },
            {
              name: "Flash",
              role: "custom",
              title: "Copywriter",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are a Copywriter specializing in short-form and conversion copy. Write headlines, ad copy, email subject lines, landing pages, and social captions. Focus on clarity, persuasion, and driving action.",
              capabilities: [
                "copywriting",
                "ad_copy",
                "email_marketing",
                "conversion_optimization",
              ],
              budgetMonthlyCents: 6000,
              reportsTo: "role:ceo",
            },
            {
              name: "Refine",
              role: "custom",
              title: "Editor",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Editor. Review all content for grammar, style, accuracy, and brand consistency. Provide constructive feedback to writers. Maintain the style guide and ensure editorial standards are met across all publications.",
              capabilities: [
                "editing",
                "proofreading",
                "style_guide",
                "fact_checking",
                "quality_assurance",
              ],
              budgetMonthlyCents: 5000,
              reportsTo: "role:ceo",
            },
            {
              name: "Signal",
              role: "marketer",
              title: "SEO Content Specialist",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the SEO Content Specialist. Optimize all content for search visibility. Conduct keyword research, write SEO briefs, and ensure content follows SEO best practices without sacrificing quality. Track rankings and organic traffic.",
              capabilities: [
                "seo",
                "keyword_research",
                "content_optimization",
                "analytics",
              ],
              budgetMonthlyCents: 5000,
              reportsTo: "role:ceo",
            },
            {
              name: "Ripple",
              role: "marketer",
              title: "Social Media Producer",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              systemPrompt:
                "You are the Social Media Producer. Repurpose long-form content into social media formats. Create platform-specific content for Twitter, LinkedIn, Instagram, and more. Build engagement and grow the audience across channels.",
              capabilities: [
                "social_media",
                "content_repurposing",
                "community_management",
                "visual_content",
              ],
              budgetMonthlyCents: 5000,
              reportsTo: "role:ceo",
            },
          ],
          goals: [
            {
              title: "Publish Weekly Content",
              description: "Maintain consistent weekly publishing schedule",
              level: "company",
            },
            {
              title: "Build Style Guide",
              description: "Create comprehensive brand and content style guide",
              level: "team",
            },
            {
              title: "Grow Social Following",
              description:
                "Increase social media following by 100% in 3 months",
              level: "team",
            },
          ],
          prompts: [],
        },
      },
    ];

    for (const t of templates) {
      await this.saveTemplate({
        name: t.name,
        description: t.description,
        category: t.category,
        author: "Eidolon",
        version: "1.0.0",
        config: t.config,
        tags: t.tags,
        isPublic: true,
      });
    }

    logger.info({ count: templates.length }, "Built-in templates seeded");
  }
}
