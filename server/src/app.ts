import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger, { requestSerializer } from './utils/logger.js';
import { notFound, errorHandler } from './middleware/error-handler.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentKeyMiddleware } from './middleware/agent-key-auth.js';
import { createServiceTokenMiddleware, parseServiceTokens } from './middleware/service-tokens.js';
import { apiRateLimit, authSensitiveRateLimit } from './middleware/rate-limit.js';
import { originCsrf } from './middleware/csrf.js';
import healthRouter, { readinessRouter } from './routes/health.js';
import { companiesRouter } from './routes/companies.js';
import { agentsRouter, orgChartRouter } from './routes/agents.js';
import { tasksRouter } from './routes/tasks.js';
import { goalsRouter } from './routes/goals.js';
import { messagesRouter } from './routes/messages.js';
import { budgetsRouter } from './routes/budgets.js';
import { analyticsRouter } from './routes/analytics.js';
import { privacyRouter } from './routes/privacy.js';
import { featureFlagsRouter } from './routes/feature-flags.js';
import { workflowsRouter } from './routes/workflows.js';
import { activityRouter } from './routes/activity.js';
import { secretsRouter } from './routes/secrets.js';
import { chatRouter } from './routes/chat.js';
import { webhookManagementRouter, webhookTriggerRouter } from './routes/webhooks.js';
import { knowledgeRouter, knowledgeSearchRouter } from './routes/knowledge.js';
import { filesRouter, agentFilesRouter } from './routes/files.js';
import { integrationsRouter } from './routes/integrations.js';
import { memoriesRecallRouter, memoriesRouter } from './routes/memories.js';
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
import { securityAdminRouter } from './routes/security-admin.js';
import { membersRouter, transferOwnershipRouter } from './routes/members.js';
import { invitationsRouter } from './routes/invitations.js';
import { agentApiKeysRouter } from './routes/agent-api-keys.js';
import { clerkWebhookRouter } from './routes/clerk-webhook.js';
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
  const { requireAuth, requireOrgMember, requirePermission, requirePermissionByMethod } =
    createAuthMiddleware({ db });
  // Parse service tokens once and share with both agent-key and service-token
  // middleware so that legacy service tokens using the eid_live_ prefix are
  // not intercepted as unknown agent keys.
  const serviceTokens = parseServiceTokens();
  const { tryAgentKeyAuth } = createAgentKeyMiddleware({ db, serviceTokens });
  const { requireServiceOrOrgMember, requireServiceScope } = createServiceTokenMiddleware({
    requireAuth,
    requireOrgMember,
    tokens: serviceTokens,
  });

  // Vercel overwrites forwarded IP headers before invoking the function.
  // Trust only that single proxy hop; direct/self-hosted deployments stay untrusted.
  if (process.env.VERCEL === '1') {
    app.set('trust proxy', 1);
  }

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

  // Parse JSON bodies (Express 5 built-in).
  // The verify callback captures the raw body for Clerk webhook signature
  // verification — verifyWebhook needs the original bytes, not re-serialized
  // JSON. Only stored for the /api/webhooks/clerk path to limit overhead.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        if ((req as any).originalUrl?.startsWith('/api/webhooks/clerk')) {
          (req as any).rawBody = buf.toString('utf8');
        }
      },
    }),
  );

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
          // Don't log liveness or readiness probes: both are polled on a short
          // interval by load balancers and the desktop companion, and would
          // otherwise dominate the log volume.
          const url = (req as any).url;
          return url === '/api/health' || url === '/api/ready';
        },
      },
      customProps: (req) => ({
        requestId: (req as any).requestId,
        traceId: (req as any).traceId,
      }),
      serializers: {
        req: requestSerializer,
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
  app.use('/api', readinessRouter(db));
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

  // Agent API key auth — intercepts Bearer tokens starting with `eid_live_`
  // before any company-scoped route. If an agent key matches, it sets
  // req.user and req.organizationMembership so downstream requireAuth skips
  // normal auth and requirePermission reuses the pre-set membership.
  // Mounted before all company routes. Service tokens (including legacy
  // tokens that use the eid_live_ prefix) are skipped via a hash check so
  // they fall through to the service-token middleware on the prompts route.
  app.use('/api/companies/:companyId', tryAgentKeyAuth);

  // Prompt service auth must run before the broad company-session gate.
  app.use(
    '/api/companies/:companyId/prompts',
    requireServiceOrOrgMember('prompts:read'),
    companyPromptsRouter(db, requireServiceScope('prompts:write')),
  );

  app.use('/api/companies', requireAuth, companiesRouter(db));

  // Company-scoped routes (require auth + org membership)
  // Company-scoped routes (require auth + permission-based access control)
  //
  // Route migration: all company-scoped route mounts have been migrated from
  // requireOrgMember('admin'/'member') to requirePermission('specific.permission')
  // per the RBAC permission matrix in architecture.md.
  //
  // Admin-level routes (secrets, integrations, mcp, webhooks mgmt, export,
  // sessions, skills, environments, security members) use their corresponding
  // *.manage permission (owner+admin only).
  //
  // Member-level routes with specific write permissions (agents, projects,
  // tasks, chat, artifacts) use requirePermissionByMethod: company.view for
  // reads (all roles including viewer) and the resource-specific permission
  // for writes (owner+admin+member, not viewer).
  //
  // Member-level routes without specific write permissions use
  // requirePermission('company.view') for all methods. Individual handlers
  // may enforce additional role checks internally (e.g. teams router checks
  // requireAdminRole for team creation/deletion).

  // Agent memory recall accepts a POST body but is read-only.
  // Mount before the broader agents route so its read permission wins.
  app.use(
    '/api/companies/:companyId/agents/:agentId/memories/recall',
    requireAuth,
    requirePermission('company.view'),
    memoriesRecallRouter(db),
  );
  app.use(
    '/api/companies/:companyId/agents',
    requireAuth,
    requirePermissionByMethod({ read: 'company.view', write: 'agent.manage' }),
    agentsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/org-chart',
    requireAuth,
    requirePermission('company.view'),
    orgChartRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects',
    requireAuth,
    requirePermissionByMethod({ read: 'company.view', write: 'project.create' }),
    projectsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/threads',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    projectThreadsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/meetings',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    meetingsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/plans',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    projectPlansRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/decisions',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    projectDecisionsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/projects/:projectId/outcomes',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    projectOutcomesRouter(db),
  );
  app.use(
    '/api/companies/:companyId/tasks',
    requireAuth,
    requirePermissionByMethod({ read: 'company.view', write: 'task.create' }),
    tasksRouter(db),
  );
  app.use(
    '/api/companies/:companyId/goals',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    goalsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/messages',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    messagesRouter(db),
  );
  app.use(
    '/api/companies/:companyId/analytics',
    requireAuth,
    requirePermission('company.view'),
    analyticsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/privacy',
    requireAuth,
    requirePermission('privacy.manage'),
    privacyRouter(db),
  );
  app.use(
    '/api/companies/:companyId/flags',
    requireAuth,
    requirePermission('company.view'),
    featureFlagsRouter(),
  );
  app.use(
    '/api/companies/:companyId/workflows',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    workflowsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/activity',
    requireAuth,
    requirePermission('company.view'),
    activityRouter(db),
  );
  app.use(
    '/api/companies/:companyId/secrets',
    requireAuth,
    requirePermission('secrets.manage'),
    secretsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/chat',
    requireAuth,
    requirePermissionByMethod({ read: 'company.view', write: 'chat.participate' }),
    chatRouter(db),
  );

  // Knowledge base
  app.use(
    '/api/companies/:companyId/knowledge/search',
    requireAuth,
    requirePermission('company.view'),
    knowledgeSearchRouter(db),
  );
  app.use(
    '/api/companies/:companyId/knowledge',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'artifact.create',
      update: 'artifact.update',
      delete: 'artifact.delete',
    }),
    knowledgeRouter(db),
  );

  // File manager
  app.use(
    '/api/companies/:companyId/files',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'artifact.create',
      update: 'artifact.update',
      delete: 'artifact.delete',
    }),
    filesRouter(db),
  );
  app.use(
    '/api/companies/:companyId/agents/:agentId/files',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'artifact.create',
      update: 'artifact.update',
      delete: 'artifact.delete',
    }),
    agentFilesRouter(db),
  );

  // Integrations (admin only)
  app.use(
    '/api/companies/:companyId/integrations',
    requireAuth,
    requirePermission('integrations.manage'),
    integrationsRouter(db),
  );

  // Agent memories
  app.use(
    '/api/companies/:companyId/agents/:agentId/memories',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'artifact.create',
      update: 'artifact.update',
      delete: 'artifact.delete',
    }),
    memoriesRouter(db),
  );

  // Agent evaluations & performance
  app.use(
    '/api/companies/:companyId/evaluations',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    evaluationsRouter(db),
  );

  // MCP (Model Context Protocol) servers and tools (admin only)
  app.use(
    '/api/companies/:companyId/mcp',
    requireAuth,
    requirePermission('mcp.manage'),
    mcpRouter(db),
  );

  // Webhook management (admin only)
  app.use(
    '/api/companies/:companyId/webhooks',
    requireAuth,
    requirePermission('webhooks.manage'),
    webhookManagementRouter(db),
  );

  // Agent Collaboration Protocol
  app.use(
    '/api/companies/:companyId/collaborations',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    collaborationsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/agents/:agentId/collaborations',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    agentCollaborationsRouter(db),
  );

  // Company export (admin only)
  app.use(
    '/api/companies/:companyId/export',
    requireAuth,
    requirePermission('company.export'),
    companyExportRouter(db),
  );

  // Approvals (any org member can create/comment; decide requires admin+)
  app.use(
    '/api/companies/:companyId/approvals',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    approvalsRouter(db),
  );

  // Unified inbox feed
  app.use(
    '/api/companies/:companyId/inbox',
    requireAuth,
    requirePermissionByMethod({ read: 'company.view', write: 'content.update' }),
    inboxRouter(db),
  );

  // Mention search (company-scoped agents + teammates for the picker)
  app.use(
    '/api/companies/:companyId/mentions',
    requireAuth,
    requirePermission('company.view'),
    mentionsRouter(db),
  );

  // Cross-artifact search (M1): FTS over artifacts + ILIKE on thread items +
  // tasks. Company-scoped. Mounted before the bare-path composite so the
  // /search path is intercepted here, not by the artifacts sub-router.
  app.use(
    '/api/companies/:companyId/search',
    requireAuth,
    requirePermission('company.view'),
    searchRouter(db),
  );

  // Company runtime snapshot (writes require agent.manage)
  app.use(
    '/api/companies/:companyId/runtime',
    requireAuth,
    requirePermissionByMethod({ read: 'company.view', write: 'agent.manage' }),
    runtimeRouter(db),
  );

  // Durable runtime sessions, skills, and routines
  app.use(
    '/api/companies/:companyId/sessions',
    requireAuth,
    requirePermission('sessions.manage'),
    sessionsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/skills',
    requireAuth,
    requirePermission('skills.manage'),
    skillsRouter(db),
  );
  app.use(
    '/api/companies/:companyId/routines',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    routinesRouter(db),
  );

  // Unified automations surface (aggregates routines, workflows, webhooks)
  app.use(
    '/api/companies/:companyId/automations',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    automationsRouter(db),
  );

  // Meetings (M7): single-meeting operations (get/patch/transcript/summarize/
  // action-items/tasks/delete/archive). Mounted at the company level so a
  // meeting can be addressed by id regardless of whether it is project-scoped.
  app.use(
    '/api/companies/:companyId/meetings',
    requireAuth,
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
    meetingItemRouter(db),
  );

  // Local execution environments (admin only)
  app.use(
    '/api/companies/:companyId/environments',
    requireAuth,
    requirePermission('environments.manage'),
    environmentsRouter(db),
  );

  // Member management (M2): list, promote/demote, remove.
  // Each endpoint applies its own requirePermission inside the router:
  //   GET    /              → member.list   (all roles)
  //   PATCH  /:memberId/role → member.promote (owner only)
  //   POST   /:memberId/role → member.promote (owner only, backward compat)
  //   DELETE /:memberId      → member.remove   (owner + admin)
  app.use('/api/companies/:companyId/members', requireAuth, membersRouter(db, requirePermission));

  // Ownership transfer (RBAC follow-up): owner-only atomic transfer.
  //   POST /api/companies/:companyId/transfer-ownership
  //   Permission: member.promote (owner only) — applied inside the router.
  app.use(
    '/api/companies/:companyId/transfer-ownership',
    requireAuth,
    transferOwnershipRouter(db, requirePermission),
  );

  // Invitation management (M2): create, list, revoke.
  // Each endpoint applies requirePermission('member.invite') inside the
  // router (owner + admin only).
  //   POST   /                → member.invite  (create invitation)
  //   GET    /                → member.invite  (list invitations)
  //   DELETE /:invitationId   → member.invite  (revoke invitation)
  app.use(
    '/api/companies/:companyId/invitations',
    requireAuth,
    invitationsRouter(db, requirePermission),
  );

  // Agent API key management (M2): create, list, revoke.
  // Each endpoint applies requirePermission('apikeys.manage') inside the
  // router (owner + admin only).
  //   POST   /                → apikeys.manage  (create key, returns raw key once)
  //   GET    /                → apikeys.manage  (list keys, metadata only)
  //   DELETE /:keyId          → apikeys.manage  (revoke key)
  app.use(
    '/api/companies/:companyId/agent-api-keys',
    requireAuth,
    agentApiKeysRouter(db, requirePermission),
  );

  // Clerk webhook handler (M2): public endpoint (no auth middleware).
  // Verifies the Clerk webhook signature in production mode; bypasses
  // verification in local_trusted mode for testing.
  //   POST /api/webhooks/clerk → handle user.created events
  app.use('/api/webhooks/clerk', clerkWebhookRouter(db));

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

  // Budgets: method-aware permission — reads for all roles, writes for
  // owner+admin+member only (content.* permissions).
  const budgetsScoped = express.Router({ mergeParams: true });
  budgetsScoped.use(
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
  );
  budgetsScoped.use(budgetsRouter(db));
  companyScopedRouter.use(budgetsScoped);

  // Artifacts: method-aware permission — reads (company.view) for all roles
  // including viewer, writes (artifact.create/update/delete) for
  // owner+admin+member only.
  const artifactsScoped = express.Router({ mergeParams: true });
  artifactsScoped.use(
    requirePermissionByMethod({
      read: 'company.view',
      create: 'artifact.create',
      update: 'artifact.update',
      delete: 'artifact.delete',
    }),
  );
  artifactsScoped.use(artifactsRouter(db));
  companyScopedRouter.use(artifactsScoped);

  // Folders: method-aware permission (content.* for writes).
  const foldersScoped = express.Router({ mergeParams: true });
  foldersScoped.use(
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
  );
  foldersScoped.use(foldersRouter(db));
  companyScopedRouter.use(foldersScoped);

  // Workspace templates: method-aware permission (content.* for writes).
  const workspaceTemplatesScoped = express.Router({ mergeParams: true });
  workspaceTemplatesScoped.use(
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
  );
  workspaceTemplatesScoped.use(workspaceTemplatesRouter(db));
  companyScopedRouter.use(workspaceTemplatesScoped);

  // Teams: method-aware permission (content.* for writes).
  const teamsScoped = express.Router({ mergeParams: true });
  teamsScoped.use(
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
  );
  teamsScoped.use(teamsRouter(db));
  companyScopedRouter.use(teamsScoped);

  // Permissions: method-aware permission (content.* for writes).
  const permissionsScoped = express.Router({ mergeParams: true });
  permissionsScoped.use(
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
  );
  permissionsScoped.use(permissionsRouter(db));
  companyScopedRouter.use(permissionsScoped);

  // Presence: method-aware permission (content.* for writes).
  const presenceScoped = express.Router({ mergeParams: true });
  presenceScoped.use(
    requirePermissionByMethod({
      read: 'company.view',
      create: 'content.create',
      update: 'content.update',
      delete: 'content.delete',
    }),
  );
  presenceScoped.use(presenceRouter(db));
  companyScopedRouter.use(presenceScoped);
  app.use(
    '/api/companies/:companyId',
    requireAuth,
    requirePermission('company.view'),
    companyScopedRouter,
  );

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
