import { getServer } from '../../server/dist/bootstrap.js';
import { HeartbeatScheduler } from '../../server/dist/services/scheduler.js';

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.authorization;
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
