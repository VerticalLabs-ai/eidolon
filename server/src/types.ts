import type * as EidolonDb from '@eidolon/db';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Sql } from 'postgres';

/** Table exports from `@eidolon/db` (excludes non-table helpers). */
export type EidolonDbSchema = Omit<
  typeof EidolonDb,
  'createDb' | 'DbInstance' | 'schema' | 'resolveConnectionString'
>;

/**
 * Abstraction over the database instance used throughout the server.
 *
 * Widened to the common `PgDatabase` base so both postgres.js (production)
 * and pglite (tests) satisfy this type. All routes use the standard Drizzle
 * query builder, which is identical across both drivers.
 *
 * `client` is the raw postgres.js `Sql` instance. It is optional because
 * not every code path needs direct (non-Drizzle) access. The SSE stream
 * service uses it for Postgres LISTEN/NOTIFY push delivery (VAL-M1-072).
 * When absent, the stream falls back to polling-only mode (VAL-M1-073).
 */
export interface DbInstance {
  drizzle: PgDatabase<PgQueryResultHKT, Record<string, never>>;
  schema: EidolonDbSchema;
  /** Raw postgres.js client for LISTEN/NOTIFY. Optional — stream falls back to polling. */
  client?: Sql;
}
