import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import * as schema from '@eidolon/db';
import type { DbInstance } from './types.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../packages/db/drizzle');
const TEMPLATE_DB = 'eidolon_test_template';

// Load ONLY DATABASE_URL from .env. We must not load other env vars
// (CLERK_SECRET_KEY, AUTH_MODE, etc.) because they change auth/CSRF
// middleware behavior in tests. The previous PGlite approach loaded no
// env files at all — tests rely on AUTH_MODE being set by createTestApp()
// and other auth vars being absent.
if (!process.env.DATABASE_URL) {
  const envPath = path.resolve(__dirname, '../../.env');
  if (existsSync(envPath)) {
    const parsed = dotenv.parse(readFileSync(envPath));
    if (parsed.DATABASE_URL) {
      process.env.DATABASE_URL = parsed.DATABASE_URL;
    }
  }
}

/**
 * Module-level singleton state for the test database.
 *
 * Each Vitest test file runs in its own fork (worker process), so these
 * module-level variables are scoped to a single file. The first
 * `createTestDb()` call clones the template database, stores the result,
 * and subsequent calls TRUNCATE all tables (a fast reset). `closeTestDb()`
 * drops the database and closes the postgres.js pools.
 *
 * Database-per-file isolation is used because several test files query
 * `information_schema` and `pg_catalog` without filtering by schema. A
 * dedicated database per file gives the same strong isolation that PGlite
 * provided. A template database (`eidolon_test_template`) with all
 * migrations pre-applied is cloned per file, eliminating per-file migration
 * overhead and reducing Postgres server I/O load.
 *
 * Real Postgres communicates via TCP (non-blocking), eliminating the WASM
 * event-loop stalls that corrupted supertest HTTP requests with PGlite.
 */
let _client: ReturnType<typeof postgres> | null = null;
let _mgmtClient: ReturnType<typeof postgres> | null = null;
let _dbInstance: DbInstance | null = null;
let _testDbName: string | null = null;

/**
 * Derive a database URL string from `sourceUrl` with the database path set
 * to `/${dbName}`. Uses real URL parsing (not regex string-surgery) so
 * query strings, trailing slashes, and non-`postgres` database names in
 * the source URL are handled correctly — the previous `.replace(...)`
 * approach silently failed for those cases, leaving the URL pointing at
 * the ORIGINAL database (which was then TRUNCATEd/cloned). Search params
 * are preserved. Throws if `sourceUrl` is not a parseable URL.
 */
function withDatabase(sourceUrl: string, dbName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(
      `withDatabase: DATABASE_URL is not a valid URL: ${sourceUrl}`,
    );
  }
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function getTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Ensure .env is present at the repo root.',
    );
  }
  const mgmtUrl = withDatabase(url, 'eidolon_test');
  // Fail closed: the management database name MUST be exactly 'eidolon_test'.
  // This guards against misconfiguration that could point destructive
  // operations (TRUNCATE/clone/DROP) at the wrong database.
  const dbName = new URL(mgmtUrl).pathname.replace(/^\/+/, '');
  if (dbName !== 'eidolon_test') {
    throw new Error(
      `getTestDatabaseUrl: management database must be exactly 'eidolon_test', got '${dbName}'`,
    );
  }
  return mgmtUrl;
}

/**
 * Restore postgres.js timestamp serializers that drizzle-orm overrides
 * with a transparent pass-through. Without this, raw SQL queries
 * (db.execute(sql`...`)) that pass Date objects fail because the Date
 * reaches the Bind message unserialized.
 */
function restoreDateSerializers(client: ReturnType<typeof postgres>): void {
  const dateSerializer = (x: unknown): string =>
    (x instanceof Date ? x : new Date(x as string)).toISOString();
  for (const type of [1184, 1082, 1083, 1114, 1182, 1185, 1115]) {
    client.options.serializers[type] = dateSerializer;
  }
}

/**
 * Wrap the drizzle instance's execute method to add a non-enumerable .rows
 * property to resolved arrays, matching PGlite's return shape for
 * compatibility with test helpers that access result.rows.
 */
