import { randomUUID } from 'node:crypto';
import { createDb } from './index.js';
import { companies } from './schema/companies.js';
import { agents } from './schema/agents.js';
import { goals } from './schema/goals.js';
import { tasks } from './schema/tasks.js';
import { projects } from './schema/projects.js';

async function seed() {
  const { db, connection } = createDb();

  console.log('Seeding database...');

  // -----------------------------------------------------------------------
  // Company
  // -----------------------------------------------------------------------
  const companyId = randomUUID();

  db.insert(companies)
    .values({
      id: companyId,
      name: 'Eidolon Demo Corp',
      description:
        'A demonstration AI-powered company showcasing autonomous agent collaboration.',
      mission:
        'Build the future of autonomous software development through intelligent agent orchestration.',
      status: 'active',
      budgetMonthlyCents: 500_00, // $500/month
      spentMonthlyCents: 0,
      settings: { timezone: 'America/New_York', language: 'en' },
      brandColor: '#6366F1',
    })
    .run();

  // -----------------------------------------------------------------------
  // Project
  // -----------------------------------------------------------------------
  const projectId = randomUUID();

  db.insert(projects)
    .values({
      id: projectId,
      companyId,
      name: 'Eidolon Platform MVP',
      description:
        'Minimum viable product for the Eidolon AI Company Runtime platform.',
      status: 'active',
      repoUrl: 'https://github.com/eidolon-corp/eidolon-platform',
    })
    .run();

  // -----------------------------------------------------------------------
  // Agents
  // -----------------------------------------------------------------------
  const ceoId = randomUUID();
  const ctoId = randomUUID();
  const eng1Id = randomUUID();
  const eng2Id = randomUUID();
  const marketerId = randomUUID();

  const agentRows = [
    {
      id: ceoId,
      companyId,
      name: 'Atlas',
      role: 'ceo' as const,
      title: 'Chief Executive Officer',
      provider: 'anthropic' as const,
      model: 'claude-opus-4-6',
      status: 'idle' as const,
      reportsTo: null,
      capabilities: ['strategic-planning', 'delegation', 'budget-management', 'reporting'],
      systemPrompt:
        'You are Atlas, the CEO of Eidolon Demo Corp. You set strategic direction, delegate work to department heads, and ensure the company stays on mission.',
      budgetMonthlyCents: 100_00,
      spentMonthlyCents: 0,
      permissions: ['company:read', 'company:write', 'agents:manage', 'tasks:manage', 'goals:manage'],
    },
    {
      id: ctoId,
      companyId,
      name: 'Nova',
      role: 'cto' as const,
      title: 'Chief Technology Officer',
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-6',
      status: 'idle' as const,
      reportsTo: ceoId,
      capabilities: ['architecture', 'code-review', 'technical-planning', 'mentoring'],
      systemPrompt:
        'You are Nova, the CTO of Eidolon Demo Corp. You design system architecture, review technical decisions, and lead the engineering team.',
      budgetMonthlyCents: 100_00,
      spentMonthlyCents: 0,
      permissions: ['tasks:manage', 'agents:read', 'goals:read', 'goals:write'],
    },
    {
      id: eng1Id,
      companyId,
      name: 'Bolt',
      role: 'engineer' as const,
      title: 'Senior Backend Engineer',
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-6',
      status: 'idle' as const,
      reportsTo: ctoId,
      capabilities: ['backend-development', 'database-design', 'api-design', 'testing'],
      systemPrompt:
        'You are Bolt, a senior backend engineer at Eidolon Demo Corp. You implement server-side features, design database schemas, and write robust tests.',
      budgetMonthlyCents: 100_00,
      spentMonthlyCents: 0,
      permissions: ['tasks:read', 'tasks:write', 'goals:read'],
    },
    {
      id: eng2Id,
      companyId,
      name: 'Pixel',
      role: 'engineer' as const,
      title: 'Senior Frontend Engineer',
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-6',
      status: 'idle' as const,
      reportsTo: ctoId,
      capabilities: ['frontend-development', 'ui-design', 'accessibility', 'performance'],
      systemPrompt:
        'You are Pixel, a senior frontend engineer at Eidolon Demo Corp. You build responsive UIs, ensure accessibility, and optimize client-side performance.',
      budgetMonthlyCents: 100_00,
      spentMonthlyCents: 0,
      permissions: ['tasks:read', 'tasks:write', 'goals:read'],
    },
    {
      id: marketerId,
      companyId,
      name: 'Echo',
      role: 'marketer' as const,
      title: 'Head of Marketing',
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-6',
      status: 'idle' as const,
      reportsTo: ceoId,
      capabilities: ['content-creation', 'seo', 'analytics', 'social-media'],
      systemPrompt:
        'You are Echo, the Head of Marketing at Eidolon Demo Corp. You craft compelling narratives, drive user acquisition, and analyze market trends.',
      budgetMonthlyCents: 100_00,
      spentMonthlyCents: 0,
      permissions: ['tasks:read', 'tasks:write', 'goals:read'],
    },
  ];

  for (const agent of agentRows) {
    db.insert(agents).values(agent).run();
  }

  // -----------------------------------------------------------------------
  // Goals
  // -----------------------------------------------------------------------
  const goal1Id = randomUUID();
  const goal2Id = randomUUID();

  db.insert(goals)
    .values([
      {
        id: goal1Id,
        companyId,
        title: 'Launch MVP by end of Q2',
        description:
          'Ship a working MVP of the Eidolon platform with core agent orchestration, task management, and a real-time dashboard.',
        level: 'company',
        status: 'active',
        ownerAgentId: ceoId,
        progress: 15,
        targetDate: new Date('2026-06-30'),
        metrics: {
          targetFeatures: 12,
          completedFeatures: 2,
          targetUsers: 50,
        },
      },
      {
        id: goal2Id,
        companyId,
        title: 'Establish technical foundation',
        description:
          'Set up the monorepo, database layer, API server, and CI/CD pipeline.',
        level: 'department',
        status: 'active',
        parentId: goal1Id,
        ownerAgentId: ctoId,
        progress: 40,
        targetDate: new Date('2026-05-15'),
        metrics: {
          targetMilestones: 5,
          completedMilestones: 2,
        },
      },
    ])
    .run();

  // -----------------------------------------------------------------------
  // Tasks
  // -----------------------------------------------------------------------
  db.insert(tasks)
    .values([
      {
        companyId,
        projectId,
        goalId: goal2Id,
        title: 'Design and implement database schema',
        description:
          'Create the Drizzle ORM schema for all core entities including companies, agents, tasks, goals, and messages.',
        type: 'feature',
        status: 'done',
        priority: 'high',
        assigneeAgentId: eng1Id,
        createdByAgentId: ctoId,
        taskNumber: 1,
        identifier: 'NXS-1',
        tags: ['database', 'backend', 'foundation'],
        completedAt: new Date(),
      },
      {
        companyId,
        projectId,
        goalId: goal2Id,
        title: 'Build REST API for task management',
        description:
          'Implement CRUD endpoints for tasks with proper validation, authorization, and error handling.',
        type: 'feature',
        status: 'in_progress',
        priority: 'high',
        assigneeAgentId: eng1Id,
        createdByAgentId: ctoId,
        taskNumber: 2,
        identifier: 'NXS-2',
        tags: ['api', 'backend', 'tasks'],
        startedAt: new Date(),
      },
      {
        companyId,
        projectId,
        goalId: goal2Id,
        title: 'Create real-time dashboard UI',
        description:
          'Build a React dashboard showing company status, agent activity, task progress, and budget consumption in real-time.',
        type: 'feature',
        status: 'todo',
        priority: 'medium',
        assigneeAgentId: eng2Id,
        createdByAgentId: ctoId,
        taskNumber: 3,
        identifier: 'NXS-3',
        tags: ['frontend', 'dashboard', 'ui'],
      },
      {
        companyId,
        projectId,
        goalId: goal1Id,
        title: 'Write launch blog post and documentation',
        description:
          'Create a compelling blog post announcing the MVP and comprehensive documentation for early adopters.',
        type: 'feature',
        status: 'backlog',
        priority: 'low',
        assigneeAgentId: marketerId,
        createdByAgentId: ceoId,
        taskNumber: 4,
        identifier: 'NXS-4',
        tags: ['marketing', 'docs', 'launch'],
      },
    ])
    .run();

  console.log('Seed complete:');
  console.log('  - 1 company');
  console.log('  - 1 project');
  console.log('  - 5 agents (CEO, CTO, 2 engineers, 1 marketer)');
  console.log('  - 2 goals');
  console.log('  - 4 tasks');

  connection.close();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
