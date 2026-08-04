#!/usr/bin/env tsx
/**
 * Cleanup script for test fixture companies.
 *
 * Connects to the dev DB using postgres.js and DATABASE_URL from .env.
 *
 * Usage:
 *   pnpm cleanup:fixtures                         # Dry-run (default)
 *   pnpm cleanup:fixtures -- --execute            # Delete all tagged fixtures
 *   pnpm cleanup:fixtures -- --stale-hours 6      # Only fixtures older than 6h
 *   pnpm cleanup:fixtures -- --execute --stale-hours 6  # Combined
 *
 * The script defaults to dry-run — it lists tagged fixtures and reports
 * per-table row counts that would be deleted without modifying anything.
 * Deletion criteria is exclusively `settings @> '{"testFixture": true}'`.
 * Non-public schemas (drizzle, auth, storage, vault) are never touched.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from 'dotenv';
import postgres from 'postgres';
import { runCleanup, type SqlRunner, type CleanupOptions } from '../src/cleanup/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (two levels up from server/scripts/).
config({ path: resolve(__dirname, '../../.env') });

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): CleanupOptions {
  const options: CleanupOptions = { execute: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Skip the "--" separator that pnpm/npm inserts between script and user args.
    if (arg === '--') continue;
    if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--stale-hours') {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error('Error: --stale-hours requires a numeric argument');
        process.exit(1);
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error(`Error: --stale-hours must be a positive number, got "${value}"`);
        process.exit(1);
      }
      options.staleHours = parsed;
      i++; // consume the value
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage: pnpm cleanup:fixtures [-- --execute] [-- --stale-hours N]',
          '',
          'Options:',
          '  --execute        Perform actual deletion (default: dry-run)',
          '  --stale-hours N  Only remove fixtures older than N hours',
          '  --help, -h       Show this help message',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      console.error(`Error: unknown argument "${arg}"`);
      process.exit(1);
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// SqlRunner backed by postgres.js
// ---------------------------------------------------------------------------

function createPostgresRunner(connectionString: string): { runner: SqlRunner; close: () => Promise<void> } {
  const sql = postgres(connectionString, { max: 1 });

  const runner: SqlRunner = {
    async query(text) {
      return sql.unsafe(text);
    },
    async begin(fn) {
      return sql.begin(async (tx) => {
        const txRunner: SqlRunner = {
          async query(text) {
            return tx.unsafe(text);
          },
          // Nested transactions are not needed for cleanup; delegate to the
          // current transaction context.
          begin(fn2) {
            return fn2(txRunner);
          },
        };
        return fn(txRunner);
      });
    },
  };

  return { runner, close: () => sql.end({ timeout: 5 }) };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatResult(result: Awaited<ReturnType<typeof runCleanup>>): string {
  const lines: string[] = [];

  if (result.mode === 'dry-run') {
    lines.push('=== Dry-run mode (no changes will be made) ===');
  } else {
    lines.push('=== Execute mode ===');
  }

  lines.push('');

  if (result.fixtureDetails.length === 0) {
    lines.push('No tagged fixtures found.');
    lines.push('');
    lines.push('Summary: 0 fixtures, 0 rows.');
    return lines.join('\n');
  }

  lines.push(`Found ${result.fixtureDetails.length} tagged fixture(s):`);
  for (const f of result.fixtureDetails) {
    lines.push(`  - ${f.name} (id: ${f.id}, created: ${f.createdAt})`);
  }
  lines.push('');

  const verb = result.mode === 'dry-run' ? 'Would delete' : 'Deleted';
  lines.push(`${verb} per-table row counts:`);

  let totalRows = 0;
  for (const { table, count } of result.tableCounts) {
    if (count > 0 || table === 'companies') {
      lines.push(`  ${table}: ${count}`);
    }
    totalRows += count;
  }

  lines.push('');
  const actionWord = result.mode === 'dry-run' ? 'would be ' : '';
  lines.push(`Summary: ${result.companyCount} fixture(s), ${totalRows} total rows ${actionWord}deleted.`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const connectionString =
    process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    console.error(
      'Error: No database connection string found. Set DATABASE_URL in .env.',
    );
    process.exit(1);
  }

  const { runner, close } = createPostgresRunner(connectionString);

  try {
    const result = await runCleanup(runner, options);
    console.log(formatResult(result));
  } catch (err) {
    console.error('Cleanup failed:', err instanceof Error ? err.message : err);
    await close().catch(() => {});
    process.exit(1);
  }

  await close().catch(() => {});
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
