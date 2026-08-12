import { sql } from 'drizzle-orm';
import { getServer } from '../bootstrap.js';
import { decryptContent } from '../services/content-encryption.js';
import { extractSearchText, buildSearchText, buildSearchTsvSql } from '../services/search-text.js';
import type { z } from 'zod';
import { ArtifactTypeSchema } from '@eidolon/shared';

const BATCH_SIZE = 100;
type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

type Row = { id: string; type: ArtifactType; title: string; content: Record<string, unknown> };

// Idempotent and resumable: only rows still missing either index column are read.
const { db, client } = await getServer({ runMigrations: true, maxConnections: 2 });
try {
  let updated = 0;
  for (;;) {
    const result = await db.drizzle.execute(sql`
      SELECT id, type, title, content
      FROM artifacts
      WHERE search_tsv IS NULL OR search_text IS NULL
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    `);
    const rows = result as unknown as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const contentText = extractSearchText(row.type, decryptContent(row.content));
      await db.drizzle.execute(sql`
        UPDATE artifacts
        SET search_text = ${buildSearchText(row.title, contentText)},
            search_tsv = ${buildSearchTsvSql(row.title, contentText)}
        WHERE id = ${row.id}
          AND (search_tsv IS NULL OR search_text IS NULL)
      `);
      updated += 1;
    }
    console.log(`Backfilled ${updated} artifact search indexes`);
  }
  console.log(`Artifact search backfill complete: ${updated} rows updated`);
} finally {
  await client.end();
}
