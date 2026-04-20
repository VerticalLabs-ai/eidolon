import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';

import logger from './utils/logger.js';
import { createApp } from './app.js';
import { setupActivityLogger } from './routes/activity.js';
import type { DbInstance } from './types.js';

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

// ---------------------------------------------------------------------------
// Shared bootstrap for every entry point (local dev, Vercel Function, Cron).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCHEMA_BUNDLE = {
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
} as const;

export interface BootstrapOptions {
  /**
   * Run Drizzle migrations on boot. Default true locally, false in serverless
   * (migrations are run as part of CI/deploy or via pnpm run db:migrate).
   */
  runMigrations?: boolean;
  /**
   * Register the in-process activity-log event listener. Cheap; safe to call
   * on every cold start because the bus is deduped per listener function.
   */
  setupActivityLog?: boolean;
  /**
   * Maximum pool size for the postgres.js client. Serverless should use 1.
   */
  maxConnections?: number;
}

export interface BootstrapResult {
  db: DbInstance;
  app: Express;
  client: Sql;
  connectionString: string;
}

let cached: Promise<BootstrapResult> | null = null;

function resolveConnectionString(): string {
  // Precedence: DATABASE_URL (dev local-first convention) wins over the
  // Vercel Marketplace names. Locally the user sets DATABASE_URL to their
  // Supabase-CLI docker instance. On Vercel only the POSTGRES_URL family is
  // present (no DATABASE_URL), so hosted Supabase wins there.
  const candidate =
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.POSTGRES_URL_NON_POOLING;
  if (!candidate) {
    throw new Error(
      'No Postgres connection string set. On Vercel: add the Supabase ' +
        'Marketplace integration (POSTGRES_URL). Locally: `pnpm run db:start` ' +
        'and set DATABASE_URL.',
    );
  }
  return candidate;
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

async function build(options: BootstrapOptions): Promise<BootstrapResult> {
  const {
    runMigrations = true,
    setupActivityLog = true,
    maxConnections = 10,
  } = options;

  const connectionString = resolveConnectionString();
  logger.info({ db: maskUrl(connectionString) }, 'Opening Postgres connection');

  const client = postgres(connectionString, { max: maxConnections });
  const drizzleDb = drizzle(client);

  if (runMigrations) {
    const migrationsPath = path.resolve(__dirname, '../../packages/db/drizzle');
    try {
      await migrate(drizzleDb, { migrationsFolder: migrationsPath });
      logger.info('Database migrations applied');
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.message?.includes('No migration files')) {
        logger.warn(
          'No migration files found — run "pnpm run db:generate && pnpm run db:migrate" first',
        );
      } else {
        throw err;
      }
    }
  }

  const db: DbInstance = {
    drizzle: drizzleDb,
    schema: SCHEMA_BUNDLE,
  };

  const app = createApp(db);

  if (setupActivityLog) {
    setupActivityLogger(db);
  }

  return { db, app, client, connectionString };
}

/**
 * Memoized bootstrap. Safe to call from request handlers on serverless —
 * the cached promise ensures the same DB pool + app are reused across
 * invocations on the same Function instance (Fluid Compute keeps containers
 * warm).
 */
export function getServer(options: BootstrapOptions = {}): Promise<BootstrapResult> {
  if (!cached) {
    cached = build(options).catch((err) => {
      cached = null; // allow retry on next request
      throw err;
    });
  }
  return cached;
}
