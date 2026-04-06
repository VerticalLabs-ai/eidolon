import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as schema from './schema/index.js';

export * from './schema/index.js';

export interface DbInstance {
  db: ReturnType<typeof drizzle<typeof schema>>;
  connection: Database.Database;
}

/**
 * Create a database instance backed by SQLite via better-sqlite3.
 *
 * @param filePath - Absolute or relative path to the SQLite file.
 *   Defaults to `eidolon-data/eidolon.db` resolved from `process.cwd()`.
 * @returns The Drizzle ORM `db` handle and the raw `better-sqlite3` connection.
 */
export function createDb(filePath?: string): DbInstance {
  // Default to <project-root>/data/eidolon.db regardless of CWD
  const resolved = filePath
    ? resolve(filePath)
    : resolve(import.meta.dirname ?? '.', '../../..', 'data', 'eidolon.db');

  // Ensure the parent directory exists
  mkdirSync(dirname(resolved), { recursive: true });

  const connection = new Database(resolved);

  // Enable WAL mode for better concurrent read performance
  connection.pragma('journal_mode = WAL');
  // Enable foreign key enforcement (off by default in SQLite)
  connection.pragma('foreign_keys = ON');

  const db = drizzle(connection, { schema });

  return { db, connection };
}
