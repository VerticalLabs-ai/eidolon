import 'dotenv/config';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
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
} from '@eidolon/db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const DB_PATH = process.env.DATABASE_URL ?? path.resolve(__dirname, '../../data/eidolon.db');

// Ensure the data directory exists
import { mkdirSync } from 'node:fs';
mkdirSync(path.dirname(DB_PATH), { recursive: true });

logger.info({ path: DB_PATH }, 'Opening SQLite database');
const sqlite = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('cache_size = -64000'); // 64MB
sqlite.pragma('foreign_keys = ON');

const drizzleDb = drizzle(sqlite);

// Run Drizzle migrations
const migrationsPath = path.resolve(__dirname, '../../packages/db/drizzle');
try {
  migrate(drizzleDb, { migrationsFolder: migrationsPath });
  logger.info('Database migrations applied');
} catch (err: any) {
  if (err.code === 'ENOENT' || err.message?.includes('No migration files')) {
    logger.warn('No migration files found — run "npm run db:generate && npm run db:migrate" first');
  } else {
    throw err;
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
      db: DB_PATH,
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
const shutdown = (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  scheduler.stop();
  server.close(() => {
    sqlite.close();
    logger.info('Server stopped');
    process.exit(0);
  });
  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
