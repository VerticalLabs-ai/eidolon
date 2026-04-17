import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from 'better-auth/node';
import logger from './utils/logger.js';
import { notFound, errorHandler } from './middleware/error-handler.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { authRateLimit, apiRateLimit } from './middleware/rate-limit.js';
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
import { adaptersRouter } from './routes/adapters.js';
import { approvalsRouter } from './routes/approvals.js';
import { inboxRouter } from './routes/inbox.js';
import type { DbInstance } from './types.js';
import type { Auth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db: DbInstance, auth: Auth): express.Express {
  const app = express();
  const { requireAuth, requireOrgMember } = createAuthMiddleware(auth);

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
  // Auth routes (BEFORE express.json — BetterAuth reads the raw body stream)
  // ---------------------------------------------------------------------------

  const authHandler = toNodeHandler(auth);
  app.all('/api/auth/*splat', authRateLimit, (req, res) => {
    try {
      const result = authHandler(req, res);
      // Catch async errors from the handler
      if (result && typeof (result as any).catch === 'function') {
        (result as any).catch((err: unknown) => {
          logger.error({ err, url: req.url, method: req.method }, 'BetterAuth handler error');
          if (!res.headersSent) {
            res.status(500).json({
              error: 'Auth error',
              message: isDev ? String(err) : 'Internal server error',
            });
          }
        });
      }
    } catch (err) {
      logger.error({ err, url: req.url, method: req.method }, 'BetterAuth handler sync error');
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Auth error',
          message: isDev ? String(err) : 'Internal server error',
        });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Global middleware (for all non-auth routes)
  // ---------------------------------------------------------------------------

  // Parse JSON bodies (Express 5 built-in)
  app.use(express.json({ limit: '2mb' }));

  // Broad rate-limit for everything under /api (skipped in test + local_trusted)
  app.use('/api', apiRateLimit);

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

  // Adapter registry introspection (public read; no secrets leaked)
  app.use('/api/adapters', adaptersRouter());

  // Inbound webhook trigger (public endpoint - validated via webhook secret)
  app.use('/api/webhooks', webhookTriggerRouter(db));

  // Company Templates (public read, auth for write)
  app.use('/api/templates', templatesRouter(db));

  // Global prompts (public read)
  app.use('/api/prompts', globalPromptsRouter(db));

  // ---------------------------------------------------------------------------
  // Authenticated routes
  // ---------------------------------------------------------------------------

  app.use('/api/companies', requireAuth, companiesRouter(db));

  // Company-scoped routes (require auth + org membership)
  app.use('/api/companies/:companyId/agents', requireAuth, requireOrgMember(), agentsRouter(db));
  app.use('/api/companies/:companyId/org-chart', requireAuth, requireOrgMember(), orgChartRouter(db));
  app.use('/api/companies/:companyId/projects', requireAuth, requireOrgMember(), projectsRouter(db));
  app.use('/api/companies/:companyId/tasks', requireAuth, requireOrgMember(), tasksRouter(db));
  app.use('/api/companies/:companyId/goals', requireAuth, requireOrgMember(), goalsRouter(db));
  app.use('/api/companies/:companyId/messages', requireAuth, requireOrgMember(), messagesRouter(db));
  app.use('/api/companies/:companyId', requireAuth, requireOrgMember(), budgetsRouter(db));
  app.use('/api/companies/:companyId/analytics', requireAuth, requireOrgMember(), analyticsRouter(db));
  app.use('/api/companies/:companyId/workflows', requireAuth, requireOrgMember(), workflowsRouter(db));
  app.use('/api/companies/:companyId/activity', requireAuth, requireOrgMember(), activityRouter(db));
  app.use('/api/companies/:companyId/secrets', requireAuth, requireOrgMember('admin'), secretsRouter(db));
  app.use('/api/companies/:companyId/chat', requireAuth, requireOrgMember(), chatRouter(db));

  // Knowledge base
  app.use('/api/companies/:companyId/knowledge', requireAuth, requireOrgMember(), knowledgeRouter(db));

  // File manager
  app.use('/api/companies/:companyId/files', requireAuth, requireOrgMember(), filesRouter(db));
  app.use('/api/companies/:companyId/agents/:agentId/files', requireAuth, requireOrgMember(), agentFilesRouter(db));

  // Integrations
  app.use('/api/companies/:companyId/integrations', requireAuth, requireOrgMember('admin'), integrationsRouter(db));

  // Agent memories
  app.use('/api/companies/:companyId/agents/:agentId/memories', requireAuth, requireOrgMember(), memoriesRouter(db));

  // Prompt Studio (company-scoped)
  app.use('/api/companies/:companyId/prompts', requireAuth, requireOrgMember(), companyPromptsRouter(db));

  // Agent evaluations & performance
  app.use('/api/companies/:companyId/evaluations', requireAuth, requireOrgMember(), evaluationsRouter(db));

  // MCP (Model Context Protocol) servers and tools
  app.use('/api/companies/:companyId/mcp', requireAuth, requireOrgMember('admin'), mcpRouter(db));

  // Webhook management (admin only)
  app.use('/api/companies/:companyId/webhooks', requireAuth, requireOrgMember('admin'), webhookManagementRouter(db));

  // Agent Collaboration Protocol
  app.use('/api/companies/:companyId/collaborations', requireAuth, requireOrgMember(), collaborationsRouter(db));
  app.use('/api/companies/:companyId/agents/:agentId/collaborations', requireAuth, requireOrgMember(), agentCollaborationsRouter(db));

  // Company export (admin only)
  app.use('/api/companies/:companyId/export', requireAuth, requireOrgMember('admin'), companyExportRouter(db));

  // Approvals (any org member can create/comment; decide requires admin+)
  app.use('/api/companies/:companyId/approvals', requireAuth, requireOrgMember(), approvalsRouter(db));

  // Unified inbox feed
  app.use('/api/companies/:companyId/inbox', requireAuth, requireOrgMember(), inboxRouter(db));

  // ---------------------------------------------------------------------------
  // Static file serving for production UI
  // ---------------------------------------------------------------------------

  if (!isDev) {
    const uiDistPath = path.resolve(__dirname, '../../ui/dist');
    app.use(express.static(uiDistPath));
    app.get('*', (_req, res) => {
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
