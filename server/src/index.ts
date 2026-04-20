import './env.js'; // must be first — loads .env from monorepo root
import { createServer } from 'node:http';

import logger from './utils/logger.js';
import { getServer } from './bootstrap.js';
import { setupWebSocketServer } from './realtime/ws-server.js';
import { HeartbeatScheduler } from './services/scheduler.js';

// ---------------------------------------------------------------------------
// Local-dev entry point.
//
// Shares `getServer()` with the Vercel Function entry in `api/index.ts` so
// there's a single source of truth for the DB pool + Express app. The only
// things that live here are the three features serverless can't host:
//   1. The HTTP server wrapping Express on a port (`.listen()`)
//   2. The WebSocket upgrade handler (persistent connections)
//   3. The HeartbeatScheduler's setInterval loop (long-running background job)
//
// On Vercel those become: a Vercel Function (api/), an external realtime
// channel (Supabase Realtime, follow-up), and a Vercel Cron (api/cron/…).
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const { db, app, client, connectionString } = await getServer({
  runMigrations: true,
  setupActivityLog: true,
  maxConnections: 10,
});

const server = createServer(app);
setupWebSocketServer(server);

const scheduler = new HeartbeatScheduler(db);

server.listen(PORT, HOST, () => {
  logger.info(
    {
      port: PORT,
      host: HOST,
      env: process.env.NODE_ENV ?? 'development',
      db: maskUrl(connectionString),
    },
    `Eidolon server listening on http://${HOST}:${PORT}`,
  );
  logger.info(`  REST API:    http://localhost:${PORT}/api`);
  logger.info(`  WebSocket:   ws://localhost:${PORT}/ws`);
  logger.info(`  Health:      http://localhost:${PORT}/api/health`);

  scheduler.start();
});

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
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const parsedShutdownTimeoutMs = Number.parseInt(
  process.env.SHUTDOWN_TIMEOUT_MS ?? '',
  10,
);
const shutdownTimeoutMs =
  Number.isFinite(parsedShutdownTimeoutMs) && parsedShutdownTimeoutMs > 0
    ? parsedShutdownTimeoutMs
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    logger.warn('Forced shutdown (second signal)');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received');

  scheduler.stop();
  server.closeAllConnections();

  server.close(async () => {
    await client.end({ timeout: 5 });
    logger.info('Server stopped');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, shutdownTimeoutMs).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
