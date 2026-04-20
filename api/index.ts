import type { IncomingMessage, ServerResponse } from 'node:http';
import { getServer } from '../server/src/bootstrap.js';

// ---------------------------------------------------------------------------
// Vercel Fluid Compute entry for the Eidolon REST API.
//
// All requests routed to /api/* by vercel.json land here. The Express app
// (shared with local dev via server/src/bootstrap.ts) handles its own
// per-route sub-paths, including /api/companies/:id/agents, etc.
//
// Migrations do NOT run on boot in this entry — apply them as a deploy step
// (`pnpm run db:migrate`) against POSTGRES_URL_NON_POOLING. The Supabase
// Marketplace integration provisions both pooled (POSTGRES_URL) and
// non-pooled URLs.
// ---------------------------------------------------------------------------

export const config = {
  // Keep bodyParser off — Express handles it via express.json in createApp.
  api: { bodyParser: false },
  // Fluid Compute friendly: long default timeout, same-region execution.
  maxDuration: 60,
};

// Vercel serves the built UI from its own static layer, so the Express
// app should not register its SPA fallback route when running on Fluid
// Compute. The createApp() static-serving block honors this flag.
process.env.EIDOLON_SKIP_STATIC = '1';

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const { app } = await getServer({
      runMigrations: false,
      setupActivityLog: true,
      // Serverless-friendly pool — one instance per warm Function.
      maxConnections: 1,
    });
    return app(req, res);
  } catch (err) {
    // Bootstrap itself failed — surface a short JSON error so the client
    // has something actionable instead of the default Vercel 500 page.
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
