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

export async function setup(): Promise<void> {
  const baseUrl = loadDatabaseUrl();
  if (!baseUrl) {
    throw new Error(
      'test-global-setup: DATABASE_URL is not set. Ensure .env is present at the repo root.',
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error('test-global-setup: DATABASE_URL is not a valid URL.');
  }

  const host = parsedUrl.hostname.toLowerCase();
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const allowDrops = process.env.EIDOLON_ALLOW_TEST_DB_DROPS === 'true';
  const allowRemoteDrops = process.env.EIDOLON_ALLOW_REMOTE_TEST_DB_DROPS === 'true';
  if (!allowDrops || (!isLocalHost && !allowRemoteDrops)) {
    console.warn(
      `test-global-setup: skipping orphan database cleanup for ${host}; ` +
        'set EIDOLON_ALLOW_TEST_DB_DROPS=true (and, for remote hosts, ' +
        'EIDOLON_ALLOW_REMOTE_TEST_DB_DROPS=true) to enable it.',
    );
    return;
  }
  console.info(`test-global-setup: cleaning orphan test databases on ${host}`);

  // Connect to the eidolon_test management database (never to a per-file db).
  parsedUrl.pathname = '/eidolon_test';
  const mgmtUrl = parsedUrl.toString();

  const orphanList = psql(
    mgmtUrl,
    `SELECT datname FROM pg_database
       WHERE datname LIKE 'eidolon_test_%'
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
