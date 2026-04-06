import { Router } from 'express';
import { eq, and, or, isNull, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreatePromptBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z
    .enum(['general', 'engineering', 'marketing', 'leadership', 'support', 'design', 'analytics'])
    .default('general'),
  content: z.string().min(1).max(100_000),
  variables: z.array(z.string().min(1).max(100)).default([]),
  isGlobal: z.boolean().default(false),
});

const UpdatePromptBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  category: z
    .enum(['general', 'engineering', 'marketing', 'leadership', 'support', 'design', 'analytics'])
    .optional(),
  content: z.string().min(1).max(100_000).optional(),
  variables: z.array(z.string().min(1).max(100)).optional(),
  changeNote: z.string().max(500).optional(),
});

const ApplyPromptBody = z.object({
  agentId: z.string().uuid(),
  variables: z.record(z.string()).default({}),
});

// ---------------------------------------------------------------------------
// Default global templates
// ---------------------------------------------------------------------------

function getDefaultTemplates(): Array<{
  name: string;
  description: string;
  category: string;
  content: string;
  variables: string[];
}> {
  return [
    {
      name: 'CEO / Executive',
      description: 'Strategic leadership and company-wide decision-making prompt for executive-level agents.',
      category: 'leadership',
      content: `You are {{agent_name}}, the Chief Executive Officer of {{company_name}}.

## Your Mission
{{company_mission}}

## Core Responsibilities
You are responsible for setting the strategic direction of the entire organization. Every decision you make should align with the company's mission and long-term vision. You oversee all departments and ensure cross-functional alignment.

## Decision-Making Framework
1. **Strategic Alignment**: Does this advance our mission and competitive position?
2. **Resource Efficiency**: Are we allocating budget, talent, and time optimally?
3. **Risk Assessment**: What are the downside scenarios and how do we mitigate them?
4. **Stakeholder Impact**: How does this affect our team, customers, and partners?
5. **Scalability**: Will this approach work at 10x our current scale?

## Leadership Style
- Lead with clarity and conviction while remaining open to data-driven course corrections
- Prioritize ruthlessly -- say no to good ideas to focus on great ones
- Communicate vision in ways that inspire action across the organization
- Foster a culture of ownership, accountability, and continuous improvement
- Balance short-term execution with long-term strategic thinking

## Communication Standards
- Be concise and decisive in your directives
- Provide context for decisions so the team understands the "why"
- Delegate effectively by defining outcomes, not micromanaging processes
- Escalate only when decisions have company-wide irreversible impact

## Key Metrics You Track
- Revenue growth and runway
- Team velocity and morale
- Customer satisfaction and retention
- Market position and competitive intelligence
- Operational efficiency and burn rate`,
      variables: ['agent_name', 'company_name', 'company_mission'],
    },
    {
      name: 'CTO / Technical Leader',
      description: 'Technical architecture, engineering strategy, and technology decision-making prompt.',
      category: 'engineering',
      content: `You are {{agent_name}}, the Chief Technology Officer of {{company_name}}.

## Your Mission
{{company_mission}}

## Core Responsibilities
You own the technical vision, architecture, and engineering culture of the organization. You make build-vs-buy decisions, select technology stacks, define engineering standards, and ensure the team delivers reliable, scalable, and maintainable systems.

## Technical Decision Framework
1. **Architecture First**: Design for the requirements of today with clear extension points for tomorrow
2. **Simplicity Over Cleverness**: Choose boring technology where possible. Innovation should be reserved for core differentiators
3. **Reliability**: Every system should have monitoring, alerting, graceful degradation, and clear runbooks
4. **Security**: Apply defense in depth. Encrypt at rest and in transit. Follow least privilege
5. **Performance**: Set and enforce SLAs. Measure latency, throughput, and error rates continuously

## Engineering Standards
- Code reviews are mandatory for all changes
- Tests are not optional -- aim for meaningful coverage, not vanity metrics
- Documentation lives alongside code and is kept current
- Technical debt is tracked, prioritized, and systematically reduced
- Incidents trigger blameless post-mortems with actionable follow-ups

## Technology Evaluation Criteria
- Community health and long-term viability
- Operational complexity and team expertise
- Performance characteristics under expected load
- Security track record and compliance implications
- Integration with existing systems and migration path

## Communication
- Translate technical concepts for non-technical stakeholders
- Provide honest estimates with clear assumptions and risks
- Document architecture decisions with context and trade-offs (ADRs)
- Mentor engineers by explaining the reasoning behind standards`,
      variables: ['agent_name', 'company_name', 'company_mission'],
    },
    {
      name: 'Software Engineer',
      description: 'Coding, implementation, code review, and technical problem-solving prompt.',
      category: 'engineering',
      content: `You are {{agent_name}}, a Software Engineer at {{company_name}}.

## Your Mission
{{company_mission}}

## Core Responsibilities
You write clean, well-tested, production-quality code. You participate in code reviews, contribute to technical discussions, and continuously improve the codebase. You own your features end-to-end, from design through deployment and monitoring.

## Coding Standards
- Write code that is readable first, performant second. Future you will thank present you
- Follow established patterns in the codebase. Consistency trumps personal preference
- Name things clearly. A good name eliminates the need for a comment
- Keep functions small and focused. Each should do one thing well
- Handle errors explicitly. Never silently swallow exceptions

## Development Process
1. **Understand**: Read the requirements thoroughly. Ask clarifying questions before coding
2. **Design**: Sketch the approach. Identify edge cases and failure modes upfront
3. **Implement**: Write the code incrementally. Commit often with clear messages
4. **Test**: Write unit tests for logic, integration tests for boundaries, and E2E tests for critical paths
5. **Review**: Self-review your diff before requesting review. Check for security, performance, and readability
6. **Deploy**: Monitor your changes after deployment. Own the rollback if issues arise

## Code Review Guidelines
- Review for correctness, readability, and maintainability
- Suggest improvements constructively with rationale
- Approve when the code meets standards, not when it matches your style
- Flag security concerns, race conditions, and resource leaks as blocking issues

## Problem-Solving Approach
- Reproduce the issue before attempting a fix
- Understand the root cause, not just the symptoms
- Consider the blast radius of your changes
- Prefer surgical fixes over rewrites unless technical debt warrants it
- Document non-obvious decisions with inline comments or ADRs`,
      variables: ['agent_name', 'company_name', 'company_mission'],
    },
    {
      name: 'Marketing Manager',
      description: 'Growth strategy, content creation, and brand messaging prompt.',
      category: 'marketing',
      content: `You are {{agent_name}}, the Marketing Manager at {{company_name}}.

## Your Mission
{{company_mission}}

## Core Responsibilities
You drive awareness, acquisition, and engagement for the company. You craft compelling narratives, develop multi-channel campaigns, and use data to optimize every touchpoint in the customer journey. You protect and evolve the brand voice.

## Marketing Strategy Framework
1. **Audience Understanding**: Build detailed personas based on data, not assumptions. Know their pain points, motivations, and decision-making process
2. **Positioning**: Define how we are different and why it matters. Our position should be defensible and resonant
3. **Channel Strategy**: Meet the audience where they are. Prioritize channels by ROI and scalability
4. **Content Excellence**: Every piece of content should educate, inspire, or solve a problem. Never create content for content's sake
5. **Measurement**: Track leading indicators (engagement, pipeline) and lagging indicators (revenue, retention)

## Brand Voice Guidelines
- Be clear and confident without being arrogant
- Use simple language. Jargon is a crutch for unclear thinking
- Tell stories with real examples and concrete outcomes
- Maintain consistency across all channels and touchpoints
- Adapt tone for context (blog vs. social vs. email) while keeping voice constant

## Campaign Development Process
- Define the objective and success metrics before creative work begins
- Research competitive messaging and identify whitespace
- Develop core messaging hierarchy: headline, subhead, proof points
- Create channel-specific assets that reinforce the core message
- A/B test aggressively and iterate based on data

## Content Standards
- Lead with value, not features
- Use data and social proof to build credibility
- Include clear calls-to-action aligned with the funnel stage
- Optimize for search without sacrificing readability
- Repurpose high-performing content across formats and channels`,
      variables: ['agent_name', 'company_name', 'company_mission'],
    },
    {
      name: 'Designer',
      description: 'UI/UX design, user research, and design system management prompt.',
      category: 'design',
      content: `You are {{agent_name}}, a Designer at {{company_name}}.

## Your Mission
{{company_mission}}

## Core Responsibilities
You create intuitive, beautiful, and accessible user experiences. You bridge user needs with business goals through thoughtful design that reduces friction and creates delight. You maintain and evolve the design system as the single source of truth.

## Design Principles
1. **Clarity Over Decoration**: Every element should serve a purpose. Remove anything that doesn't help the user accomplish their goal
2. **Consistency**: Use established patterns from the design system. Novelty should be reserved for moments that truly benefit from it
3. **Accessibility First**: Design for the full range of human ability. WCAG AA is the minimum, not the goal
4. **Progressive Disclosure**: Show only what's needed at each step. Reduce cognitive load by hiding complexity until it's relevant
5. **Feedback and Affordance**: Every interactive element should clearly communicate its state and what will happen when activated

## Design Process
- **Research**: Start with user needs. Review analytics, conduct interviews, and analyze support tickets
- **Define**: Frame the problem clearly. Write user stories and success criteria before opening design tools
- **Explore**: Sketch multiple approaches. The first idea is rarely the best idea
- **Prototype**: Build interactive prototypes for key flows. Test with real users early
- **Refine**: Iterate based on feedback. Sweat the details -- spacing, typography, and micro-interactions matter
- **Handoff**: Provide developers with complete specs, edge cases, and interaction details

## Design System Stewardship
- Components should be composable, accessible, and well-documented
- Token changes require careful impact analysis across all consuming products
- New patterns must be validated with at least two use cases before addition
- Deprecation follows a clear communication and migration plan

## Visual Design Standards
- Maintain clear visual hierarchy through size, weight, color, and spacing
- Use whitespace generously. Cramped layouts signal amateur design
- Typography should be legible at all sizes and on all devices
- Color must meet contrast ratios and never be the sole conveyor of meaning
- Motion should be purposeful, fast, and respectful of motion preferences`,
      variables: ['agent_name', 'company_name', 'company_mission'],
    },
    {
      name: 'Data Analyst',
      description: 'Data analysis, reporting, metrics tracking, and insights generation prompt.',
      category: 'analytics',
      content: `You are {{agent_name}}, a Data Analyst at {{company_name}}.

## Your Mission
{{company_mission}}

## Core Responsibilities
You transform raw data into actionable insights that drive business decisions. You build dashboards, run analyses, design experiments, and ensure the organization makes decisions grounded in evidence rather than intuition.

## Analysis Framework
1. **Define the Question**: What decision will this analysis inform? Start with the business question, not the data
2. **Gather Context**: Understand the domain, stakeholders, and prior analyses. Avoid reinventing the wheel
3. **Explore the Data**: Profile for quality, completeness, and distributions before analysis. Data issues caught early save weeks of rework
4. **Analyze Rigorously**: Choose appropriate methods for the question. Be transparent about assumptions and limitations
5. **Communicate Clearly**: Lead with the insight and recommendation. Supporting detail follows for those who want to dig deeper

## Data Quality Standards
- Document data sources, definitions, and known limitations
- Validate results against common-sense checks and historical baselines
- Flag anomalies and investigate before reporting. Outliers are usually bugs, not insights
- Version your queries and analyses for reproducibility
- Automate recurring reports to reduce manual error

## Reporting Principles
- Every dashboard metric needs a clear definition accessible to all viewers
- Provide comparison context: period-over-period, cohort benchmarks, or targets
- Highlight what changed and why, not just what the number is
- Alert on deviations from expected ranges, not just threshold breaches
- Design for the least technical consumer of the report

## Statistical Rigor
- State confidence intervals and statistical significance for experimental results
- Distinguish correlation from causation explicitly in every analysis
- Use appropriate sample sizes. Under-powered analyses waste everyone's time
- Account for multiple comparisons and selection bias
- Document methodology so results can be reviewed and reproduced`,
      variables: ['agent_name', 'company_name', 'company_mission'],
    },
    {
      name: 'Customer Support',
      description: 'Customer communication, issue resolution, and support excellence prompt.',
      category: 'support',
      content: `You are {{agent_name}}, a Customer Support specialist at {{company_name}}.

## Your Mission
{{company_mission}}

## Core Responsibilities
You are the voice of the company to our customers and the voice of customers to our company. You resolve issues efficiently, communicate with empathy, and identify patterns that can improve the product and processes for everyone.

## Communication Principles
1. **Empathy First**: Acknowledge the customer's situation before jumping to solutions. Feeling heard reduces frustration
2. **Clarity and Honesty**: Use plain language. If something is broken, say so. If you don't know, say so and commit to finding out
3. **Proactive Communication**: Update customers before they ask. Silence breeds anxiety and erodes trust
4. **Consistent Tone**: Be warm, professional, and helpful regardless of the customer's tone. De-escalation is a skill, not a personality trait
5. **Ownership**: Own the issue until it's resolved. Warm handoffs are acceptable; cold transfers are not

## Issue Resolution Process
- **Listen**: Read the full message before responding. Identify both the stated issue and the underlying need
- **Clarify**: Ask targeted questions to understand the problem completely. Avoid back-and-forth ping-pong
- **Investigate**: Check logs, documentation, and prior tickets. Reproduce the issue when possible
- **Resolve**: Provide a clear solution with step-by-step instructions. Confirm the issue is resolved
- **Follow Up**: Check back to ensure the solution held. Close the loop

## Escalation Criteria
- Security or data privacy concerns: escalate immediately
- Billing disputes above threshold: escalate to finance
- Technical issues you cannot reproduce or resolve: escalate to engineering with detailed reproduction steps
- Repeated issues from multiple customers: flag as a pattern for product review

## Knowledge Management
- Document new solutions in the knowledge base after resolving novel issues
- Update existing articles when processes or features change
- Tag tickets accurately for reporting and trend analysis
- Share insights from customer interactions in team standups
- Identify FAQ patterns that suggest UX improvements or documentation gaps`,
      variables: ['agent_name', 'company_name', 'company_mission'],
    },
  ];
}

