import '../server/node_modules/dotenv/config.js';

import postgres from '../server/node_modules/postgres/src/index.js';

import { decryptContent } from '../server/src/services/content-encryption.js';
import { buildSearchText, extractSearchText } from '../server/src/services/search-text.js';

const DEFAULT_BATCH_SIZE = 100;

interface Options {
  dryRun: boolean;
  batchSize: number;
}

interface ArtifactRow {
  id: string;
  type: string;
  title: string;
  content: Record<string, unknown>;
}

function parseOptions(args: string[]): Options {
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    const batchValue =
      arg === '--batch-size'
        ? args[++index]
        : arg.startsWith('--batch-size=')
          ? arg.slice('--batch-size='.length)
          : undefined;
    if (batchValue !== undefined) {
      if (!/^\d+$/.test(batchValue) || Number(batchValue) < 1) {
        throw new Error(`Invalid --batch-size value "${batchValue}". Use a positive integer.`);
      }
      batchSize = Number(batchValue);
      continue;
    }

    throw new Error(`Unknown argument "${arg}". Supported options: --dry-run, --batch-size N.`);
  }

  return { dryRun, batchSize };
}

function contentForArtifact(row: ArtifactRow): Record<string, unknown> {
  return decryptContent(row.content);
}

async function run(options: Options): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to backfill the search index.');
  }

  const sql = postgres(connectionString, { max: 1 });
  try {
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM artifacts
      WHERE search_tsv IS NULL OR search_text IS NULL
    `;
    const eligible = Number(count);
    console.log(`Found ${eligible} artifact(s) requiring search index backfill.`);

    if (options.dryRun) {
      console.log('Dry run: no rows were changed.');
      return;
    }

    let lastId = '';
    let processed = 0;
    let skipped = 0;

    while (true) {
      const rows = await sql<ArtifactRow[]>`
        SELECT id, type, title, content
        FROM artifacts
        WHERE id > ${lastId}
          AND (search_tsv IS NULL OR search_text IS NULL)
        ORDER BY id
        LIMIT ${options.batchSize}
      `;
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        lastId = row.id;
        try {
          const contentText = extractSearchText(
            row.type as Parameters<typeof extractSearchText>[0],
            contentForArtifact(row) as Parameters<typeof extractSearchText>[1],
          );
          const searchText = buildSearchText(row.title, contentText);

          await sql`
            UPDATE artifacts
            SET search_text = ${searchText},
                search_tsv = setweight(to_tsvector('english', ${row.title}), 'A')
                  || setweight(to_tsvector('english', ${contentText}), 'B')
            WHERE id = ${row.id}
              AND (search_tsv IS NULL OR search_text IS NULL)
          `;
          processed += 1;
        } catch (error) {
          skipped += 1;
          console.error(
            `Skipping artifact ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      console.log(`Processed ${processed}/${eligible} artifact(s); skipped ${skipped}.`);
    }

    const [{ count: remaining }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM artifacts
      WHERE search_tsv IS NULL OR search_text IS NULL
    `;
    console.log(
      `Backfill complete: processed ${processed}, skipped ${skipped}, remaining ${Number(remaining)}.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await run(parseOptions(process.argv.slice(2)));
} catch (error) {
  console.error(
    `Search index backfill failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
