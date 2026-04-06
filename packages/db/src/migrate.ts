import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { createDb } from './index.js';

const { db, connection } = createDb();

console.log('Running migrations...');

migrate(db, {
  migrationsFolder: resolve(import.meta.dirname ?? '.', '..', 'drizzle'),
});

console.log('Migrations complete.');

connection.close();
