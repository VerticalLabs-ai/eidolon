/**
 * Environment loader — must be imported before anything that reads process.env.
 *
 * Loads BOTH `.env.local` and `.env` from the monorepo root, in that order.
 * `.env` takes precedence over `.env.local` (local dev overrides win over
 * the file written by `vercel env pull`), matching our production split:
 *
 *   .env        — gitignored; holds local-only overrides like
 *                 DATABASE_URL pointing at docker Supabase
 *   .env.local  — gitignored; written by `vercel env pull`, holds hosted
 *                 Clerk / Supabase keys for testing against prod env
 *
 * This lets a single `pnpm run dev` invocation mix hosted Clerk keys with
 * a local Postgres pool.
 */
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findMonorepoRoot(): string {
  // Server code can run from server/src/ (tsx) or server/dist/ (built).
  // Walk up looking for the root pnpm-workspace.yaml as a reliable anchor.
  const starts = [
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ];
  for (const start of starts) {
    if (existsSync(path.join(start, 'pnpm-workspace.yaml'))) return start;
  }
  return path.resolve(__dirname, '../..');
}

const root = findMonorepoRoot();
// Order matters: dotenv.config(... override: true) replaces existing keys,
// so load `.env.local` FIRST, then `.env` so `.env` can override.
const loadOrder = [
  path.join(root, '.env.local'),
  path.join(root, '.env'),
];

let loadedAny = false;
for (const envPath of loadOrder) {
  if (!existsSync(envPath)) continue;
  const result = dotenv.config({ path: envPath, override: true });
  if (!result.error) {
    loadedAny = true;
    // eslint-disable-next-line no-console
    console.log(
      `[env] Loaded ${Object.keys(result.parsed ?? {}).length} vars from ${envPath}`,
    );
  }
}

if (!loadedAny) {
  // eslint-disable-next-line no-console
  console.warn(
    `[env] No .env file was loaded. Tried: ${JSON.stringify(loadOrder)}. ` +
      'Set environment variables another way, or create .env in the repo root.',
  );
}
