import type * as EidolonDb from "@eidolon/db";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Table exports from `@eidolon/db` (excludes `createDb` / `DbInstance`). */
export type EidolonDbSchema = Omit<typeof EidolonDb, "createDb" | "DbInstance">;

/**
 * Abstraction over the database instance used throughout the server.
 *
 * Widened to the common `PgDatabase` base so both postgres.js (production)
 * and pglite (tests) satisfy this type. All routes use the standard Drizzle
 * query builder, which is identical across both drivers.
 */
export interface DbInstance {
  drizzle: PgDatabase<PgQueryResultHKT, Record<string, never>>;
  schema: EidolonDbSchema;
}
