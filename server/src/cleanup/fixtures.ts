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
 * Phase 1a — direct tables with `company_id` that reference `artifact_revisions`
 * via CASCADE FKs. These must be deleted BEFORE the indirect `artifact_revisions`
 * deletion in phase 1b, otherwise the CASCADE would silently remove them and
 * the per-table counts would be zero.
 *
 * `citations` references `artifact_revisions` via `artifact_revision_id`
 * (ON DELETE CASCADE) and `research_source_revisions` via `source_revision_id`
 * (ON DELETE CASCADE). Deleting by `company_id` first gives accurate counts.
 *
 * `artifact_provenance` references `artifact_revisions` via
 * `artifact_revision_id` (ON DELETE CASCADE). Same reasoning.
 *
 * (VAL-CROSS-100: cleanup removes all marked Mission data including research
 *  citations and provenance.)
 */
const DIRECT_TABLES_PHASE1A: ReadonlyArray<string> = ['citations', 'artifact_provenance'];

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
 *
 * `artifact_folders` is handled separately via
 * {@link deleteArtifactFoldersReverseHierarchical} (see below) because its
 * self-referential `parent_id` FK uses `ON DELETE SET NULL`. A naive
 * `DELETE ... WHERE company_id IN (...)` can delete a parent before its
 * children, causing the children's `parent_id` to be SET NULL. Two children
 * from different (deleted) parents with the same name then collide on the
 * `uq_artifact_folders_company_project_parent_name` unique index (which
 * coalesces NULL `parent_id` to `'<root>'`). Deleting leaf folders first
 * (deepest in the hierarchy) avoids the SET NULL trigger entirely.
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
  // run_plan_approval_bindings MUST precede approvals: its
  // approval_id → approvals.id FK is ON DELETE NO ACTION. Deleting
  // approvals first raises "update or delete on table 'approvals'
  // violates foreign key constraint … on table 'run_plan_approval_bindings'".
  'run_plan_approval_bindings',
  'approvals',
  'project_decisions',
  'project_outcomes',
  'project_plan_steps',
  'project_plans',
  // Mission child tables — must be deleted before mission_runs (cascade),
  // before run_policy_snapshots (mission_runs.policy_snapshot_id NO ACTION),
  // and before agents (mission_runs / budget_*.billing_agent_id NO ACTION).
  // Children are deleted before parents; per-table counts are reported
  // explicitly instead of relying on the mission_runs/company cascade.
  //   run_events → run_commands → budget_* → step/permit/synthesis/mirror/
  //   question/projection/tool → run_plan_revisions → mission_runs →
  //   run_policy_snapshots
  'run_events',
  'run_commands',
  'budget_settlements',
  'budget_allocations',
  'budget_reservations',
  'run_step_assignments',
  'run_scheduling_permits',
  'run_synthesis_manifests',
  'run_descendant_mirrors',
  'run_question_answers',
  'run_questions',
  'run_question_sets',
  'run_projection_links',
  'run_tool_invocations',
  // Research tables — must be deleted before mission_runs (they reference
  // mission_runs via run_id with ON DELETE CASCADE) and before
  // research_sources (research_source_revisions references it via source_id
  // CASCADE). Order: run_research_sources → research_source_revisions →
  // research_sources. (VAL-CROSS-100: cleanup removes all marked Mission
  // research data.)
  'run_research_sources',
  'research_source_revisions',
  'research_sources',
  // run_plan_revisions: mission_runs.current_plan_revision_id and
  // approved_plan_revision_id reference this table with ON DELETE NO ACTION.
  // executeDeletion nulls those columns BEFORE this delete runs (see the
  // special-case in the phase 2-4 loop). run_step_assignments,
  // run_synthesis_manifests, and run_plan_approval_bindings (which reference
  // run_plan_revisions via CASCADE) are already deleted above.
  'run_plan_revisions',
  'mission_runs',
  'run_policy_snapshots',
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
// artifact_folders — reverse-hierarchy deletion
// ---------------------------------------------------------------------------

/**
 * Delete `artifact_folders` rows for fixture companies in reverse hierarchy
 * order (leaf folders first, then their parents, and so on up to the root).
 *
 * The `artifact_folders.parent_id` self-referential FK uses
 * `ON DELETE SET NULL`. If a parent is deleted before its children, the
 * children's `parent_id` is SET NULL, making them top-level. Two children
 * from different (deleted) parents that share the same name then collide on
 * the `uq_artifact_folders_company_project_parent_name` unique index (which
 * coalesces NULL `parent_id` to `'<root>'`), raising
 * `duplicate key value violates unique constraint`. Deleting leaf folders
 * first guarantees no parent is removed while children still exist, so the
 * SET NULL trigger never fires.
 *
 * Implemented as a bounded loop: each iteration deletes every folder that has
 * no child folders within the fixture set (i.e. current leaves). After each
 * pass, the next level up becomes leaves. The loop terminates when a pass
 * deletes zero rows (no folders remain). The depth of any real folder tree is
 * small, so this converges quickly.
 *
 * @internal
 */
