import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './utils/logger.js';
import { notFound, errorHandler } from './middleware/error-handler.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createServiceTokenMiddleware } from './middleware/service-tokens.js';
import { apiRateLimit, authSensitiveRateLimit } from './middleware/rate-limit.js';
import { originCsrf } from './middleware/csrf.js';
import healthRouter from './routes/health.js';
import { companiesRouter } from './routes/companies.js';
import { agentsRouter, orgChartRouter } from './routes/agents.js';
import { tasksRouter } from './routes/tasks.js';
import { goalsRouter } from './routes/goals.js';
import { messagesRouter } from './routes/messages.js';
import { budgetsRouter } from './routes/budgets.js';
import { analyticsRouter } from './routes/analytics.js';
import { workflowsRouter } from './routes/workflows.js';
import { activityRouter } from './routes/activity.js';
import { secretsRouter } from './routes/secrets.js';
import { chatRouter } from './routes/chat.js';
import { webhookManagementRouter, webhookTriggerRouter } from './routes/webhooks.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { filesRouter, agentFilesRouter } from './routes/files.js';
import { integrationsRouter } from './routes/integrations.js';
import { memoriesRouter } from './routes/memories.js';
import { globalPromptsRouter, companyPromptsRouter } from './routes/prompts.js';
import { mcpRouter } from './routes/mcp.js';
import { evaluationsRouter } from './routes/evaluations.js';
import { collaborationsRouter, agentCollaborationsRouter } from './routes/collaborations.js';
import { templatesRouter, companyExportRouter } from './routes/templates.js';
import { projectsRouter } from './routes/projects.js';
import { projectThreadsRouter } from './routes/project-threads.js';
import { projectPlansRouter } from './routes/project-plans.js';
import { projectDecisionsRouter } from './routes/project-decisions.js';
import { projectOutcomesRouter } from './routes/project-outcomes.js';
import { adaptersRouter } from './routes/adapters.js';
import { approvalsRouter } from './routes/approvals.js';
import { inboxRouter } from './routes/inbox.js';
import { environmentsRouter } from './routes/environments.js';
import { runtimeRouter } from './routes/runtime.js';
import { runtimeAdaptersRouter } from './routes/runtime-adapters.js';
import { sessionsRouter } from './routes/sessions.js';
import { skillsRouter } from './routes/skills.js';
import { routinesRouter } from './routes/routines.js';
import { automationsRouter } from './routes/automations.js';
import { artifactsRouter } from './routes/artifacts.js';
import { meetingsRouter, meetingItemRouter } from './routes/meetings.js';
import { foldersRouter } from './routes/folders.js';
import { workspaceTemplatesRouter } from './routes/workspace-templates.js';
import { teamsRouter } from './routes/teams.js';
import { permissionsRouter } from './routes/permissions.js';
import { presenceRouter } from './routes/presence.js';
import { mentionsRouter } from './routes/mentions.js';
import { searchRouter } from './routes/search.js';
import { localTrustedAuthRouter } from './routes/local-trusted-auth.js';
import { mfaRouter, stepUpRouter } from './routes/mfa.js';
import { securityMembersRouter } from './routes/security-members.js';
import { securityAdminRouter } from './routes/security-admin.js';
import {
  metricsRouter,
  requestIdMiddleware,
  requestMetricsMiddleware,
} from './middleware/observability.js';
import { initializeErrorTracking } from './utils/error-tracking.js';
import type { DbInstance } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db: DbInstance): express.Express {
  const app = express();
  initializeErrorTracking();
  const { requireAuth, requireOrgMember } = createAuthMiddleware({ db });
  const { requireServiceOrOrgMember, requireServiceScope } = createServiceTokenMiddleware({
    requireAuth,
    requireOrgMember,
  });

  // Vercel overwrites forwarded IP headers before invoking the function.
  // Trust only that single proxy hop; direct/self-hosted deployments stay untrusted.
  if (process.env.VERCEL === '1') {app.set('trust proxy', 1);}

  // ---------------------------------------------------------------------------
  // CORS (must come before everything so preflight OPTIONS work)
  // ---------------------------------------------------------------------------

  const isDev = process.env.NODE_ENV !== 'production';
  app.use(
    cors(
      isDev
        ? { origin: true, credentials: true }
        : {
            origin: process.env.CORS_ORIGIN?.split(',') ?? [],
            credentials: true,
          },
    ),
  );

  // ---------------------------------------------------------------------------
  // Global middleware (auth sessions are Clerk cookies; no handshake to mount)
  // ---------------------------------------------------------------------------

  // Parse JSON bodies (Express 5 built-in)
  app.use(express.json({ limit: '2mb' }));

  // Correlate responses and metrics with a bounded request identifier.
  app.use(requestIdMiddleware);
  app.use(requestMetricsMiddleware);

  // Broad rate-limit for everything under /api (skipped in test + local_trusted)
  app.use('/api', apiRateLimit);

  // Origin-based CSRF defense on state-changing requests (skipped in test,
  // local_trusted, and on auth/webhook/health paths that authenticate
  // independently).
  app.use('/api', originCsrf);

  // Request logging
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => {
          // Don't log health checks in production
          return (req as any).url === '/api/health';
        },
      },
      customProps: (req) => ({
        requestId: (req as any).requestId,
        traceId: (req as any).traceId,
      }),
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // API routes
  // ---------------------------------------------------------------------------

  // Public endpoints (no auth required)
  app.use('/api', healthRouter);
  app.use('/api', metricsRouter());

  // Local-trusted test user creation (guarded to AUTH_MODE=local_trusted
  // inside the route handler; returns 404 otherwise). Available without
  // auth so validators can create test users programmatically.
  // VAL-SEC-009: the session-creation endpoint (login-like) is rate-limited.
  app.use('/api/auth/local-trusted/create-session', authSensitiveRateLimit);
  app.use('/api/auth/local-trusted', localTrustedAuthRouter(db));

  // MFA + step-up authentication (M8). User-scoped (requireAuth only, not
  // company-scoped) — MFA protects the user identity across companies.
  // VAL-SEC-009: MFA verify + step-up re-auth are brute-force surfaces and
  // carry a strict always-on rate limiter (bypassed in tests via
  // EIDOLON_RATE_LIMIT_TEST_BYPASS).
  app.use('/api/auth/mfa/verify', authSensitiveRateLimit);
  app.use('/api/auth/step-up', authSensitiveRateLimit);
  app.use('/api/auth/mfa', requireAuth, mfaRouter(db));
  app.use('/api/auth/step-up', requireAuth, stepUpRouter(db));

  // Security admin (M8): encryption key rotation + posture. Platform-admin
  // gated (VAL-SEC-010). requireAuth ensures a user is present; the handler
  // enforces the admin role.
  app.use('/api/admin', requireAuth, securityAdminRouter(db));

  // Adapter registry introspection (public read; no secrets leaked)
  app.use('/api/adapters', adaptersRouter());
  app.use('/api/runtime', runtimeAdaptersRouter());

  // Inbound webhook trigger (public endpoint - validated via webhook secret)
  app.use('/api/webhooks', webhookTriggerRouter(db));

  // Company Templates (public read, auth for write)
  app.use('/api/templates', templatesRouter(db, requireAuth));

  // Global prompts (public read)
  app.use('/api/prompts', globalPromptsRouter(db));

  // ---------------------------------------------------------------------------
  // Authenticated routes
  // ---------------------------------------------------------------------------

  // Prompt service auth must run before the broad company-session gate.
  app.use(
    '/api/companies/:companyId/prompts',
    requireServiceOrOrgMember('prompts:read'),
    companyPromptsRouter(db, requireServiceScope('prompts:write')),
  );

  app.use('/api/companies', requireAuth, companiesRouter(db));

  // Company-scoped routes (require auth + org membership)
  app.use('/api/companies/:companyId/agents', requireAuth, requireOrgMember(), agentsRouter(db));
  app.use(
    '/api/companies/:companyId/org-chart',
    requireAuth,
    requireOrgMember(),
    orgChartRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects',
    requireAuth,
    requireOrgMember(),
    projectsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/threads',
    requireAuth,
    requireOrgMember(),
    projectThreadsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/meetings',
    requireAuth,
    requireOrgMember(),
    meetingsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/plans',
    requireAuth,
    requireOrgMember(),
    projectPlansRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/decisions',
    requireAuth,
    requireOrgMember(),
    projectDecisionsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/outcomes',
    requireAuth,
    requireOrgMember(),
    projectOutcomesRouter(db),
  );
  app.use('/api/companies/:companyId/tasks', requireAuth, requireOrgMember(), tasksRouter(db));
  app.use('/api/companies/:companyId/goals', requireAuth, requireOrgMember(), goalsRouter(db));
  app.use(
    '/api/companies/:companyId/messages',
    requireAuth,
    requireOrgMember(),
    messagesRouter(db),
  );
  app.use(
    '/api/companies/:companyId/analytics',
    requireAuth,
    requireOrgMember(),
    analyticsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/workflows',
    requireAuth,
    requireOrgMember(),
    workflowsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/activity',
    requireAuth,
    requireOrgMember(),
    activityRouter(db),
  );
  app.use(
    '/api/companies/:companyId/secrets',
    requireAuth,
    requireOrgMember('admin'),
    secretsRouter(db),
  );
  app.use('/api/companies/:companyId/chat', requireAuth, requireOrgMember(), chatRouter(db));

  // Knowledge base
  app.use(
    '/api/companies/:companyId/knowledge',
    requireAuth,
    requireOrgMember(),
    knowledgeRouter(db),
  );

  // File manager
  app.use('/api/companies/:companyId/files', requireAuth, requireOrgMember(), filesRouter(db));
  app.use(
    '/api/companies/:companyId/agents/:agentId/files',
    requireAuth,
    requireOrgMember(),
    agentFilesRouter(db),
  );

  // Integrations
  app.use(
    '/api/companies/:companyId/integrations',
    requireAuth,
    requireOrgMember('admin'),
    integrationsRouter(db),
  );

  // Agent memories
  app.use(
    '/api/companies/:companyId/agents/:agentId/memories',
    requireAuth,
    requireOrgMember(),
    memoriesRouter(db),
  );

  // Agent evaluations & performance
  app.use(
    '/api/companies/:companyId/evaluations',
    requireAuth,
    requireOrgMember(),
    evaluationsRouter(db),
  );

  // MCP (Model Context Protocol) servers and tools
  app.use('/api/companies/:companyId/mcp', requireAuth, requireOrgMember('admin'), mcpRouter(db));

  // Webhook management (admin only)
  app.use(
    '/api/companies/:companyId/webhooks',
    requireAuth,
    requireOrgMember('admin'),
    webhookManagementRouter(db),
  );

  // Agent Collaboration Protocol
  app.use(
    '/api/companies/:companyId/collaborations',
    requireAuth,
    requireOrgMember(),
    collaborationsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/agents/:agentId/collaborations',
    requireAuth,
    requireOrgMember(),
    agentCollaborationsRouter(db),
  );

  // Company export (admin only)
  app.use(
    '/api/companies/:companyId/export',
    requireAuth,
    requireOrgMember('admin'),
    companyExportRouter(db),
  );

  // Approvals (any org member can create/comment; decide requires admin+)
  app.use(
    '/api/companies/:companyId/approvals',
    requireAuth,
    requireOrgMember(),
    approvalsRouter(db),
  );

  // Unified inbox feed
  app.use('/api/companies/:companyId/inbox', requireAuth, requireOrgMember(), inboxRouter(db));

  // Mention search (company-scoped agents + teammates for the picker)
  app.use(
    '/api/companies/:companyId/mentions',
    requireAuth,
    requireOrgMember(),
    mentionsRouter(db),
  );

  // Cross-artifact search (M1): FTS over artifacts + ILIKE on thread items +
  // tasks. Company-scoped. Mounted before the bare-path composite so the
  // /search path is intercepted here, not by the artifacts sub-router.
  app.use('/api/companies/:companyId/search', requireAuth, requireOrgMember(), searchRouter(db));

  // Company runtime snapshot
  app.use('/api/companies/:companyId/runtime', requireAuth, requireOrgMember(), runtimeRouter(db));

  // Durable runtime sessions, skills, and routines
  app.use(
    '/api/companies/:companyId/sessions',
    requireAuth,
    requireOrgMember('admin'),
    sessionsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/skills',
    requireAuth,
    requireOrgMember('admin'),
    skillsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/routines',
    requireAuth,
    requireOrgMember(),
    routinesRouter(db),
  );

  // Unified automations surface (aggregates routines, workflows, webhooks)
  app.use(
    '/api/companies/:companyId/automations',
    requireAuth,
    requireOrgMember(),
    automationsRouter(db),
  );

  // Meetings (M7): single-meeting operations (get/patch/transcript/summarize/
  // action-items/tasks/delete/archive). Mounted at the company level so a
  // meeting can be addressed by id regardless of whether it is project-scoped.
  app.use(
    '/api/companies/:companyId/meetings',
    requireAuth,
    requireOrgMember(),
    meetingItemRouter(db),
  );

  // Local execution environments
  app.use(
    '/api/companies/:companyId/environments',
    requireAuth,
    requireOrgMember('admin'),
    environmentsRouter(db),
  );

  // ---------------------------------------------------------------------------
  // Company-scoped bare-path routers (MOUNTED LAST among company routes).
  //
  // These sub-routers all live directly under `/api/companies/:companyId`
  // (their routes are `/artifacts`, `/costs`, `/folders`, `/teams`, etc.).
  // They are mounted as a SINGLE composite router so the `:companyId` path
  // param is captured exactly once per request by one mount layer and
  // propagated deterministically to every nested sub-router via
  // `mergeParams`.
  //
  // The previous structure mounted eight separate routers at the same
  // parameterized path `/api/companies/:companyId`, creating eight
  // independent param-capture layers. Under Express 5 / path-to-regexp v8
  // that multi-mount structure could intermittently drop the `:id` param
  // for `GET /api/companies/:companyId/artifacts/:id` on the tsx-watch dev
  // server: the artifacts list endpoint worked, but the single-artifact
  // detail GET intermittently returned 404 (ARTIFACT_NOT_FOUND) because the
  // `:id` param arrived empty at the handler, while the test server
  // (createTestServer + supertest) and the artifact suite stayed green.
  // One mount → one param capture → consistent `:id` propagation.
  // (misc-devserver-artifact-route tech debt.)
  //
  // This composite is mounted AFTER every more-specific company route
  // (meetings, environments, etc.) so those specific mounts intercept their
  // own paths before any bare-path sub-router runs — and, critically, before
  // the securityMembers admin guard below. This preserves the prior
  // ordering where securityMembersRouter was the final bare mount.
  // ---------------------------------------------------------------------------
  const companyScopedRouter = express.Router({ mergeParams: true });
  companyScopedRouter.use(budgetsRouter(db));
  companyScopedRouter.use(artifactsRouter(db));
  companyScopedRouter.use(foldersRouter(db));
  companyScopedRouter.use(workspaceTemplatesRouter(db));
  companyScopedRouter.use(teamsRouter(db));
  companyScopedRouter.use(permissionsRouter(db));
  companyScopedRouter.use(presenceRouter(db));
  // Company member role/removal is admin/owner only. The handler also
  // enforces requireAdminOrOwner internally (defense in depth); the
  // mount-level guard here rejects non-admins before the handler runs,
  // matching the prior `requireOrgMember('admin')` mount behavior. Because
  // the composite is the last company mount, this guard only runs for
  // requests that did not match any more-specific company route.
  companyScopedRouter.use(requireOrgMember('admin'), securityMembersRouter(db));
  app.use('/api/companies/:companyId', requireAuth, requireOrgMember(), companyScopedRouter);

  // ---------------------------------------------------------------------------
  // Static file serving for production UI (legacy single-host deploys).
  // Skipped when EIDOLON_SKIP_STATIC=1 (set by the Vercel Function entry —
  // Vercel serves the built UI from its own static layer, and Express 5's
  // path-to-regexp rejects the bare '*' wildcard pattern anyway).
  // ---------------------------------------------------------------------------

  if (!isDev && process.env.EIDOLON_SKIP_STATIC !== '1') {
    const uiDistPath = path.resolve(__dirname, '../../ui/dist');
    app.use(express.static(uiDistPath));
    // Named splat required by Express 5 / path-to-regexp v8.
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(uiDistPath, 'index.html'));
    });
  }

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
