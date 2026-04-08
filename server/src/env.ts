/**
 * Environment loader — must be imported before anything that reads process.env.
 *
 * Loads .env from the monorepo root regardless of the current working directory,
 * so `pnpm --filter server dev` (which runs inside server/) still picks up the
 * root-level .env file.
 */
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Try multiple paths to find .env (handles tsx from server/, compiled from dist/, etc.)
const candidates = [
  path.resolve(__dirname, '../../.env'),   // from server/src/ -> root
  path.resolve(__dirname, '../../../.env'), // from server/dist/ -> root
  path.resolve(process.cwd(), '.env'),     // cwd fallback
  path.resolve(process.cwd(), '../.env'),  // cwd is server/, parent is root
];

for (const envPath of candidates) {
  if (existsSync(envPath)) {
    const result = dotenv.config({ path: envPath, override: true });
    if (!result.error) {
      // eslint-disable-next-line no-console
      console.log(`[env] Loaded ${Object.keys(result.parsed ?? {}).length} vars from ${envPath}`);
      break;
    }
  }
}
