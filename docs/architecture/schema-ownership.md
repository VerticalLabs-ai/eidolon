# Database schema ownership

Eidolon uses a single shared Postgres database described with [Drizzle
ORM]. The schema is owned by exactly one application — the **server** — and
all other applications consume the database indirectly through the server's
REST and WebSocket APIs. No other application defines, migrates, or writes
to database schemas directly.

[Drizzle ORM]: https://orm.drizzle.team

## Ownership model

| Application | Package                | Owns a schema?       | How it accesses data                            |
| ----------- | ---------------------- | -------------------- | ----------------------------------------------- |
| Server      | `server/`              | **Yes — sole owner** | Imports `@eidolon/db` directly; runs migrations |
| UI          | `ui/`                  | No                   | Calls the server REST/WS API                    |
| Desktop     | `packages/desktop/`    | No                   | Calls the server REST/WS API                    |
| MCP server  | `packages/mcp-server/` | No                   | Calls the server REST API                       |

The server is the only application that depends on `@eidolon/db`. The UI,
desktop, and MCP server packages have no Drizzle, schema, or migration
dependencies. They never open a database connection and never issue SQL. This
boundary keeps schema changes centralized and prevents competing definitions
from drifting across applications.

## Where the schema lives

All schema definitions live in `packages/db/src/schema/`. Each file exports
a Drizzle `pgTable` describing one table (or a small group of related
tables). The barrel `packages/db/src/schema/index.ts` re-exports every
table so the server can import them as a single namespace:

```ts
import * as schema from '@eidolon/db';
```

Generated SQL migrations live in `packages/db/drizzle/`. Each migration is a
numbered `.sql` file produced by Drizzle Kit. Migrations are checked into
the repository and applied in order — they are never edited by hand or
applied out of sequence.

## Schema management tools

| Tool                                                      | What it does                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Drizzle ORM](https://orm.drizzle.team)                   | TypeScript-first ORM used in `packages/db` to define tables and build queries                                       |
| [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview) | CLI that introspects the schema and generates SQL migration files                                                   |
| `pnpm db:generate`                                        | Runs `drizzle-kit generate` against `packages/db/src/schema/*` and writes a new migration to `packages/db/drizzle/` |
| `pnpm db:migrate`                                         | Runs `packages/db/src/migrate.ts`, which applies pending migrations to the target database                          |

### Configuration

Drizzle Kit is configured in `packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/*',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '**********************************************/postgres',
  },
});
```

The connection string is resolved at runtime from
`POSTGRES_URL_NON_POOLING` (preferred on Vercel), `DATABASE_URL` (local
convention), or `POSTGRES_URL`, in that order. Migrations use `max: 1`
because Drizzle's migrator acquires an advisory lock on a single connection,
which is incompatible with Supabase's pgBouncer transaction-mode pooler.

## Migration workflow

Follow this workflow whenever a schema change is needed. Only the server
package initiates schema changes.

1. **Edit the schema.** Add or modify a table definition in
   `packages/db/src/schema/`. One file per table is the established
   convention.
2. **Generate the migration.** Run `pnpm db:generate` from the repository
   root. Drizzle Kit diffs the current schema against the last snapshot and
   writes a new numbered `.sql` file under `packages/db/drizzle/`. Review the
   generated SQL to confirm it matches the intent — Drizzle Kit occasionally
   produces destructive operations (e.g., dropping and recreating a column)
   that a manual edit would express as an in-place alteration.
3. **Apply the migration locally.** Ensure Postgres is running
   (`DATABASE_URL` set, Supabase local on `127.0.0.1:55322`) and run
   `pnpm db:migrate`. This applies all pending migrations in order.
4. **Refresh the test template.** If the migration changes table structure,
   drop the test template database so it recreates on the next test run:
   `DROP DATABASE eidolon_test_template`.
5. **Update server code and tests.** Adjust queries, services, and tests in
   `server/src/` to use the new or changed tables.
6. **Commit the schema, migration, and code together.** The schema
   definition, generated migration SQL, and consuming server code should
   land in the same commit so the repository is always in a consistent state.
7. **Deploy.** Migrations run automatically during the Vercel release build
   via `pnpm db:migrate` before the server starts. The migrator prefers
   `POSTGRES_URL_NON_POOLING` to avoid pgBouncer advisory-lock conflicts.

### Rules

- **Never edit a generated migration file.** Once a migration is committed,
  treat it as immutable. If a change is wrong, write a new migration that
  corrects it.
- **Never run migrations from the UI, desktop, or MCP server.** These
  applications do not depend on `@eidolon/db` and must not open database
  connections.
- **Never apply migrations out of order.** The migrator applies pending
  migrations sequentially; do not skip or reorder files.
- **One file per table.** Keep schema files focused on a single table (or a
  tightly coupled group) and re-export from `schema/index.ts`.

## Related documentation

- [Observability runbook](../runbooks/observability.md) — logging, metrics,
  and health checks for the server that owns the schema
- [Incident response runbook](../runbooks/incident.md) — first checks during
  an incident, including database health via `/api/ready`
