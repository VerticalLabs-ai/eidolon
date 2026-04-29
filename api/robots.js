export const config = {
  maxDuration: 5,
};

const PRODUCTION_HOSTS = new Set(['eidolon.verticallabs.ai']);

function buildBody(host) {
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

export default function handler(req, res) {
  const host = (req.headers.host ?? '').toLowerCase();
  const body = buildBody(host);

  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  res.setHeader('x-eidolon-robots-host', host);
  res.end(body);
}