function wrapExecute(drizzleDb: ReturnType<typeof drizzle>): void {
  const originalExecute = drizzleDb.execute.bind(drizzleDb);
  (drizzleDb as unknown as { execute: (query: unknown) => unknown }).execute =
    function (query: unknown) {
      const raw = originalExecute(query as never) as {
        then: (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise<unknown>;
      };
      const originalThen = raw.then.bind(raw);
      raw.then = (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) =>
        originalThen(
          (result: unknown) => {
            if (
              Array.isArray(result) &&
              (result as { rows?: unknown }).rows === undefined
            ) {
              Object.defineProperty(result, 'rows', {
                value: result,
                enumerable: false,
                configurable: true,
              });
            }
            return onFulfilled ? onFulfilled(result) : result;
          },
          onRejected,
        );
      return raw;
    };
}

/**
 * Ensure the template database exists with all migrations applied. Uses a
 * Postgres advisory lock for cross-fork coordination: the first fork to
 * acquire the lock creates the template; concurrent forks wait and find it
 * already present. The template is marked IS_TEMPLATE=true,
 * ALLOW_CONNECTIONS=false so it can be cloned without interference.
 */
async function ensureTemplateDatabase(
  mgmtClient: ReturnType<typeof postgres>,
): Promise<void> {
  // Advisory lock prevents concurrent template creation across forks.
  await mgmtClient.unsafe('SELECT pg_advisory_lock(778899)');
  try {
    const existing = await mgmtClient`
      SELECT 1 FROM pg_database WHERE datname = ${TEMPLATE_DB}
    `;
    if (existing.length > 0) {
      // Template exists — assume migrations are current. If migrations
      // change, drop eidolon_test_template manually and it will be
      // recreated on the next run.
      return;
    }

    // Create the template database.
    await mgmtClient.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);

    // Connect to the template, run migrations, then disconnect.
    const baseUrl = getTestDatabaseUrl();
    const templateUrl = withDatabase(baseUrl, TEMPLATE_DB);
    const templateClient = postgres(templateUrl, { max: 1 });
    try {
      restoreDateSerializers(templateClient);
      const templateDb = drizzle(templateClient);
      await migrate(templateDb, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await templateClient.end();
    }

    // Mark as template so it can be cloned without active connections.
    await mgmtClient.unsafe(
      `ALTER DATABASE "${TEMPLATE_DB}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    );
  } finally {
    await mgmtClient.unsafe('SELECT pg_advisory_unlock(778899)');
  }
}

/**
 * TRUNCATE every user table in the `public` schema with `RESTART IDENTITY
 * CASCADE`. Excludes `__drizzle_migrations` so the migrator doesn't re-run.
 */
async function resetTestDb(): Promise<void> {
  if (!_client) return;

  const rows = await _client`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename != '__drizzle_migrations'
    ORDER BY tablename
  `;

  const tables = rows.map((row) => row.tablename as string);
  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"public"."${t}"`).join(', ');
  await _client.unsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Create a test database instance backed by real Postgres.
 *
 * Uses a module-level singleton with database-per-file isolation: the first
 * call per test file clones the template database (fast — no migrations),
 * stores the result, and subsequent calls TRUNCATE all public-schema tables
 * (a fast reset, ~5-20ms) and return the same `DbInstance`.
 */
export async function createTestDb(): Promise<DbInstance> {
  if (_dbInstance && _client) {
    await resetTestDb();
    return _dbInstance;
  }

  const testDbName = `eidolon_test_${randomUUID().replace(/-/g, '_')}`;
  const baseUrl = getTestDatabaseUrl();

  // Management client for CREATE/DROP DATABASE and template coordination.
  const mgmtClient = postgres(baseUrl, { max: 1 });

  // Ensure the template database exists (creates it on first run).
  await ensureTemplateDatabase(mgmtClient);

  // Clone the template — much faster than running 18 migrations.
  await mgmtClient.unsafe(
    `CREATE DATABASE "${testDbName}" TEMPLATE "${TEMPLATE_DB}"`,
  );

  // Test client — connects to the per-file database.
  const testUrl = withDatabase(baseUrl, testDbName);
  const client = postgres(testUrl, {
    max: 3,
    connect_timeout: 30,
    idle_timeout: 30,
    prepare: false,
  });

  try {
    const drizzleDb = drizzle(client);
    restoreDateSerializers(client);
    wrapExecute(drizzleDb);

    const instance: DbInstance = { drizzle: drizzleDb, schema };
    _client = client;
    _mgmtClient = mgmtClient;
    _testDbName = testDbName;
    _dbInstance = instance;

    return instance;
  } catch (error) {
    await client.end();
    await mgmtClient.unsafe(
      `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`,
    );
    await mgmtClient.end();
    throw error;
  }
}

/**
 * Drop the test database and close all postgres.js pools.
 *
 * Registered as an `afterAll` hook via `server/src/test-setup.ts` so each
 * test file releases its database and connections before the worker exits.
 */
export async function closeTestDb(): Promise<void> {
  if (_client) {
    await _client.end();
  }
  if (_mgmtClient && _testDbName) {
    await _mgmtClient.unsafe(
      `DROP DATABASE IF EXISTS "${_testDbName}" WITH (FORCE)`,
    );
    await _mgmtClient.end();
  }
  _client = null;
  _mgmtClient = null;
  _dbInstance = null;
  _testDbName = null;
}

/**
 * Create an Express app wired to the given test database instance.
 */
export function createTestApp(db: DbInstance, authMode = 'local_trusted') {
  const previousAuthMode = process.env.AUTH_MODE;

  try {
    process.env.AUTH_MODE = authMode;
    return createApp(db);
  } finally {
    if (previousAuthMode === undefined) {
      delete process.env.AUTH_MODE;
    } else {
      process.env.AUTH_MODE = previousAuthMode;
    }
  }
}

/**
 * Module-level set of all http.Server instances created by
 * `createTestServer`. Cleared by `closeTestServers()` which is called in
 * the `afterEach` hook in `test-setup.ts` so no listening server leaks
 * across tests.
 */
const _testServers = new Set<http.Server>();

/**
 * Per-fork deterministic port block for `createTestServer`.
 *
 * Cross-fork ephemeral TCP port reuse was the root cause of the residual
 * HTTP response desync under parallel forks (Stage 4): fork A closes a
 * server's port, the OS reassigns it to fork B's new server, and a
 * lingering client socket from A hits B's server → garbled HTTP (501 from
 * Node's parser, or a foreign 404/200 response). To prevent this, each
 * Vitest fork gets a DISJOINT 1000-port block derived from the per-fork id
 * (`process.env.VITEST_POOL_ID`, 1-based): `base = 20000 + poolId * 1000`.
 * Ports are handed out sequentially within the block. Within-fork reuse is
 * safe because servers are created and fully closed serially via
 * `closeAllConnections()` + `close()` (only CROSS-fork reuse must be
 * prevented). On `EADDRINUSE` the next port in the block is tried.
 * Servers bind explicitly to `127.0.0.1`.
 */
const PORT_BLOCK_BASE = 20_000;
const PORT_BLOCK_SIZE = 1000;

function getForkPortBase(): number {
  // VITEST_POOL_ID is 1-based in Vitest's forks pool. Default to 1 when
  // unset (e.g. a single-fork run or running outside the pool) — there is
  // no other fork to collide with in that case.
  const poolId = Number(process.env.VITEST_POOL_ID) || 1;
  return PORT_BLOCK_BASE + poolId * PORT_BLOCK_SIZE;
}

/** Sequential port cursor within this fork's block. */
let _forkPortOffset = 0;

/**
 * Bind `server` to `127.0.0.1` on an available port within this fork's
 * port block. Tries the next port in the block on `EADDRINUSE`.
 */
function listenInForkBlock(server: http.Server): Promise<void> {
  const base = getForkPortBase();
  return new Promise<void>((resolve, reject) => {
    // Wrap-scan: try up to PORT_BLOCK_SIZE DISTINCT offsets modulo the
    // block size before reporting exhaustion. A fork whose cursor has
    // advanced near the end of the block must still find free low ports
    // by wrapping around to the start of the block.
    const start = _forkPortOffset % PORT_BLOCK_SIZE;
    let attempted = 0;
    const tryListen = (offset: number): void => {
      if (attempted >= PORT_BLOCK_SIZE) {
        reject(
          new Error(
            `createTestServer: no available port in fork block ${base}-${base + PORT_BLOCK_SIZE - 1}`,
          ),
        );
        return;
      }
      attempted += 1;
      const port = base + offset;
      const onListening = (): void => {
        server.off('error', onError);
        // Advance the cursor past the port we just bound.
        _forkPortOffset = (offset + 1) % PORT_BLOCK_SIZE;
        resolve();
      };
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          tryListen((offset + 1) % PORT_BLOCK_SIZE);
        } else {
          reject(err);
        }
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(port, '127.0.0.1');
    };
    tryListen(start);
  });
}

/**
 * Create a persistent listening `http.Server` wrapping an Express app built
 * via `createTestApp`.
 *
 * supertest's `request(server)` reuses an already-listening server instead
 * of creating + listening + closing a new `http.Server` per request. The
 * per-request `listen(0)`/`close()` churn was the root cause of
 * non-deterministic HTTP response desync on macOS + Node 24 (wrong status
 * codes, socket hang up). Handing supertest a persistent listening server
 * eliminates that churn entirely.
 *
 * The server is tracked in a module-level set for teardown via
 * `closeTestServers()`. The underlying Express app is attached as
 * `server.app` for convenience (e.g. reading Express settings).
 */
export async function createTestServer(
  db: DbInstance,
  authMode = 'local_trusted',
): Promise<http.Server> {
  const app = createTestApp(db, authMode);
  const server = http.createServer(app);
  // Bind to a deterministic port within this fork's disjoint port block
  // (see listenInForkBlock). This eliminates cross-fork ephemeral port
  // reuse — the root cause of residual HTTP response desync under parallel
  // forks — while keeping supertest's server-reuse behavior intact.
  await listenInForkBlock(server);
  (server as unknown as { app: typeof app }).app = app;
  _testServers.add(server);
  return server;
}

/**
 * Close every server created via `createTestServer` and clear the tracking
 * set. Called in the `afterEach` hook in `test-setup.ts` so no listening
 * server leaks across tests (a file may create up to 7 servers per test via
 * nested `describe` `beforeEach` hooks).
 */
export async function closeTestServers(): Promise<void> {
  const servers = Array.from(_testServers);
  _testServers.clear();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (server.listening) {
            // Destroy all open connections (keep-alive, in-flight) so
            // server.close() resolves immediately without waiting for
            // socket timeouts.  Available since Node 18.2.
            server.closeAllConnections?.();
            server.close(() => resolve());
          } else {
            resolve();
          }
        }),
    ),
  );
}
