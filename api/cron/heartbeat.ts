import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServer } from '../../server/src/bootstrap.js';
import { HeartbeatScheduler } from '../../server/src/services/scheduler.js';

// ---------------------------------------------------------------------------
// Vercel Cron entry — replaces the local setInterval(30_000) scheduler.
//
// Schedule configured in vercel.json. Each invocation runs exactly one
// scheduler tick (agent heartbeat checks + timed-out task cleanup +
// priority-ordered task assignment). Concurrent invocations are idempotent:
// the scheduler's `running` guard short-circuits overlaps, and task
// assignment uses atomic conditional UPDATEs.
//
// Vercel signs cron requests with a bearer token — we verify it before
// doing any work to prevent someone triggering agent wakes publicly.
// ---------------------------------------------------------------------------

export const config = {
  maxDuration: 60,
};

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  // Vercel Cron sets `Authorization: Bearer <CRON_SECRET>` when that env var
  // is configured on the project. When unset (local `vercel dev`, preview
  // tests), we accept the request so the route is testable.
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${expected}`) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
      return;
    }
  }

  try {
    const { db } = await getServer({
      runMigrations: false,
      setupActivityLog: false,
      maxConnections: 1,
    });

    const scheduler = new HeartbeatScheduler(db);
    const result = await scheduler.runOnce();

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        ok: true,
        skipped: result.skipped,
        at: new Date().toISOString(),
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 'CRON_FAILED', message }));
  }
}