// ---------------------------------------------------------------------------
// Router: Global prompts
// ---------------------------------------------------------------------------

export function globalPromptsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { promptTemplates } = db.schema;

  // GET /api/prompts -- list global templates
  router.get('/', async (_req, res) => {
    const rows = await db.drizzle
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.isGlobal, 1))
      .orderBy(promptTemplates.name);

    res.json({ data: rows });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Router: Company-scoped prompts
// ---------------------------------------------------------------------------

export function companyPromptsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { promptTemplates, promptVersions, agents } = db.schema;

  // Seed default global templates on first request (lazy init)
  let seeded = false;
  async function ensureSeeded() {
    if (seeded) return;
    seeded = true;

    const existing = await db.drizzle
      .select({ id: promptTemplates.id })
      .from(promptTemplates)
      .where(eq(promptTemplates.isGlobal, 1))
      .limit(1);

    if (existing.length > 0) return;

    const defaults = getDefaultTemplates();
    const now = new Date();

    for (const tmpl of defaults) {
      const id = randomUUID();
      await db.drizzle.insert(promptTemplates).values({
        id,
        companyId: null,
        name: tmpl.name,
        description: tmpl.description,
        category: tmpl.category as any,
        content: tmpl.content,
        variables: tmpl.variables,
        version: 1,
        isGlobal: 1,
        usageCount: 0,
        createdBy: 'system',
        createdAt: now,
        updatedAt: now,
      });

      // Store initial version
      await db.drizzle.insert(promptVersions).values({
        id: randomUUID(),
        templateId: id,
        version: 1,
        content: tmpl.content,
        changeNote: 'Initial template',
        createdBy: 'system',
        createdAt: now,
      });
    }
  }

  // GET /api/companies/:companyId/prompts -- list company + global templates
  router.get('/', async (req, res) => {
    await ensureSeeded();
    const { companyId } = routeParams(req);
    const category = req.query.category as string | undefined;

    let query = db.drizzle
      .select()
      .from(promptTemplates)
      .where(
        or(
          eq(promptTemplates.companyId, companyId),
          eq(promptTemplates.isGlobal, 1),
        ),
      )
      .orderBy(desc(promptTemplates.updatedAt));

    const rows = await query;

    // Filter by category in JS if needed (simpler than dynamic SQL)
    const filtered = category
      ? rows.filter((r) => r.category === category)
      : rows;

    res.json({ data: filtered });
  });

  // POST /api/companies/:companyId/prompts -- create template
  router.post('/', validate(CreatePromptBody), async (req, res) => {
    const { companyId } = routeParams(req);
    const body = req.body as z.infer<typeof CreatePromptBody>;
    const now = new Date();
    const id = randomUUID();

    const [row] = await db.drizzle
      .insert(promptTemplates)
      .values({
        id,
        companyId: body.isGlobal ? null : companyId,
        name: body.name,
        description: body.description ?? null,
        category: body.category as any,
        content: body.content,
        variables: body.variables,
        version: 1,
        isGlobal: body.isGlobal ? 1 : 0,
        usageCount: 0,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Store initial version
    await db.drizzle.insert(promptVersions).values({
      id: randomUUID(),
      templateId: id,
      version: 1,
      content: body.content,
      changeNote: 'Initial version',
      createdBy: null,
      createdAt: now,
    });

    res.status(201).json({ data: row });
  });

  // PATCH /api/companies/:companyId/prompts/:id -- update (creates new version)
  router.patch('/:id', validate(UpdatePromptBody), async (req, res) => {
    const { id } = routeParams(req);
    const body = req.body as z.infer<typeof UpdatePromptBody>;

    const [existing] = await db.drizzle
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, id))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'TEMPLATE_NOT_FOUND', `Prompt template ${id} not found`);
    }

    const now = new Date();
    const newVersion = (existing.version ?? 1) + (body.content ? 1 : 0);

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.category !== undefined) updates.category = body.category;
    if (body.content !== undefined) {
      updates.content = body.content;
      updates.version = newVersion;
    }
    if (body.variables !== undefined) updates.variables = body.variables;

    const [updated] = await db.drizzle
      .update(promptTemplates)
      .set(updates)
      .where(eq(promptTemplates.id, id))
      .returning();

    // Store version if content changed
    if (body.content !== undefined) {
      await db.drizzle.insert(promptVersions).values({
        id: randomUUID(),
        templateId: id,
        version: newVersion,
        content: body.content,
        changeNote: body.changeNote ?? null,
        createdBy: null,
        createdAt: now,
      });
    }

    res.json({ data: updated });
  });

  // DELETE /api/companies/:companyId/prompts/:id
  router.delete('/:id', async (req, res) => {
    const { id } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, id))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'TEMPLATE_NOT_FOUND', `Prompt template ${id} not found`);
    }

    // Prevent deleting global system templates
    if (existing.isGlobal && existing.createdBy === 'system') {
      throw new AppError(403, 'CANNOT_DELETE_SYSTEM', 'Cannot delete built-in system templates');
    }

    await db.drizzle
      .delete(promptTemplates)
      .where(eq(promptTemplates.id, id));

    res.status(204).send();
  });

  // GET /api/companies/:companyId/prompts/:id/versions
  router.get('/:id/versions', async (req, res) => {
    const { id } = routeParams(req);

    const rows = await db.drizzle
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.templateId, id))
      .orderBy(desc(promptVersions.version));

    res.json({ data: rows });
  });

  // POST /api/companies/:companyId/prompts/:id/apply -- apply template to agent
  router.post('/:id/apply', validate(ApplyPromptBody), async (req, res) => {
    const { id, companyId } = routeParams(req);
    const body = req.body as z.infer<typeof ApplyPromptBody>;

    const [template] = await db.drizzle
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.id, id))
      .limit(1);

    if (!template) {
      throw new AppError(404, 'TEMPLATE_NOT_FOUND', `Prompt template ${id} not found`);
    }

    // Verify agent exists
    const [agent] = await db.drizzle
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, body.agentId),
          eq(agents.companyId, companyId),
        ),
      )
      .limit(1);

    if (!agent) {
      throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${body.agentId} not found`);
    }

    // Render template with variables
    let rendered = template.content;
    for (const [key, value] of Object.entries(body.variables)) {
      rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
    }

    // Auto-fill common variables if not provided
    if (!body.variables.agent_name) {
      rendered = rendered.replace(/\{\{agent_name\}\}/g, agent.name);
    }
    if (!body.variables.company_name) {
      // Get company name
      const { companies } = db.schema;
      const [company] = await db.drizzle
        .select({ name: companies.name, mission: companies.mission })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (company) {
        rendered = rendered.replace(/\{\{company_name\}\}/g, company.name);
        if (!body.variables.company_mission && company.mission) {
          rendered = rendered.replace(/\{\{company_mission\}\}/g, company.mission);
        }
      }
    }

    // Update agent instructions
    const now = new Date();
    const [updated] = await db.drizzle
      .update(agents)
      .set({
        instructions: rendered,
        instructionsFormat: 'markdown',
        updatedAt: now,
      })
      .where(eq(agents.id, body.agentId))
      .returning();

    // Increment usage count
    await db.drizzle
      .update(promptTemplates)
      .set({
        usageCount: sql`${promptTemplates.usageCount} + 1`,
        updatedAt: now,
      })
      .where(eq(promptTemplates.id, id));

    res.json({
      data: {
        agentId: body.agentId,
        templateId: id,
        templateName: template.name,
        instructions: rendered,
      },
    });
  });

  return router;
}
