import type * as EidolonDb from "@eidolon/db";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

/** Table exports from `@eidolon/db` (excludes `createDb` / `DbInstance`). */
export type EidolonDbSchema = Omit<typeof EidolonDb, "createDb" | "DbInstance">;

/**
 * Abstraction over the database instance used throughout the server.
 */
export interface DbInstance {
  drizzle: BetterSQLite3Database;
  schema: EidolonDbSchema;
}
