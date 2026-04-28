import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Host-aware robots.txt for the Vercel deployment.
//
// Production (eidolon.verticallabs.ai or any future apex) → allow all + sitemap.
// Anything else (staging.eidolon.verticallabs.ai, *.vercel.app preview URLs) →
// Disallow: / so search engines don't index non-prod surfaces.
//
// Mirrors the global CLAUDE.md pattern that staging gets `Disallow: /` to
// avoid SEO duplicate-content vs the canonical production domain.
// ---------------------------------------------------------------------------

export const config = {
  maxDuration: 5,
};

const PRODUCTION_HOSTS = new Set([
  'eidolon.verticallabs.ai',
]);

function buildBody(host: string): string {
  if (PRODUCTION_HOSTS.has(host)) {
    return [
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: https://${host}/sitemap.xml`,
      '',
    ].join('\n');
  }

  return ['User-agent: *', 'Disallow: /', ''].join('\n');
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const host = (req.headers['host'] ?? '').toLowerCase();
  const body = buildBody(host);

  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  // Cache 5 minutes at the edge — long enough to dampen traffic, short
  // enough that flipping a domain to/from production propagates quickly.
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  res.setHeader('x-eidolon-robots-host', host);
  res.end(body);
}
