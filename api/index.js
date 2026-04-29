import { getServer } from '../server/dist/bootstrap.js';

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

process.env.EIDOLON_SKIP_STATIC = '1';

export default async function handler(req, res) {
  try {
    const { app } = await getServer({
      runMigrations: false,
      setupActivityLog: true,
      maxConnections: 1,
    });
    return app(req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        status: 500,
        code: 'BOOTSTRAP_FAILED',
        message,
      }),
    );
  }
}
