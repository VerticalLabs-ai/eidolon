#!/usr/bin/env node
// Local launchd entry point. Never starts Docker or changes container state.
/* eslint-disable no-console -- launchd captures these redacted operator messages */
import postgres from 'postgres';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function localDatabaseUrl(env) {
  const value = env.DATABASE_URL ?? env.POSTGRES_URL ?? env.POSTGRES_URL_NON_POOLING;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Configure a valid local DATABASE_URL in the LaunchAgent environment.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('Local startup requires a loopback Postgres URL; refusing a hosted target.');
  }
  return value;
}

export async function probeDatabase(connectionString) {
  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    connection: { statement_timeout: 5000 },
    onnotice: () => {},
  });
  let timer;
  try {
    // A TCP listener alone is not readiness. Require authenticated SQL, bounded
    // even if a peer accepts the socket but never completes the PG handshake.
    await Promise.race([
      client`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Readiness timeout')), 6000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.end({ timeout: 0 });
  }
}

export async function waitForDatabase(
  connectionString,
  { probe = probeDatabase, delay = sleep, log = console.error } = {},
) {
  let retryMs = 5000;
  for (;;) {
    try {
      await probe(connectionString);
      log('[local-startup] Postgres SQL ready; starting Eidolon.');
      return;
    } catch {
      // Never print driver errors or URLs: they can contain credentials.
      log(
        `[local-startup] Waiting for local Postgres; retry in ${retryMs / 1000}s. ` +
          'Check Docker, the Eidolon database, and local credentials. ' +
          'Containers will not be started automatically.',
      );
      await delay(retryMs);
      retryMs = Math.min(retryMs * 2, 60000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // Reuse the app loader: explicit launchd env > .env > .env.local.
    await import('../dist/env.js');
    await waitForDatabase(localDatabaseUrl(process.env));
  } catch {
    console.error(
      '[local-startup] Invalid local configuration or missing server build. ' +
        'Check the LaunchAgent environment and run pnpm build. No database URL is logged.',
    );
    process.exit(1);
  }
  // Same process, so launchd signals go straight to the existing shutdown code.
  // Bootstrap/migration failures remain visible; launchd throttles their retry.
  await import('../dist/index.js');
}
