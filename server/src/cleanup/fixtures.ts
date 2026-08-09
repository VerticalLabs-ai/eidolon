/**
 * Cleanup logic for test fixture companies.
 *
 * This module is importable by both the standalone cleanup script
 * (server/scripts/cleanup-test-fixtures.ts) and vitest tests (PGlite).
 * The {@link SqlRunner} interface abstracts the SQL execution layer so the
 * same logic works with postgres.js (production) and PGlite (tests).
 *
 * Fixture identification uses exclusively the JSONB containment condition
 * `settings @> '{"testFixture": true}'`. Name pattern-matching is never used
 * for deletion decisions.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A minimal SQL runner that works with both postgres.js and PGlite.
 * Both drivers normalise to a `Promise<Row[]>` return shape.
 */
export interface SqlRunner {
  /** Execute a SQL string and return rows. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Run a function inside a transaction. Rolls back on error. */
  begin<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** Options for a cleanup operation. */
export interface CleanupOptions {
  /** If true, perform actual deletion. If false (default), dry-run only. */
  execute: boolean;
  /** If set, only remove fixtures whose created_at is older than N hours. */
  staleHours?: number;
}

/** Per-table count entry. */
export interface TableCount {
  table: string;
  count: number;
}

/** Result of a cleanup operation. */
export interface CleanupResult {
  mode: 'dry-run' | 'execute';
  fixtureIds: string[];
  fixtureDetails: Array<{ id: string; name: string; createdAt: string }>;
  /** Per-table counts (would-be-deleted for dry-run, actually-deleted for execute). */
  tableCounts: TableCount[];
  /** Total companies that were / would be deleted. */
  companyCount: number;
}

// ---------------------------------------------------------------------------
// Table ordering
// ---------------------------------------------------------------------------

/**
 * Indirect children — tables without a direct `company_id` column that must
 * be deleted via a subquery against their parent table. These are deleted
 * first so that the parent rows can be safely removed afterwards.
 */
const INDIRECT_TABLES: ReadonlyArray<{
  table: string;
  childCol: string;
  parentTable: string;
  parentCol: string;
}> = [
  {
    table: 'prompt_versions',
    childCol: 'template_id',
    parentTable: 'prompt_templates',
    parentCol: 'id',
  },
  {
    table: 'approval_comments',
    childCol: 'approval_id',
    parentTable: 'approvals',
    parentCol: 'id',
  },
  {
    // artifact_revisions has no company_id column; it references artifacts
    // via artifact_id. Must be deleted before artifacts (and before agents,
    // since edited_by_agent_id references agents(id) with NO ACTION).
    table: 'artifact_revisions',
    childCol: 'artifact_id',
    parentTable: 'artifacts',
    parentCol: 'id',
  },
];

/**
 * Phase 2 — direct tables with `company_id` that reference agents, tasks,
 * executions, approvals, plans, or project threads via NO ACTION (or CASCADE)
 * foreign keys. These must be deleted *before* their parent rows.
 *
 * `knowledge_chunks` has a denormalised `company_id` (not a FK to companies)
 * and a CASCADE FK to `knowledge_documents`. Deleting by `company_id` first
 * avoids the cascade and lets us count the rows explicitly.
 */
const DIRECT_TABLES_PHASE2: ReadonlyArray<string> = [
  // meeting_tasks + meetings must be deleted before agents: meetings has
  // NO ACTION FKs to agents (created_by_agent_id, summary_generated_by_agent_id).
  // meeting_tasks has a company_id column and CASCADE FKs to meetings + tasks;
  // deleting it explicitly gives accurate per-table counts (vs relying on the
  // cascade from meetings/tasks).
  'meeting_tasks',
  'meetings',
  'knowledge_chunks',
  'task_thread_items',
  'task_checkouts',
  'agent_collaborations',
  'agent_evaluations',
  'agent_memories',
  'agent_config_revisions',
  'agent_files',
  'mcp_tool_calls',
  'agent_runtime_sessions',
  'workspace_lifecycle_events',
  'execution_environments',
  'automation_runs',
  'task_holds',
  'routines',
  'agent_skills',
  'company_skills',
  'approvals',
  'project_decisions',
  'project_outcomes',
  'project_plan_steps',
  'project_plans',
  'project_threads',
  'agent_executions',
  // artifacts must be deleted before agents (created_by_agent_id /
  // last_edited_by_agent_id reference agents(id) with NO ACTION).
  // artifact_revisions are handled as an indirect child via INDIRECT_TABLES.
  'artifacts',
];

/**
 * Phase 3 — remaining direct tables whose only company FK is to `companies`
 * itself (NO ACTION). Safe to delete after all phase-2 rows are gone.
 */
const DIRECT_TABLES_PHASE3: ReadonlyArray<string> = [
  'cost_events',
  'budget_alerts',
  'heartbeats',
  'messages',
  'tasks',
  'goals',
  'workflows',
  'projects',
  'webhooks',
  'secrets',
  'integrations',
  'mcp_servers',
  'inbox_read_states',
  'activity_log',
  'knowledge_documents',
  'prompt_templates',
];

/** Phase 4 — `agents` (referenced by many phase-2 rows) deleted just before companies. */
const DIRECT_TABLES_PHASE4: ReadonlyArray<string> = ['agents'];

/** All direct tables in deletion order (phase 2 → 3 → 4). */
const ALL_DIRECT_TABLES: ReadonlyArray<string> = [
  ...DIRECT_TABLES_PHASE2,
  ...DIRECT_TABLES_PHASE3,
  ...DIRECT_TABLES_PHASE4,
];

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Build the fixture-ID subquery. The ONLY deletion criterion is the JSONB
 * containment condition `settings @> '{"testFixture": true}'`. Name
 * pattern-matching is never used.
 *
 * @internal
 */
export function fixtureSubquery(staleHours?: number): string {
  let sql = `SELECT id FROM companies WHERE settings @> '{"testFixture": true}'`;
  if (staleHours !== undefined && staleHours > 0) {
    // staleHours is parsed from CLI and validated as a finite positive number
    // before reaching this function, so interpolation is safe.
    sql += ` AND created_at < NOW() - INTERVAL '${staleHours} hours'`;
  }
  return sql;
}

/**
 * Find all fixture companies matching the (optionally stale-filtered) subquery.
 * @internal
 */
export async function findFixtures(
  runner: SqlRunner,
  staleHours?: number,
): Promise<Array<{ id: string; name: string; createdAt: string }>> {
  const sub = fixtureSubquery(staleHours);
  const rows = await runner.query<{ id: string; name: string; created_at: string }>(
    `SELECT id, name, created_at FROM companies WHERE id IN (${sub}) ORDER BY created_at`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: String(r.created_at) }));
}

