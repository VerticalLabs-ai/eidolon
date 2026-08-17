import pino from 'pino';
import type { IncomingMessage } from 'node:http';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * Query-parameter names (case-insensitive) whose values may carry secrets.
 * `key` is matched only as an exact name to avoid false positives like
 * `keyboard` or `monkey`. The remaining patterns are distinctive enough to
 * match as substrings (e.g. `accessToken` contains `token`).
 */
const SENSITIVE_QUERY_SUBSTRINGS = [
  'token',
  'apikey',
  'api_key',
  'secret',
  'password',
  'passphrase',
];
const SENSITIVE_QUERY_EXACT = ['key'];

function isSensitiveQueryParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_QUERY_EXACT.includes(lower)) {
    return true;
  }
  return SENSITIVE_QUERY_SUBSTRINGS.some((p) => lower.includes(p));
}

/**
 * Strip sensitive query parameters from a URL string so that tokens, API
 * keys, secrets, and passwords are not leaked in request logs.
 *
 * Used by the pino-http request serializer (see {@link requestSerializer}).
 * Exported so redaction tests can exercise the exact function the production
 * serializer uses.
 */
export function sanitizeUrl(url: string | undefined): string {
  if (!url || !url.includes('?')) {
    return url ?? '';
  }
  try {
    const parsed = new URL(url, 'http://localhost');
    const params = parsed.searchParams;
    let modified = false;
    for (const key of [...params.keys()]) {
      if (isSensitiveQueryParam(key)) {
        params.delete(key);
        modified = true;
      }
    }
    if (!modified) {
      return url;
    }
    const search = params.toString();
    return search ? `${parsed.pathname}?${search}` : parsed.pathname;
  } catch {
    // If the URL cannot be parsed, return it unchanged rather than risk
    // dropping something important or crashing the logger.
    return url;
  }
}

/**
 * pino-http request serializer.
 *
 * Returns a minimal `{ method, url }` object with the URL sanitized by
 * {@link sanitizeUrl} so sensitive query parameters are stripped before
 * logging.
 *
 * Exported so redaction tests can exercise the actual serializer used by
 * the production pino-http middleware.
 */
export function requestSerializer(req: Pick<IncomingMessage, 'method' | 'url'>): {
  method?: string;
  url: string;
} {
  return {
    method: req.method,
    url: sanitizeUrl(req.url),
  };
}

/**
 * Pino redact paths for sensitive request fields.
 *
 * Covers authorization headers, cookies, passwords, tokens, API keys, and
 * secrets in request bodies and query strings. Wildcard variants (`*.`)
 * catch the same fields on differently-named containers (e.g. `res`, the
 * pino-http serialised `req`, or custom log objects).
 *
 * Nested wildcard paths (`req.body.*.<field>`) catch sensitive fields
 * inside arbitrary sub-objects of the request body (e.g.
 * `req.body.credentials.apiKey`, `req.body.webhook.secret`).
 *
 * Exported so redaction tests can exercise the exact configuration the
 * production logger uses.
 */
export const redactPaths: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.token',
  'req.body.apiKey',
  'req.body.secret',
  'req.body.passphrase',
  'req.body.clientSecret',
  'req.body.refreshToken',
  'req.body.accessToken',
  'req.query.token',
  'req.query.apiKey',
  'req.query.secret',
  // Nested wildcard paths — sensitive fields inside arbitrary sub-objects
  'req.body.*.apiKey',
  'req.body.*.secret',
  'req.body.*.token',
  'req.body.*.password',
  'req.body.*.passphrase',
  'req.body.*.clientSecret',
  'req.body.*.refreshToken',
  'req.body.*.accessToken',
  // Wildcard variants for nested or differently-named containers
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["x-api-key"]',
  '*.body.password',
  '*.body.token',
  '*.body.apiKey',
  '*.body.secret',
  '*.body.passphrase',
  '*.body.clientSecret',
  '*.body.refreshToken',
  '*.body.accessToken',
  '*.query.token',
  '*.query.apiKey',
  '*.query.secret',
  // Nested wildcard paths for differently-named containers
  '*.body.*.apiKey',
  '*.body.*.secret',
  '*.body.*.token',
  '*.body.*.password',
  '*.body.*.passphrase',
  '*.body.*.clientSecret',
  '*.body.*.refreshToken',
  '*.body.*.accessToken',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  redact: {
    paths: redactPaths,
    censor: '[Redacted]',
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export default logger;
