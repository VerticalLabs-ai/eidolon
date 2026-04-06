// Eidolon v0.2 — comprehensive seed with projects, issues, goals, agents, docs
import type { InferInsertModel } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createDb } from "./index.js";
import { agents } from "./schema/agents.js";
import { companies } from "./schema/companies.js";
import { goals } from "./schema/goals.js";
import { knowledgeDocuments } from "./schema/knowledge.js";
import { messages } from "./schema/messages.js";
import { projects } from "./schema/projects.js";
import { promptTemplates } from "./schema/prompts.js";
import { tasks } from "./schema/tasks.js";

function id() {
  return randomUUID();
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

async function seed() {
  const { db, connection } = createDb();

  console.log("Seeding database...");

  // =========================================================================
  // Company
  // =========================================================================
  const companyId = id();

  db.insert(companies)
    .values({
      id: companyId,
      name: "Eidolon",
      description:
        "The AI Company Runtime — autonomous agent orchestration platform for building, managing, and scaling AI-powered software teams.",
      mission:
        "Build the most powerful open-source platform for autonomous AI companies, enabling teams to hire, orchestrate, and manage AI agents that build real software.",
      status: "active",
      budgetMonthlyCents: 2500_00, // $2,500/month
      spentMonthlyCents: 342_50,
      settings: { timezone: "America/New_York", language: "en" },
      brandColor: "#F0B429",
    })
    .run();

  // =========================================================================
  // Agents — 8 agents across exec, engineering, product, marketing, ops
  // =========================================================================
  const ceoId = id();
  const ctoId = id();
  const cpoId = id();
  const eng1Id = id(); // backend
  const eng2Id = id(); // frontend
  const eng3Id = id(); // fullstack
  const designerId = id();
  const marketerId = id();

  const agentRows = [
    {
      id: ceoId,
      companyId,
      name: "Atlas",
      role: "ceo" as const,
      title: "Chief Executive Officer",
      provider: "anthropic" as const,
      model: "claude-opus-4-6",
      status: "idle" as const,
      reportsTo: null,
      capabilities: [
        "strategic-planning",
        "delegation",
        "budget-management",
        "reporting",
        "goal-setting",
      ],
      systemPrompt:
        "You are Atlas, the CEO of Eidolon. You set strategic direction, coordinate between department heads, manage the company budget, and ensure all work aligns with the mission of building the best AI orchestration platform.",
      budgetMonthlyCents: 400_00,
      spentMonthlyCents: 45_00,
      permissions: [
        "company:read",
        "company:write",
        "agents:manage",
        "tasks:manage",
        "goals:manage",
      ],
    },
    {
      id: ctoId,
      companyId,
      name: "Nova",
      role: "cto" as const,
      title: "Chief Technology Officer",
      provider: "anthropic" as const,
      model: "claude-opus-4-6",
      status: "idle" as const,
      reportsTo: ceoId,
      capabilities: [
        "architecture",
        "code-review",
        "technical-planning",
        "mentoring",
        "infrastructure",
      ],
      systemPrompt:
        "You are Nova, the CTO of Eidolon. You own the technical architecture, review all major technical decisions, lead the engineering team, and ensure the platform is scalable, secure, and well-tested.",
      budgetMonthlyCents: 400_00,
      spentMonthlyCents: 78_50,
      permissions: ["tasks:manage", "agents:read", "goals:read", "goals:write"],
    },
    {
      id: cpoId,
      companyId,
      name: "Sage",
      role: "custom" as const,
      title: "Chief Product Officer",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      status: "idle" as const,
      reportsTo: ceoId,
      capabilities: [
        "product-strategy",
        "user-research",
        "roadmap-planning",
        "prioritization",
        "analytics",
      ],
      systemPrompt:
        "You are Sage, the CPO of Eidolon. You define the product roadmap, prioritize features based on user feedback and competitive analysis, and ensure the product delivers real value to users.",
      budgetMonthlyCents: 300_00,
      spentMonthlyCents: 32_00,
      permissions: ["tasks:manage", "goals:manage", "agents:read"],
    },
    {
      id: eng1Id,
      companyId,
      name: "Bolt",
      role: "engineer" as const,
      title: "Senior Backend Engineer",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      status: "working" as const,
      reportsTo: ctoId,
      capabilities: [
        "backend-development",
        "database-design",
        "api-design",
        "testing",
        "performance",
      ],
      systemPrompt:
        "You are Bolt, a senior backend engineer at Eidolon. You implement server-side features, design database schemas, build APIs, write tests, and optimize performance.",
      budgetMonthlyCents: 300_00,
      spentMonthlyCents: 65_00,
      permissions: ["tasks:read", "tasks:write", "goals:read"],
    },
    {
      id: eng2Id,
      companyId,
      name: "Pixel",
      role: "engineer" as const,
      title: "Senior Frontend Engineer",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      status: "idle" as const,
      reportsTo: ctoId,
      capabilities: [
        "frontend-development",
        "ui-design",
        "accessibility",
        "performance",
        "animations",
      ],
      systemPrompt:
        "You are Pixel, a senior frontend engineer at Eidolon. You build responsive UIs, implement design systems, ensure accessibility, and create smooth animations and interactions.",
      budgetMonthlyCents: 300_00,
      spentMonthlyCents: 52_00,
      permissions: ["tasks:read", "tasks:write", "goals:read"],
    },
    {
      id: eng3Id,
      companyId,
      name: "Flux",
      role: "engineer" as const,
      title: "Fullstack Engineer",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      status: "idle" as const,
      reportsTo: ctoId,
      capabilities: [
        "fullstack-development",
        "devops",
        "ci-cd",
        "testing",
        "infrastructure",
      ],
      systemPrompt:
        "You are Flux, a fullstack engineer at Eidolon. You work across the stack, build features end-to-end, maintain CI/CD pipelines, and handle infrastructure concerns.",
      budgetMonthlyCents: 300_00,
      spentMonthlyCents: 38_00,
      permissions: ["tasks:read", "tasks:write", "goals:read"],
    },
    {
      id: designerId,
      companyId,
      name: "Prism",
      role: "designer" as const,
      title: "Lead Product Designer",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      status: "idle" as const,
      reportsTo: cpoId,
      capabilities: [
        "ui-design",
        "ux-research",
        "design-systems",
        "prototyping",
        "accessibility",
      ],
      systemPrompt:
        "You are Prism, the lead product designer at Eidolon. You define the visual language, create design systems, conduct UX research, and ensure the product is beautiful and intuitive.",
      budgetMonthlyCents: 200_00,
      spentMonthlyCents: 18_00,
      permissions: ["tasks:read", "tasks:write", "goals:read"],
    },
    {
      id: marketerId,
      companyId,
      name: "Echo",
      role: "marketer" as const,
      title: "Head of Growth",
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      status: "idle" as const,
      reportsTo: ceoId,
      capabilities: [
        "content-creation",
        "seo",
        "analytics",
        "social-media",
        "community-building",
      ],
      systemPrompt:
        "You are Echo, the Head of Growth at Eidolon. You craft compelling narratives, drive developer adoption, build community, create documentation, and analyze growth metrics.",
      budgetMonthlyCents: 200_00,
      spentMonthlyCents: 14_00,
      permissions: ["tasks:read", "tasks:write", "goals:read"],
    },
  ];

  for (const agent of agentRows) {
    db.insert(agents).values(agent).run();
  }

  // =========================================================================
  // Projects — 5 projects covering core platform areas
  // =========================================================================
  const projCore = id();
  const projAgentExec = id();
  const projDashboard = id();
  const projDocs = id();
  const projInfra = id();

  type ProjectInsert = InferInsertModel<typeof projects>;

  const projectRows = [
    {
      id: projCore,
      companyId,
      name: "Core Platform",
      description:
        "Foundation: database, API, auth, real-time events, multi-tenancy. Everything the platform needs to run.",
      status: "active",
      repoUrl: "https://github.com/verticallabs-ai/eidolon",
    },
    {
      id: projAgentExec,
      companyId,
      name: "Agent Execution Engine",
      description:
        "Heartbeat system, adapter integrations (Claude, Codex, Gemini), task assignment, execution logging, and approval workflows.",
      status: "active",
      repoUrl: "https://github.com/verticallabs-ai/eidolon",
    },
    {
      id: projDashboard,
      companyId,
      name: "Dashboard & UI",
      description:
        "React dashboard, sidebar navigation, project management, analytics views, animations, and mobile responsiveness.",
      status: "active",
      repoUrl: "https://github.com/verticallabs-ai/eidolon",
    },
    {
      id: projDocs,
      companyId,
      name: "Documentation & Community",
      description:
        "Developer docs, API reference, onboarding guides, blog posts, and community engagement.",
      status: "active",
      repoUrl: "https://github.com/verticallabs-ai/eidolon",
    },
    {
      id: projInfra,
      companyId,
      name: "Infrastructure & DevOps",
      description:
        "CI/CD, deployment, monitoring, backups, Docker setup, and production hardening.",
      status: "planning",
      repoUrl: "https://github.com/verticallabs-ai/eidolon",
    },
  ] satisfies ProjectInsert[];

  for (const project of projectRows) {
    db.insert(projects).values(project).run();
  }

  // =========================================================================
  // Goals — company-level and department-level OKRs
  // =========================================================================
  const goalLaunch = id();
  const goalTechFound = id();
  const goalAgentExec = id();
  const goalUX = id();
  const goalGrowth = id();

  db.insert(goals)
    .values([
      {
        id: goalLaunch,
        companyId,
        title: "Public launch by end of Q2 2026",
        description:
          "Ship Eidolon as an open-source product with full agent orchestration, project management, real-time dashboard, and developer documentation.",
        level: "company",
        status: "active",
        ownerAgentId: ceoId,
        progress: 35,
        targetDate: new Date("2026-06-30"),
        metrics: { targetFeatures: 20, completedFeatures: 7, targetUsers: 100 },
      },
      {
        id: goalTechFound,
        companyId,
        title: "Complete technical foundation",
        description:
          "Monorepo, database, API, WebSocket, authentication, and CI/CD pipeline fully operational.",
        level: "department",
        status: "active",
        parentId: goalLaunch,
        ownerAgentId: ctoId,
        progress: 65,
        targetDate: new Date("2026-05-15"),
        metrics: { targetMilestones: 8, completedMilestones: 5 },
      },
      {
        id: goalAgentExec,
        companyId,
        title: "Ship agent execution engine v1",
        description:
          "Heartbeat-based execution, multi-adapter support, task checkout semantics, execution logging, and basic approval workflows.",
        level: "department",
        status: "active",
        parentId: goalLaunch,
        ownerAgentId: ctoId,
        progress: 20,
        targetDate: new Date("2026-06-01"),
        metrics: { targetAdapters: 4, completedAdapters: 1 },
      },
      {
        id: goalUX,
        companyId,
        title: "Polished dashboard experience",
        description:
          "Modern dark UI with animations, grouped sidebar, project views, analytics, command palette, and mobile support.",
        level: "department",
        status: "active",
        parentId: goalLaunch,
        ownerAgentId: cpoId,
        progress: 45,
        targetDate: new Date("2026-05-30"),
        metrics: { targetPages: 15, completedPages: 10 },
      },
      {
        id: goalGrowth,
        companyId,
        title: "Build developer community",
        description:
          "Documentation site, blog, social media presence, 50 GitHub stars, and 10 external contributors.",
        level: "department",
        status: "draft",
        parentId: goalLaunch,
        ownerAgentId: marketerId,
        progress: 5,
        targetDate: new Date("2026-07-31"),
        metrics: { targetStars: 50, currentStars: 0, targetContributors: 10 },
      },
    ])
    .run();

  // =========================================================================
  // Tasks/Issues — comprehensive backlog across all projects
  // =========================================================================
  let taskNum = 0;
  function tn() {
    taskNum++;
    return { taskNumber: taskNum, identifier: `EID-${taskNum}` };
  }

  type TaskInsert = InferInsertModel<typeof tasks>;

  const allTasks = [
    // ── Core Platform (done + in progress) ─────────────────────────
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Set up pnpm monorepo with workspace packages",
      description:
        "Configure pnpm workspaces for packages/shared, packages/db, server, and ui with proper dependency resolution.",
      type: "feature",
      status: "done",
      priority: "critical",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["infra", "monorepo"],
      completedAt: daysAgo(10),
    },
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Design and implement database schema (26 tables)",
      description:
        "Create Drizzle ORM schema for companies, agents, tasks, goals, messages, executions, knowledge, and all supporting entities.",
      type: "feature",
      status: "done",
      priority: "critical",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["database", "schema"],
      completedAt: daysAgo(8),
    },
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Build Express REST API with 22 route files",
      description:
        "Implement CRUD endpoints for all entities with validation, error handling, and proper response formatting.",
      type: "feature",
      status: "done",
      priority: "high",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["api", "backend"],
      completedAt: daysAgo(6),
    },
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Implement WebSocket real-time event system",
      description:
        "Build EventBus + WS server for live updates. Support company-scoped subscriptions and typed events.",
      type: "feature",
      status: "done",
      priority: "high",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["websocket", "realtime"],
      completedAt: daysAgo(5),
    },
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Add CalVer release automation",
      description:
        "GitHub Actions workflow for automatic CalVer tagging and GitHub Release creation on push to main.",
      type: "feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["ci-cd", "releases"],
      completedAt: daysAgo(3),
    },
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Implement company hard-delete with cascade",
      description:
        "DELETE /api/companies/:id?hard=true that cascades through all related tables.",
      type: "feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["api", "data-management"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Add authentication & authorization system",
      description:
        "Implement JWT-based auth with user registration, login, API key management, and role-based access control.",
      type: "feature",
      status: "todo",
      priority: "critical",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["auth", "security"],
    },
    {
      companyId,
      projectId: projCore,
      goalId: goalTechFound,
      title: "Add rate limiting and request validation middleware",
      description:
        "Express middleware for rate limiting per API key, request body validation, and CORS configuration.",
      type: "feature",
      status: "backlog",
      priority: "high",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["security", "middleware"],
    },

    // ── Agent Execution Engine ──────────────────────────────────────
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Implement heartbeat-based agent execution loop",
      description:
        "Agents execute on heartbeat ticks triggered by timers, manual invoke, or task assignment. Each heartbeat evaluates pending tasks and executes the highest priority one.",
      type: "feature",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["agent-execution", "heartbeat"],
      startedAt: daysAgo(2),
    },
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Build Claude adapter (Anthropic SDK)",
      description:
        "Integrate @anthropic-ai/sdk for agent execution. Support system prompts, tool use, streaming responses, and token counting.",
      type: "feature",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["adapter", "claude", "anthropic"],
      startedAt: daysAgo(1),
    },
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Build OpenAI/Codex adapter",
      description:
        "Integrate OpenAI SDK for GPT-4/Codex execution with function calling and code generation capabilities.",
      type: "feature",
      status: "todo",
      priority: "high",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["adapter", "openai", "codex"],
    },
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Build Gemini adapter (Google AI)",
      description:
        "Integrate Google Generative AI SDK for Gemini model execution.",
      type: "feature",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["adapter", "gemini", "google"],
    },
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Implement task checkout semantics",
      description:
        "When an agent starts working on a task, lock it to prevent concurrent modification. Include automatic release on timeout.",
      type: "feature",
      status: "todo",
      priority: "high",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["task-management", "concurrency"],
    },
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Build execution logging and replay",
      description:
        "Store detailed execution logs (prompts, responses, tool calls, tokens) and support log replay for debugging.",
      type: "feature",
      status: "todo",
      priority: "medium",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["logging", "debugging"],
    },
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Implement approval workflows",
      description:
        "Human-in-the-loop approval system: agents can request approval before executing high-impact actions. Approve/reject via dashboard.",
      type: "feature",
      status: "backlog",
      priority: "high",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["approvals", "safety"],
    },
    {
      companyId,
      projectId: projAgentExec,
      goalId: goalAgentExec,
      title: "Add budget enforcement during execution",
      description:
        "Before each execution, check agent and company budgets. Pause agent if budget exceeded. Send alerts at 80% and 100% thresholds.",
      type: "feature",
      status: "todo",
      priority: "high",
      assigneeAgentId: eng1Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["budget", "safety"],
    },

    // ── Dashboard & UI ─────────────────────────────────────────────
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Restructure sidebar with grouped navigation",
      description:
        "Replace flat 15-item sidebar with grouped sections (Main, Projects, Work, Agents, Knowledge, Operations) and company icon rail.",
      type: "feature",
      status: "done",
      priority: "high",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "navigation"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Add company switching icon rail",
      description:
        "48px icon rail on left edge for switching between companies. Colored circles with first initial, accent ring on active.",
      type: "feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "multi-company"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Create unified Inbox page (Chat + Messages + Notifications)",
      description:
        "Tabbed page merging Board Chat and Messages. Add Notifications tab for system alerts and approval requests.",
      type: "feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "inbox"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Build project list and detail pages",
      description:
        "Project cards grid with status, agent count, issue counts. Detail page with Issues/Goals/Activity tabs scoped to project.",
      type: "feature",
      status: "done",
      priority: "high",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "projects"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Add framer-motion page transitions and card animations",
      description:
        "Fade+slide page transitions, card hover/tap animations, staggered list entrances, modal spring animations.",
      type: "feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: eng2Id,
      createdByAgentId: designerId,
      ...tn(),
      tags: ["ui", "animations"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Implement Cmd+K command palette",
      description:
        "Global search across pages, agents, and issues using cmdk library. Dark themed with accent highlights.",
      type: "feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "search"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Add toast notification system (sonner)",
      description:
        "Real-time toast notifications wired to WebSocket events: task changes, agent status, execution results, budget alerts.",
      type: "feature",
      status: "done",
      priority: "medium",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "notifications"],
      completedAt: daysAgo(0),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Build agent detail page with invoke/pause controls",
      description:
        "Agent profile with heartbeat status, execution history, performance charts, and manual invoke/pause buttons.",
      type: "feature",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "agents"],
      startedAt: daysAgo(1),
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Add live status indicators with pulsing animations",
      description:
        "Pulsing green dot for active agents, '1 live' badges, animated status transitions like Paperclip.",
      type: "feature",
      status: "todo",
      priority: "medium",
      assigneeAgentId: eng2Id,
      createdByAgentId: designerId,
      ...tn(),
      tags: ["ui", "status"],
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Build cost & budget dashboard in Analytics",
      description:
        "Detailed budget breakdown by agent, cost trends over time, spending forecasts, and threshold alerts.",
      type: "feature",
      status: "todo",
      priority: "medium",
      assigneeAgentId: eng2Id,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["ui", "analytics", "budget"],
    },
    {
      companyId,
      projectId: projDashboard,
      goalId: goalUX,
      title: "Implement dark/light theme toggle",
      description:
        "Full theming support with CSS custom properties. Persist preference in localStorage.",
      type: "feature",
      status: "backlog",
      priority: "low",
      assigneeAgentId: eng2Id,
      createdByAgentId: designerId,
      ...tn(),
      tags: ["ui", "theming"],
    },

    // ── Documentation & Community ──────────────────────────────────
    {
      companyId,
      projectId: projDocs,
      goalId: goalGrowth,
      title: "Write comprehensive README with quickstart guide",
      description:
        "Clear README with features table, quickstart commands, architecture diagram, tech stack, and API overview.",
      type: "feature",
      status: "done",
      priority: "high",
      assigneeAgentId: marketerId,
      createdByAgentId: ceoId,
      ...tn(),
      tags: ["docs", "readme"],
      completedAt: daysAgo(4),
    },
    {
      companyId,
      projectId: projDocs,
      goalId: goalGrowth,
      title: "Create API documentation site",
      description:
        "Auto-generated API reference from route files. Interactive examples, authentication guide, WebSocket events reference.",
      type: "feature",
      status: "todo",
      priority: "high",
      assigneeAgentId: marketerId,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["docs", "api"],
    },
    {
      companyId,
      projectId: projDocs,
      goalId: goalGrowth,
      title: "Write getting started tutorial",
      description:
        "Step-by-step tutorial: install, create company, hire agents, assign tasks, watch them work. Include screenshots.",
      type: "feature",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: marketerId,
      createdByAgentId: cpoId,
      ...tn(),
      tags: ["docs", "tutorial"],
    },
    {
      companyId,
      projectId: projDocs,
      goalId: goalGrowth,
      title: "Create demo video for landing page",
      description:
        "2-minute screen recording showing the full workflow: company setup, agent hiring, task execution, real-time dashboard.",
      type: "feature",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: marketerId,
      createdByAgentId: ceoId,
      ...tn(),
      tags: ["marketing", "video"],
    },

    // ── Infrastructure & DevOps ────────────────────────────────────
    {
      companyId,
      projectId: projInfra,
      goalId: goalTechFound,
      title: "Set up Docker compose for local development",
      description:
        "docker-compose.yml with app server, Vite dev server, and optional Postgres for production-like testing.",
      type: "feature",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["docker", "devops"],
    },
    {
      companyId,
      projectId: projInfra,
      goalId: goalTechFound,
      title: "Configure Litestream for SQLite backups",
      description:
        "Add Litestream sidecar for continuous WAL replication to S3. Test backup/restore cycle.",
      type: "feature",
      status: "backlog",
      priority: "high",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["backup", "production"],
    },
    {
      companyId,
      projectId: projInfra,
      goalId: goalTechFound,
      title: "Deploy to Fly.io with persistent volume",
      description:
        "Fly.io deployment config with persistent SQLite volume, health checks, and auto-restart.",
      type: "feature",
      status: "backlog",
      priority: "high",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["deployment", "fly.io"],
    },
    {
      companyId,
      projectId: projInfra,
      goalId: goalTechFound,
      title: "Add monitoring with Sentry error tracking",
      description:
        "Integrate Sentry for error tracking on both server and client. Add source maps for production builds.",
      type: "feature",
      status: "backlog",
      priority: "medium",
      assigneeAgentId: eng3Id,
      createdByAgentId: ctoId,
      ...tn(),
      tags: ["monitoring", "sentry"],
    },
  ] satisfies TaskInsert[];

  for (const task of allTasks) {
    db.insert(tasks).values(task).run();
  }

  // =========================================================================
  // Knowledge Documents — platform documentation
  // =========================================================================
  const knowledgeDocs = [
    {
      id: id(),
      companyId,
      title: "Eidolon Architecture Overview",
      content: `# Eidolon Architecture\n\nEidolon is built as a pnpm monorepo with four workspaces:\n\n- **packages/shared** — Zod schemas, TypeScript types, constants\n- **packages/db** — Drizzle ORM with SQLite, 26 table schemas, migrations\n- **server** — Express 5 API + WebSocket server, 22 route files, 13 services\n- **ui** — React 19 + Vite + Tailwind CSS v4 dashboard\n\n## Data Flow\n\n1. UI makes REST API calls to Express server\n2. Server queries SQLite via Drizzle ORM\n3. Mutations emit events via EventBus\n4. WebSocket server broadcasts events to subscribed clients\n5. React Query caches and auto-invalidates on WS events\n\n## Key Design Decisions\n\n- SQLite for zero-config embedded database (WAL mode for concurrency)\n- Drizzle ORM for type-safe queries without an ORM abstraction layer\n- Express 5 with async route handlers\n- WebSocket for real-time (not polling)\n- Tailwind CSS v4 with custom design tokens`,
      contentType: "markdown",
      source: "manual",
      tags: ["architecture", "technical"],
      metadata: {},
      chunkCount: 0,
      embeddingStatus: "pending",
    },
    {
      id: id(),
      companyId,
      title: "Agent Execution Model",
      content: `# Agent Execution Model\n\nAgents in Eidolon execute via a heartbeat-based system:\n\n## Heartbeat Triggers\n- **Timer**: Periodic execution (default: every 5 minutes)\n- **Manual**: User clicks "Invoke" in the dashboard\n- **Assignment**: New task assigned to agent\n- **Automation**: Rule-based triggers\n\n## Execution Flow\n1. Heartbeat fires for an agent\n2. Agent evaluates its pending tasks (sorted by priority)\n3. Highest-priority task is "checked out" (locked)\n4. Agent sends prompt to AI provider (Claude, GPT-4, etc.)\n5. Response is parsed, actions are executed\n6. Execution log is saved\n7. Task status is updated\n8. Cost is recorded\n\n## Adapters\nEach AI provider has an adapter that normalizes the API:\n- Anthropic (Claude) — primary\n- OpenAI (GPT-4, Codex)\n- Google (Gemini)\n- Local models (Ollama)`,
      contentType: "markdown",
      source: "manual",
      tags: ["agents", "execution", "technical"],
      metadata: {},
      chunkCount: 0,
      embeddingStatus: "pending",
    },
    {
      id: id(),
      companyId,
      title: "Competitive Analysis — Paperclip",
      content: `# Competitive Analysis: Paperclip\n\nPaperclip is the closest competitor — an autonomous agent orchestration platform.\n\n## Features We Must Match\n- Heartbeat-based agent execution ✅ (in progress)\n- Hierarchical agent organization ✅ (done)\n- Issue/task management with checkout semantics (in progress)\n- Multi-adapter support (Claude, Codex, Cursor, Gemini)\n- Approval workflows (planned)\n- Real-time WebSocket updates ✅ (done)\n- Cost tracking per agent ✅ (done)\n- Knowledge base ✅ (done)\n\n## Features We Can Do Better\n- Open-source (Paperclip is closed-source)\n- Project-centric organization (Paperclip is flat)\n- Modern dark UI with animations (Paperclip is utilitarian)\n- Command palette for global search\n- Toast notifications\n- Company templates for quick setup`,
      contentType: "markdown",
      source: "manual",
      tags: ["competitive-analysis", "strategy"],
      metadata: {},
      chunkCount: 0,
      embeddingStatus: "pending",
    },
  ];

  for (const doc of knowledgeDocs) {
    db.insert(knowledgeDocuments).values(doc).run();
  }

  // =========================================================================
  // Prompt Templates
  // =========================================================================
  db.insert(promptTemplates)
    .values([
      {
        id: id(),
        companyId,
        name: "Task Execution",
        description: "Standard prompt for agent task execution",
        category: "general",
        content:
          "You are {{agentName}}, a {{role}} at Eidolon.\n\nYour current task:\n**{{taskTitle}}**\n{{taskDescription}}\n\nPriority: {{priority}}\nProject: {{projectName}}\n\nComplete this task thoroughly. If you need clarification, ask. If the task is too large, break it into subtasks.",
        variables: [
          "agentName",
          "role",
          "taskTitle",
          "taskDescription",
          "priority",
          "projectName",
        ],
        version: 1,
        isGlobal: 0,
        usageCount: 12,
      },
      {
        id: id(),
        companyId,
        name: "Code Review",
        description: "Prompt for code review tasks",
        category: "engineering",
        content:
          "Review the following code changes for:\n1. Correctness — does it do what it claims?\n2. Security — any vulnerabilities?\n3. Performance — any bottlenecks?\n4. Style — consistent with project conventions?\n\n{{codeChanges}}\n\nProvide specific, actionable feedback.",
        variables: ["codeChanges"],
        version: 1,
        isGlobal: 1,
        usageCount: 5,
      },
    ])
    .run();

  // =========================================================================
  // Messages — sample inter-agent communication
  // =========================================================================
  const threadId = id();
  db.insert(messages)
    .values([
      {
        id: id(),
        companyId,
        fromAgentId: ctoId,
        toAgentId: eng1Id,
        threadId,
        type: "directive",
        subject: "Heartbeat execution engine — top priority",
        content:
          "Bolt, the heartbeat execution engine is our top priority. Start with the core loop — timer-triggered heartbeats that evaluate pending tasks and execute the highest priority one.",
        metadata: {},
        createdAt: daysAgo(2),
      },
      {
        id: id(),
        companyId,
        fromAgentId: eng1Id,
        toAgentId: ctoId,
        threadId,
        type: "question",
        subject: "Re: Heartbeat execution engine",
        content:
          "On it. I'll build the HeartbeatScheduler first, then the execution pipeline. Should I include the Claude adapter in the first pass, or keep it adapter-agnostic?",
        metadata: {},
        createdAt: daysAgo(2),
      },
      {
        id: id(),
        companyId,
        fromAgentId: ctoId,
        toAgentId: eng1Id,
        threadId,
        type: "response",
        subject: "Re: Heartbeat execution engine",
        content:
          "Build it adapter-agnostic with a clean interface, then implement the Claude adapter first. We'll add OpenAI and Gemini adapters after.",
        metadata: {},
        createdAt: daysAgo(1),
      },
    ])
    .run();

  // =========================================================================
  // Summary
  // =========================================================================
  const doneCount = allTasks.filter((t) => t.status === "done").length;
  const inProgressCount = allTasks.filter(
    (t) => t.status === "in_progress",
  ).length;
  const todoCount = allTasks.filter((t) => t.status === "todo").length;
  const backlogCount = allTasks.filter((t) => t.status === "backlog").length;

  console.log("Seed complete:");
  console.log(`  - 1 company (Eidolon)`);
  console.log(`  - ${projectRows.length} projects`);
  console.log(
    `  - ${agentRows.length} agents (CEO, CTO, CPO, 3 engineers, designer, marketer)`,
  );
  console.log(`  - ${5} goals (1 company-level, 4 department-level)`);
  console.log(
    `  - ${allTasks.length} issues (${doneCount} done, ${inProgressCount} in progress, ${todoCount} todo, ${backlogCount} backlog)`,
  );
  console.log(`  - ${knowledgeDocs.length} knowledge documents`);
  console.log(`  - 2 prompt templates`);
  console.log(`  - 3 messages (1 thread)`);

  connection.close();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
