import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { repairSkippedProjectMigrations } from './migration-repair.js';

const migrationsFolder = resolve(import.meta.dirname, '../drizzle');
const skipped = [13, 15, 16, 17];

describe('historical project migration recovery', () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let databaseName: string;
  let legacyFolder: string;

  beforeEach(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Migration recovery tests require local PostgreSQL');
    }
    databaseName = `eidolon_migration_repair_${randomUUID().replaceAll('-', '_')}`;
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 1, onnotice: () => {} });
    legacyFolder = mkdtempSync(join(tmpdir(), 'eidolon-legacy-migrations-'));
    cpSync(migrationsFolder, legacyFolder, { recursive: true });
    const journalPath = join(legacyFolder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx <= 28 && !skipped.includes(entry.idx),
    );
    writeFileSync(journalPath, JSON.stringify(journal));
  });

  afterEach(async () => {
    await client?.end();
    if (admin && databaseName) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
    if (legacyFolder) {
      rmSync(legacyFolder, { recursive: true, force: true });
    }
  });

  it('leaves a fresh database to the normal migrator', async () => {
    expect(await repairSkippedProjectMigrations(client, migrationsFolder)).toEqual([]);
    await migrate(drizzle(client), { migrationsFolder });
    expect(await repairSkippedProjectMigrations(client, migrationsFolder)).toEqual([]);
    const [column] = await client`SELECT data_type FROM information_schema.columns
      WHERE table_name = 'research_provider_health' AND column_name = 'open_until_ms'`;
    expect(column!.data_type).toBe('bigint');
  });

  it('repairs the deployed ledger gaps, upgrades fully, and is repeatable', async () => {
    await migrate(drizzle(client), { migrationsFolder: legacyFolder });
    const repaired = await repairSkippedProjectMigrations(client, migrationsFolder);
    expect(repaired).toEqual([
      '0013_bizarre_millenium_guard',
      '0015_reflective_brood',
      '0016_certain_marvex',
      '0017_redundant_maelstrom',
    ]);
    await migrate(drizzle(client), { migrationsFolder });
    expect(await repairSkippedProjectMigrations(client, migrationsFolder)).toEqual([]);
    const [row] = await client`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(row!.count).toBe(55);
    const tables = await client`SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('project_threads', 'project_outcomes', 'automation_runs', 'mission_runs')`;
    expect(tables).toHaveLength(4);
  });

  it('rolls back all recovery DDL and ledger entries on an unexpected partial schema', async () => {
    await migrate(drizzle(client), { migrationsFolder: legacyFolder });
    await client`CREATE TABLE project_outcomes (id text)`;
    await expect(repairSkippedProjectMigrations(client, migrationsFolder)).rejects.toThrow();
    const [row] = await client`SELECT to_regclass('public.project_threads') AS threads,
      (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations`;
    expect(row!.threads).toBeNull();
    expect(row!.migrations).toBe(25);
  });
});
