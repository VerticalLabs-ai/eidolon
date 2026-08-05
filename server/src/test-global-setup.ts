import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest globalSetup — runs once before the test suite starts.
 *
 * Drops orphaned `eidolon_test_*` databases left behind by crashed/interrupted
 * test runs. Each test file clones `eidolon_test_template` into a unique
 * `eidolon_test_<uuid>` database and drops it in `afterAll`; a crash can leave
 * those databases behind, accumulating connection pressure on the Postgres
 * server and causing contention for subsequent runs.
 *
 * Uses `psql` via child_process and parses `.env` manually (no external deps)
 * because the globalSetup file is loaded by vitest's vite-node runner from the
 * repo root, where workspace dependencies (`postgres`, `dotenv`) are not
 * directly resolvable.
 *
 * NEVER drops `postgres`, `_supabase`, `eidolon_test`, `eidolon_test_template`,
 * `template0`, or `template1`.
 */
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(__dirname, '../../.env');
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      if (key !== 'DATABASE_URL') continue;
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes if present.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env.DATABASE_URL = value;
      return value;
    }
  }
  return undefined;
}

/** Databases that must never be dropped. */
const PROTECTED_DATABASES = new Set([
  'postgres',
  '_supabase',
  'eidolon_test',
  'eidolon_test_template',
  'template0',
  'template1',
]);

function psql(mgmtUrl: string, sql: string): string {
  // Use spawnSync with an args array (no shell) to avoid all shell-quoting
  // issues with connection strings and multi-line SQL.
  const result = spawnSync(
    'psql',
    [mgmtUrl, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    const stderr = result.stderr ?? '';
    throw new Error(`psql failed (status ${result.status}): ${stderr.trim()}`);
  }
  return (result.stdout ?? '').trim();
}

/**
 * Derive a database URL string from `sourceUrl` with the database path set
 * to `/${dbName}` using real URL parsing (not regex string-surgery) so
 * query strings, trailing slashes, and non-`postgres` database names are
 * handled correctly. Search params are preserved. Throws if `sourceUrl`
 * is not a parseable URL. Mirrors the `withDatabase` helper in
 * test-utils.ts (this file cannot import it because it is loaded by
 * vitest's vite-node runner from the repo root where workspace deps are
 * not directly resolvable).
 */
function withDatabaseUrl(sourceUrl: string, dbName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(
      `test-global-setup: DATABASE_URL is not a valid URL: ${sourceUrl}`,
    );
  }
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** Local Postgres hosts that are safe for destructive cleanup. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export async function setup(): Promise<void> {
  const baseUrl = loadDatabaseUrl();
  if (!baseUrl) {
    throw new Error(
      'test-global-setup: DATABASE_URL is not set. Ensure .env is present at the repo root.',
    );
  }

  // Parse DATABASE_URL to enforce DB-safety guards BEFORE any destructive
  // operation. The previous code derived the management URL with a fragile
  // `.replace(/\/postgres$/, '/eidolon_test')` regex and performed no host
  // check — destructive if pointed at a shared/staging/prod Postgres.
  let sourceParsed: URL;
  try {
    sourceParsed = new URL(baseUrl);
  } catch {
    throw new Error(
      `test-global-setup: DATABASE_URL is not a valid URL: ${baseUrl}`,
    );
  }

  // Derive the management URL safely and require its database name to be
  // exactly 'eidolon_test' (fail closed).
  const mgmtUrl = withDatabaseUrl(baseUrl, 'eidolon_test');
  const mgmtDbName = new URL(mgmtUrl).pathname.replace(/^\/+/, '');
  if (mgmtDbName !== 'eidolon_test') {
    throw new Error(
      `test-global-setup: management database must be exactly 'eidolon_test', got '${mgmtDbName}'`,
    );
  }

  // Host guard: refuse destructive cleanup (terminate/DROP) on non-local
  // Postgres hosts unless explicitly opted in via
  // EIDOLON_TEST_ALLOW_REMOTE_DB=1.
  const host = sourceParsed.hostname;
  const isLocal = LOCAL_HOSTS.has(host);
  const allowRemote = process.env.EIDOLON_TEST_ALLOW_REMOTE_DB === '1';
  if (!isLocal && !allowRemote) {
    throw new Error(
      `test-global-setup: refusing destructive cleanup on non-local Postgres host '${host}'. ` +
        `Set EIDOLON_TEST_ALLOW_REMOTE_DB=1 to override.`,
    );
  }

  // Escape the '_' wildcard in the LIKE pattern so it matches a literal
  // underscore (not any single character), keeping the match set tight.
  // PROTECTED_DATABASES guard below still wins for any protected name.
  const orphanList = psql(
    mgmtUrl,
    `SELECT datname FROM pg_database
       WHERE datname LIKE 'eidolon\\_test\\_%' ESCAPE '\\'
         AND datname NOT IN ('eidolon_test_template')
       ORDER BY datname`,
  );

  if (!orphanList) return;

  for (const datname of orphanList.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (PROTECTED_DATABASES.has(datname)) continue;
    // Terminate any lingering connections before dropping (with FORCE).
    try {
      psql(
        mgmtUrl,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = '${datname.replace(/'/g, "''")}'
             AND pid <> pg_backend_pid()`,
      );
    } catch {
      // Termination is best-effort; WITH (FORCE) below handles active sessions.
    }
    psql(mgmtUrl, `DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
}

export async function teardown(): Promise<void> {
  // No teardown needed — per-file databases are dropped by closeTestDb().
}
