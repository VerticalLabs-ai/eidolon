import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './utils/logger.js';
import { notFound, errorHandler } from './middleware/error-handler.js';
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
import type { DbInstance } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db: DbInstance): express.Express {
  const app = express();

  // ---------------------------------------------------------------------------
  // Global middleware
  // ---------------------------------------------------------------------------

  // Parse JSON bodies (Express 5 built-in)
  app.use(express.json({ limit: '2mb' }));

  // CORS - allow all in development
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

  app.use('/api', healthRouter);
  app.use('/api/companies', companiesRouter(db));
  app.use('/api/companies/:companyId/agents', agentsRouter(db));
  app.use('/api/companies/:companyId/org-chart', orgChartRouter(db));
  app.use('/api/companies/:companyId/projects', projectsRouter(db));
  app.use('/api/companies/:companyId/tasks', tasksRouter(db));
  app.use('/api/companies/:companyId/goals', goalsRouter(db));
  app.use('/api/companies/:companyId/messages', messagesRouter(db));
  app.use('/api/companies/:companyId', budgetsRouter(db));
  app.use('/api/companies/:companyId/analytics', analyticsRouter(db));
  app.use('/api/companies/:companyId/workflows', workflowsRouter(db));
  app.use('/api/companies/:companyId/activity', activityRouter(db));
  app.use('/api/companies/:companyId/secrets', secretsRouter(db));
  app.use('/api/companies/:companyId/chat', chatRouter(db));

  // Knowledge base
  app.use('/api/companies/:companyId/knowledge', knowledgeRouter(db));

  // File manager
  app.use('/api/companies/:companyId/files', filesRouter(db));
  app.use('/api/companies/:companyId/agents/:agentId/files', agentFilesRouter(db));

  // Integrations
  app.use('/api/companies/:companyId/integrations', integrationsRouter(db));

  // Agent memories
  app.use('/api/companies/:companyId/agents/:agentId/memories', memoriesRouter(db));

  // Prompt Studio
  app.use('/api/prompts', globalPromptsRouter(db));
  app.use('/api/companies/:companyId/prompts', companyPromptsRouter(db));

  // Agent evaluations & performance
  app.use('/api/companies/:companyId/evaluations', evaluationsRouter(db));

  // MCP (Model Context Protocol) servers and tools
  app.use('/api/companies/:companyId/mcp', mcpRouter(db));

  // Webhook management (authenticated, scoped to company)
  app.use('/api/companies/:companyId/webhooks', webhookManagementRouter(db));

  // Agent Collaboration Protocol
  app.use('/api/companies/:companyId/collaborations', collaborationsRouter(db));
  app.use('/api/companies/:companyId/agents/:agentId/collaborations', agentCollaborationsRouter(db));

  // Company Templates (App Store for AI Companies)
  app.use('/api/templates', templatesRouter(db));
  app.use('/api/companies/:companyId/export', companyExportRouter(db));

  // Inbound webhook trigger (public endpoint - validated via webhook secret)
  app.use('/api/webhooks', webhookTriggerRouter(db));

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