async function deleteArtifactFoldersReverseHierarchical(
  tx: SqlRunner,
  sub: string,
): Promise<number> {
  let totalDeleted = 0;
  for (;;) {
    const rows = await tx.query<{ id: string }>(
      `DELETE FROM artifact_folders
       WHERE id IN (
         SELECT f.id FROM artifact_folders f
         WHERE f.company_id IN (${sub})
           AND NOT EXISTS (
             SELECT 1 FROM artifact_folders c
             WHERE c.company_id IN (${sub})
               AND c.parent_id = f.id
           )
       )
       RETURNING id`,
    );
    totalDeleted += rows.length;
    if (rows.length === 0) {
      break;
    }
  }
  return totalDeleted;
}

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
async function countDryRun(runner: SqlRunner, staleHours?: number): Promise<TableCount[]> {
  const sub = fixtureSubquery(staleHours);
  const counts: TableCount[] = [];

  // Phase 1a — direct tables with company_id that reference artifact_revisions
  // via CASCADE. Must be counted/deleted BEFORE the indirect artifact_revisions
  // deletion, otherwise the CASCADE would silently remove them.
  for (const table of DIRECT_TABLES_PHASE1A) {
    const rows = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM ${table} WHERE company_id IN (${sub})`,
    );
    counts.push({ table, count: parseInt(rows[0]?.count ?? '0', 10) });
  }

  for (const { table, childCol, parentTable, parentCol } of INDIRECT_TABLES) {
    const rows = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM ${table} WHERE ${childCol} IN (SELECT ${parentCol} FROM ${parentTable} WHERE company_id IN (${sub}))`,
    );
    counts.push({ table, count: parseInt(rows[0]?.count ?? '0', 10) });
  }

  // artifact_folders — counted by company_id (deleted via reverse-hierarchy
  // order in execute mode to avoid the self-FK SET NULL unique collision).
  const folderRows = await runner.query<{ count: string }>(
    `SELECT count(*) as count FROM artifact_folders WHERE company_id IN (${sub})`,
  );
  counts.push({ table: 'artifact_folders', count: parseInt(folderRows[0]?.count ?? '0', 10) });

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
async function executeDeletion(runner: SqlRunner, staleHours?: number): Promise<TableCount[]> {
  const sub = fixtureSubquery(staleHours);
  const counts: TableCount[] = [];

  await runner.begin(async (tx) => {
    // Phase 1a — direct tables with company_id that reference
    // artifact_revisions via CASCADE. Must be deleted BEFORE the indirect
    // artifact_revisions deletion, otherwise the CASCADE would silently
    // remove them and per-table counts would be zero.
    // (VAL-CROSS-100: cleanup removes citations and artifact_provenance.)
    for (const table of DIRECT_TABLES_PHASE1A) {
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM ${table} WHERE company_id IN (${sub}) RETURNING id`,
      );
      counts.push({ table, count: rows.length });
    }

    // Phase 1b — indirect children via subquery
    for (const { table, childCol, parentTable, parentCol } of INDIRECT_TABLES) {
      const rows = await tx.query<{ id: string }>(
        `DELETE FROM ${table} WHERE ${childCol} IN (SELECT ${parentCol} FROM ${parentTable} WHERE company_id IN (${sub})) RETURNING id`,
      );
      counts.push({ table, count: rows.length });
    }

    // Phase 1.5 — artifact_folders in reverse hierarchy order (leaf-first).
    // Must run before companies (cascade) and before artifacts (artifacts
    // reference folder_id with ON DELETE SET NULL, so deleting folders first
    // simply nulls out artifact.folder_id). Deleting leaf-first avoids the
    // self-FK SET NULL unique-constraint collision described above.
    const folderCount = await deleteArtifactFoldersReverseHierarchical(tx, sub);
    counts.push({ table: 'artifact_folders', count: folderCount });

    // Phase 2-4 — direct tables in dependency order
    for (const table of ALL_DIRECT_TABLES) {
      // run_plan_revisions is referenced by mission_runs.current_plan_revision_id
      // and approved_plan_revision_id via ON DELETE NO ACTION. Null those
      // pointers out BEFORE deleting the revisions so the NO ACTION check
      // passes. All other tables that reference run_plan_revisions
      // (run_step_assignments, run_synthesis_manifests, run_plan_approval_bindings)
      // use ON DELETE CASCADE and are already deleted above.
      if (table === 'run_plan_revisions') {
        await tx.query(
          `UPDATE mission_runs SET current_plan_revision_id = NULL, approved_plan_revision_id = NULL WHERE company_id IN (${sub})`,
        );
      }
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
// Provider circuit health reset (global, not company-scoped)
// ---------------------------------------------------------------------------

/**
 * Reset all `research_provider_health` rows to a healthy closed state.
 *
 * `research_provider_health` is a platform-level table with no `company_id`
 * column (VAL-RES-015). It holds ONLY bounded provider/operation/status/
 * latency data — never tenant queries, URLs, source text, or credentials.
 *
 * Validation runs may leave circuits in an open or half-open state after
 * testing retry, fallback, and disruption scenarios. This reset restores
 * all circuits to `closed` with zero consecutive failures so subsequent
 * runs start from a clean health state.
 *
 * (VAL-CROSS-100: cleanup restores changed provider/circuit state.)
 *
 * @param runner - The SQL runner to use.
 * @param execute - If false, count rows that would be reset (dry-run).
 * @returns The number of rows reset (or that would be reset in dry-run).
 */
export async function resetProviderCircuitHealth(
  runner: SqlRunner,
  execute: boolean,
): Promise<number> {
  if (execute) {
    const rows = await runner.query<{ id: string }>(
      `UPDATE research_provider_health
       SET state = 'closed',
           consecutive_failures = 0,
           open_until_ms = 0,
           half_open_probe_owner = NULL,
           half_open_probe_lease_expires_ms = 0,
           updated_at = NOW()
       RETURNING id`,
    );
    return rows.length;
  }
  const rows = await runner.query<{ count: string }>(
    `SELECT count(*) as count FROM research_provider_health WHERE state != 'closed' OR consecutive_failures > 0`,
  );
  return parseInt(rows[0]?.count ?? '0', 10);
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