/**
 * Dry-run: count rows per table that *would* be deleted. No modifications.
 * @internal
 */
async function countDryRun(
  runner: SqlRunner,
  staleHours?: number,
): Promise<TableCount[]> {
  const sub = fixtureSubquery(staleHours);
  const counts: TableCount[] = [];

  for (const { table, childCol, parentTable, parentCol } of INDIRECT_TABLES) {
    const rows = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM ${table} WHERE ${childCol} IN (SELECT ${parentCol} FROM ${parentTable} WHERE company_id IN (${sub}))`,
    );
    counts.push({ table, count: parseInt(rows[0]?.count ?? '0', 10) });
  }

  for (const table of ALL_DIRECT_TABLES) {
    const rows = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM ${table} WHERE company_id IN (${sub})`,
    );
    counts.push({ table, count: parseInt(rows[0]?.count ?? '0', 10) });
  }

  const companyRows = await runner.query<{ count: string }>(
    `SELECT count(*) as count FROM companies WHERE id IN (${sub})`,
  );
  counts.push({ table: 'companies', count: parseInt(companyRows[0]?.count ?? '0', 10) });

  return counts;
}

/**
 * Execute: delete all fixture rows in dependency order inside a single
 * transaction. Uses `DELETE ... RETURNING id` for per-table count reporting.
 * Rolls back on any error.
 * @internal
 */
async function executeDeletion(
  runner: SqlRunner,
  staleHours?: number,
): Promise<TableCount[]> {
  const sub = fixtureSubquery(staleHours);
  const counts: TableCount[] = [];

  await runner.begin(async (tx) => {
    // Phase 1 — indirect children via subquery
    for (const { table, childCol, parentTable, parentCol } of INDIRECT_TABLES) {
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM ${table} WHERE ${childCol} IN (SELECT ${parentCol} FROM ${parentTable} WHERE company_id IN (${sub})) RETURNING id`,
      );
      counts.push({ table, count: rows.length });
    }

    // Phase 2-4 — direct tables in dependency order
    for (const table of ALL_DIRECT_TABLES) {
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM ${table} WHERE company_id IN (${sub}) RETURNING id`,
      );
      counts.push({ table, count: rows.length });
    }

    // Phase 5 — companies themselves
    const companyRows = await tx.query<{ id: string }>(
      `DELETE FROM companies WHERE id IN (${sub}) RETURNING id`,
    );
    counts.push({ table: 'companies', count: companyRows.length });
  });

  return counts;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the cleanup operation.
 *
 * - Dry-run (default): lists tagged fixtures and reports per-table row counts
 *   that would be deleted, without modifying the database.
 * - Execute (`options.execute = true`): performs ordered batch deletes in a
 *   single transaction and reports per-table counts of deleted rows.
 * - Stale-hours (`options.staleHours = N`): only considers fixtures older than
 *   N hours.
 *
 * Always exits successfully (returns a result with zero counts) when no
 * fixtures are found.
 */
export async function runCleanup(
  runner: SqlRunner,
  options: CleanupOptions,
): Promise<CleanupResult> {
  const fixtures = await findFixtures(runner, options.staleHours);
  const fixtureIds = fixtures.map((f) => f.id);

  const tableCounts = options.execute
    ? await executeDeletion(runner, options.staleHours)
    : await countDryRun(runner, options.staleHours);

  const companyCount = tableCounts.find((c) => c.table === 'companies')?.count ?? 0;

  return {
    mode: options.execute ? 'execute' : 'dry-run',
    fixtureIds,
    fixtureDetails: fixtures,
    tableCounts,
    companyCount,
  };
}
