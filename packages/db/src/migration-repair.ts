import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { Sql } from 'postgres';

// These project migrations were published with timestamps older than the
// deployed ledger tip. Drizzle's timestamp high-water mark skipped them.
const RECOVERABLE_MIGRATIONS = new Set([
  '0013_bizarre_millenium_guard',
  '0015_reflective_brood',
  '0016_certain_marvex',
  '0017_redundant_maelstrom',
]);

/** Apply only the confirmed historical gaps, atomically with their ledger rows. */
export async function repairSkippedProjectMigrations(
  client: Sql,
  migrationsFolder: string,
): Promise<string[]> {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string; when: number }> };
  const migrations = readMigrationFiles({ migrationsFolder });
  const repaired: string[] = [];

  await client.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('eidolon:legacy-project-migrations'))`;
    const [ledger] = await tx`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`;
    if (!ledger?.name) {
      return; // A fresh database is handled entirely by the normal migrator.
    }
    const rows = await tx`SELECT created_at FROM drizzle.__drizzle_migrations`;
    const recorded = new Set(rows.map((row) => Number(row.created_at)));
    const latest = Math.max(0, ...recorded);

    for (const entry of journal.entries) {
      if (
        !RECOVERABLE_MIGRATIONS.has(entry.tag) ||
        entry.when >= latest ||
        recorded.has(entry.when)
      ) {
        continue;
      }
      const migration = migrations.find((item) => item.folderMillis === entry.when);
      if (!migration) {
        throw new Error(`Missing migration source for ${entry.tag}`);
      }
      // Use the original DDL: an unexpected partial schema must fail and roll
      // back, rather than hiding a mismatch with IF NOT EXISTS or dropping data.
      for (const statement of migration.sql) {
        if (statement.trim()) {
          await tx.unsafe(statement);
        }
      }
      await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})`;
      repaired.push(entry.tag);
    }
  });
  return repaired;
}
