import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { redactPaths, sanitizeUrl, requestSerializer } from '../utils/logger.js';

/**
 * Create a pino instance with the same redact configuration as the production
 * logger but writing to an in-memory stream (no pino-pretty transport) so the
 * output is parseable JSON.
 */
function createCapturingLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const log = pino(
    {
      level: 'info',
      redact: {
        paths: redactPaths,
        censor: '[Redacted]',
      },
    },
    stream,
  );
  return { log, getOutput: () => chunks.join('') };
}

function parseLogLine(output: string) {
  const lines = output.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  return JSON.parse(last);
}

describe('log redaction', () => {
  // -------------------------------------------------------------------------
  // Configuration assertions (VAL-SEC-012)
  // -------------------------------------------------------------------------

  it('includes redact paths for all sensitive fields', () => {
    expect(redactPaths).toContain('req.headers.authorization');
    expect(redactPaths).toContain('req.headers.cookie');
    expect(redactPaths).toContain('req.body.password');
    expect(redactPaths).toContain('req.body.token');
    expect(redactPaths).toContain('req.body.apiKey');
    expect(redactPaths).toContain('req.body.secret');
    expect(redactPaths).toContain('req.query.token');
  });

  // -------------------------------------------------------------------------
  // Redaction behaviour (VAL-SEC-013)
  // -------------------------------------------------------------------------

  it('redacts authorization header', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/login',
          headers: {
            authorization: 'Bearer super-secret-token',
            'content-type': 'application/json',
          },
        },
      },
      'request received',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.headers.authorization).toBe('[Redacted]');
    expect(parsed.req.headers['content-type']).toBe('application/json');
    expect(parsed.req.method).toBe('POST');
    expect(parsed.req.url).toBe('/api/login');
  });

  it('redacts cookie header', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'GET',
          url: '/api/data',
          headers: {
            cookie: 'session=abc123; token=xyz456',
            accept: 'application/json',
          },
        },
      },
      'request received',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.headers.cookie).toBe('[Redacted]');
    expect(parsed.req.headers.accept).toBe('application/json');
  });

  it('redacts request body password field', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/login',
          body: { password: 'test-fake-password', username: 'alice' },
        },
      },
      'login attempt',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.password).toBe('[Redacted]');
    expect(parsed.req.body.username).toBe('alice');
  });

  it('redacts nested API key in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/config',
          body: { apiKey: 'test-fake-api-key-redacted', service: 'openai' },
        },
      },
      'config update',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.apiKey).toBe('[Redacted]');
    expect(parsed.req.body.service).toBe('openai');
  });

  it('redacts token in query params', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'GET',
          url: '/api/verify',
          query: { token: 'test-fake-token-value', page: '2' },
        },
      },
      'verification request',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.query.token).toBe('[Redacted]');
    expect(parsed.req.query.page).toBe('2');
  });

  it('redacts secret field in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/webhooks',
          body: { secret: 'test-fake-secret-value', name: 'webhook-config' },
        },
      },
      'webhook creation',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.secret).toBe('[Redacted]');
    expect(parsed.req.body.name).toBe('webhook-config');
  });

  // -------------------------------------------------------------------------
  // No false positives (VAL-SEC-013)
  // -------------------------------------------------------------------------

  it('does not redact non-sensitive fields (no false positives)', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'GET',
          url: '/api/companies/123/agents',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'test-agent',
          },
          body: { name: 'Agent Smith', role: 'analyst' },
          query: { page: '1', limit: '20' },
        },
      },
      'agent list request',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.method).toBe('GET');
    expect(parsed.req.url).toBe('/api/companies/123/agents');
    expect(parsed.req.headers['content-type']).toBe('application/json');
    expect(parsed.req.headers['user-agent']).toBe('test-agent');
    expect(parsed.req.body.name).toBe('Agent Smith');
    expect(parsed.req.body.role).toBe('analyst');
    expect(parsed.req.query.page).toBe('1');
    expect(parsed.req.query.limit).toBe('20');
  });

  it('redacts sensitive fields while preserving sibling sensitive-looking but non-matching fields', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/reset',
          body: {
            token: 'test-fake-token-value',
            newPassword: 'should-not-be-redacted-by-token-path',
            email: 'user@example.com',
          },
        },
      },
      'password reset',
    );
    const parsed = parseLogLine(getOutput());
    // token is redacted
    expect(parsed.req.body.token).toBe('[Redacted]');
    // newPassword is NOT in the redact list (only "password" is, not "newPassword")
    expect(parsed.req.body.newPassword).toBe('should-not-be-redacted-by-token-path');
    expect(parsed.req.body.email).toBe('user@example.com');
  });

  // -------------------------------------------------------------------------
  // URL query-string sanitization (EID-95 scrutiny fix)
  // -------------------------------------------------------------------------

  it('sanitizeUrl strips token from query string', () => {
    const result = sanitizeUrl('/api/foo?token=secret123&bar=baz');
    expect(result).not.toContain('secret123');
    expect(result).not.toContain('token=');
    expect(result).toContain('bar=baz');
  });

  it('sanitizeUrl strips apiKey from query string', () => {
    const result = sanitizeUrl('/api/data?apiKey=key123&page=1');
    expect(result).not.toContain('key123');
    expect(result).not.toContain('apiKey=');
    expect(result).toContain('page=1');
  });

  it('sanitizeUrl strips secret from query string', () => {
    const result = sanitizeUrl('/api/hook?secret=whsec_abc&name=test');
    expect(result).not.toContain('whsec_abc');
    expect(result).not.toContain('secret=');
    expect(result).toContain('name=test');
  });

  it('sanitizeUrl strips password from query string', () => {
    const result = sanitizeUrl('/api/auth?password=hunter2&user=bob');
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('password=');
    expect(result).toContain('user=bob');
  });

  it('sanitizeUrl strips key from query string', () => {
    const result = sanitizeUrl('/api/resource?key=masterkey&id=42');
    expect(result).not.toContain('masterkey');
    expect(result).not.toContain('key=');
    expect(result).toContain('id=42');
  });

  it('sanitizeUrl strips multiple sensitive params at once', () => {
    const result = sanitizeUrl('/api/cb?token=t1&apiKey=k1&secret=s1&password=p1&key=m1&safe=ok');
    expect(result).not.toContain('t1');
    expect(result).not.toContain('k1');
    expect(result).not.toContain('s1');
    expect(result).not.toContain('p1');
    expect(result).not.toContain('m1');
    expect(result).toContain('safe=ok');
  });

  it('sanitizeUrl does not modify URLs without query strings', () => {
    expect(sanitizeUrl('/api/foo')).toBe('/api/foo');
    expect(sanitizeUrl('/api/companies/123/agents')).toBe('/api/companies/123/agents');
  });

  it('sanitizeUrl does not modify URLs with only non-sensitive params', () => {
    expect(sanitizeUrl('/api/list?page=1&limit=20')).toBe('/api/list?page=1&limit=20');
  });

  it('sanitizeUrl strips all params when only sensitive ones exist', () => {
    const result = sanitizeUrl('/api/verify?token=abc123');
    expect(result).toBe('/api/verify');
  });

  it('sanitizeUrl handles case-insensitive param names', () => {
    const result = sanitizeUrl('/api/x?TOKEN=secret&ApiKey=key');
    expect(result).not.toContain('secret');
    expect(result).not.toContain('key');
  });

  it('sanitizeUrl does not strip non-sensitive params containing "key" substring (e.g. monkey)', () => {
    const result = sanitizeUrl('/api/z?monkey=bar&page=1');
    expect(result).toContain('monkey=bar');
    expect(result).toContain('page=1');
  });

  // -------------------------------------------------------------------------
  // Actual pino-http request serializer (EID-95 scrutiny fix)
  // -------------------------------------------------------------------------

  it('requestSerializer sanitizes URLs with sensitive query params', () => {
    const serialized = requestSerializer({
      method: 'GET',
      url: '/api/foo?token=secret123&bar=baz',
    });
    expect(serialized.method).toBe('GET');
    expect(serialized.url).not.toContain('secret123');
    expect(serialized.url).not.toContain('token=');
    expect(serialized.url).toContain('bar=baz');
  });

  it('requestSerializer preserves method and sanitized url for non-sensitive URLs', () => {
    const serialized = requestSerializer({ method: 'POST', url: '/api/companies/123/agents' });
    expect(serialized.method).toBe('POST');
    expect(serialized.url).toBe('/api/companies/123/agents');
  });

  it('requestSerializer strips apiKey from URL query string', () => {
    const serialized = requestSerializer({
      method: 'GET',
      url: '/api/data?apiKey=sk-test-key&page=2',
    });
    expect(serialized.url).not.toContain('sk-test-key');
    expect(serialized.url).toContain('page=2');
  });

  // -------------------------------------------------------------------------
  // Nested sensitive field redaction (EID-95 scrutiny fix)
  // -------------------------------------------------------------------------

  it('includes wildcard redact paths for nested sensitive fields', () => {
    expect(redactPaths).toContain('req.body.*.apiKey');
    expect(redactPaths).toContain('req.body.*.secret');
    expect(redactPaths).toContain('req.body.*.token');
    expect(redactPaths).toContain('req.body.*.password');
  });

  it('redacts nested credentials.apiKey in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/integrations',
          body: {
            credentials: { apiKey: 'test-fake-api-key-redacted', region: 'us-east-1' },
            name: 'aws-integration',
          },
        },
      },
      'integration setup',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.credentials.apiKey).toBe('[Redacted]');
    expect(parsed.req.body.credentials.region).toBe('us-east-1');
    expect(parsed.req.body.name).toBe('aws-integration');
  });

  it('redacts nested webhook.secret in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/webhooks',
          body: {
            webhook: { secret: 'test-fake-secret-value', url: 'https://example.com/hook' },
            enabled: true,
          },
        },
      },
      'webhook creation',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.webhook.secret).toBe('[Redacted]');
    expect(parsed.req.body.webhook.url).toBe('https://example.com/hook');
    expect(parsed.req.body.enabled).toBe(true);
  });

  it('redacts nested auth.token in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/auth',
          body: {
            auth: { token: 'test-fake-token-value', provider: 'clerk' },
            userId: 'user-123',
          },
        },
      },
      'auth request',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.auth.token).toBe('[Redacted]');
    expect(parsed.req.body.auth.provider).toBe('clerk');
    expect(parsed.req.body.userId).toBe('user-123');
  });

  it('redacts nested password field in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/signup',
          body: {
            user: { password: 'test-fake-password', email: 'test@example.com' },
            confirm: true,
          },
        },
      },
      'signup',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.user.password).toBe('[Redacted]');
    expect(parsed.req.body.user.email).toBe('test@example.com');
    expect(parsed.req.body.confirm).toBe(true);
  });

  it('redacts nested passphrase field in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/encrypt',
          body: {
            config: { passphrase: 'test-fake-passphrase', algorithm: 'aes-256' },
          },
        },
      },
      'encryption config',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.config.passphrase).toBe('[Redacted]');
    expect(parsed.req.body.config.algorithm).toBe('aes-256');
  });

  it('redacts nested clientSecret field in request body', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/oauth',
          body: {
            oauth: { clientSecret: 'test-fake-client-secret', clientId: 'pub-id' },
          },
        },
      },
      'oauth setup',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.oauth.clientSecret).toBe('[Redacted]');
    expect(parsed.req.body.oauth.clientId).toBe('pub-id');
  });

  it('does not redact non-sensitive nested fields (no false positives)', () => {
    const { log, getOutput } = createCapturingLogger();
    log.info(
      {
        req: {
          method: 'POST',
          url: '/api/agents',
          body: {
            agent: { name: 'Agent Smith', role: 'analyst', model: 'claude-3' },
            config: { maxTokens: 4096, temperature: 0.7 },
          },
        },
      },
      'agent creation',
    );
    const parsed = parseLogLine(getOutput());
    expect(parsed.req.body.agent.name).toBe('Agent Smith');
    expect(parsed.req.body.agent.role).toBe('analyst');
    expect(parsed.req.body.agent.model).toBe('claude-3');
    expect(parsed.req.body.config.maxTokens).toBe(4096);
    expect(parsed.req.body.config.temperature).toBe(0.7);
  });
});
