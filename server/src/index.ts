import './env.js'; // must be first — loads .env from monorepo root
import { createServer } from 'node:http';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import logger from './utils/logger.js';
import { createApp } from './app.js';
import { setupWebSocketServer } from './realtime/ws-server.js';
import { setupActivityLogger } from './routes/activity.js';
import { HeartbeatScheduler } from './services/scheduler.js';
import type { DbInstance } from './types.js';

// Import DB schemas
import {
  companies,
  agents,
  tasks,
  goals,
  messages,
  costEvents,
  budgetAlerts,
  workflows,
  projects,
  activityLog,
  heartbeats,
  secrets,
  agentConfigRevisions,
  agentExecutions,
  webhooks,
  agentFiles,
  integrations,
  agentMemories,
  promptTemplates,
  promptVersions,
  knowledgeDocuments,
  knowledgeChunks,
  agentCollaborations,
  companyTemplates,
  agentEvaluations,
  mcpServers,
  approvals,
  approvalComments,
  inboxReadStates,
} from '@eidolon/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required. Start Supabase locally with `pnpm run db:start` ' +
      'and set DATABASE_URL (e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres).',
  );
}

logger.info({ host: maskUrl(DATABASE_URL) }, 'Opening Postgres connection');
const pgClient = postgres(DATABASE_URL, { max: 10 });
const drizzleDb = drizzle(pgClient);

// Run Drizzle migrations
const migrationsPath = path.resolve(__dirname, '../../packages/db/drizzle');
try {
  await migrate(drizzleDb, { migrationsFolder: migrationsPath });
  logger.info('Database migrations applied');
} catch (err: any) {
  if (err?.code === 'ENOENT' || err?.message?.includes('No migration files')) {
    logger.warn('No migration files found — run "pnpm run db:generate && pnpm run db:migrate" first');
  } else {
    throw err;
  }
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable url)';
  }
}

// ---------------------------------------------------------------------------
// Build DB instance
// ---------------------------------------------------------------------------

const db: DbInstance = {
  drizzle: drizzleDb,
  schema: {
    companies,
    agents,
    tasks,
    goals,
    messages,
    costEvents,
    budgetAlerts,
    workflows,
    projects,
    activityLog,
    heartbeats,
    secrets,
    agentConfigRevisions,
    agentExecutions,
    webhooks,
    agentFiles,
    integrations,
    agentMemories,
    promptTemplates,
    promptVersions,
    knowledgeDocuments,
    knowledgeChunks,
    agentCollaborations,
    companyTemplates,
    agentEvaluations,
    mcpServers,
    approvals,
    approvalComments,
    inboxReadStates,
  },
};

// ---------------------------------------------------------------------------
// Application & server
// ---------------------------------------------------------------------------

const app = createApp(db);
const server = createServer(app);

// Setup WebSocket on the same HTTP server
setupWebSocketServer(server);

// Setup activity logger (listens to events and writes to activity_log table)
setupActivityLogger(db);

// Setup heartbeat scheduler (auto-assigns tasks to idle agents)
const scheduler = new HeartbeatScheduler(db);

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

server.listen(PORT, HOST, () => {
  logger.info(
    {
      port: PORT,
      host: HOST,
      env: process.env.NODE_ENV ?? 'development',
      db: maskUrl(DATABASE_URL),
    },
    `Eidolon server listening on http://${HOST}:${PORT}`,
  );
  logger.info(`  REST API:    http://localhost:${PORT}/api`);
  logger.info(`  WebSocket:   ws://localhost:${PORT}/ws`);
  logger.info(`  Health:      http://localhost:${PORT}/api/health`);

  // Start the heartbeat scheduler after the server is listening
  scheduler.start();
});

// Graceful shutdown
let shuttingDown = false;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const parsedShutdownTimeoutMs = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '', 10);
const shutdownTimeoutMs =
  Number.isFinite(parsedShutdownTimeoutMs) && parsedShutdownTimeoutMs > 0
    ? parsedShutdownTimeoutMs
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    // Second signal = force exit immediately
    logger.warn('Forced shutdown (second signal)');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received');

  scheduler.stop();

  // Close all WebSocket connections so server.close() can finish
  server.closeAllConnections();

  server.close(async () => {
    await pgClient.end({ timeout: 5 });
    logger.info('Server stopped');
    process.exit(0);
  });

  // Force exit after the configured timeout if something hangs
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, shutdownTimeoutMs).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
