import { sql, type SQL } from 'drizzle-orm';
import type { DbInstance } from '../types.js';

/** Windows the cost dashboard can ask for. */
export const COST_BREAKDOWN_DAYS = [7, 30, 90] as const;
export type CostBreakdownDays = (typeof COST_BREAKDOWN_DAYS)[number];

/** Most expensive Mission runs returned per response. */
const RUN_LIMIT = 25;
const DAY_MS = 86_400_000;

export interface CostBreakdownTotals {
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

export interface CostBreakdownAgentRow extends CostBreakdownTotals {
  /** Null groups Mission spend that was not billed to a company agent. */
  agentId: string | null;
  name: string | null;
  role: string | null;
  status: string | null;
  budgetMonthlyCents: number;
}

export interface CostBreakdownRunRow extends CostBreakdownTotals {
  /** Root Mission run. Child-run charges roll up into their root. */
  runId: string;
  projectId: string;
  projectThreadId: string;
  projectName: string | null;
  summary: string | null;
  status: string;
  mode: string;
  /** Distinct runs in the tree that incurred a charge in the window. */
  chargedRunCount: number;
  lastChargeAt: string;
}

export interface CostBreakdownModelRow extends CostBreakdownTotals {
  provider: string;
  model: string;
}

export interface CostBreakdown {
  range: { days: CostBreakdownDays; from: string; to: string };
  totals: CostBreakdownTotals;
  /** Same-length window immediately before `range`. */
  previous: { costCents: number; callCount: number };
  /** One entry per UTC day in the window, oldest first, zero-filled. */
  daily: { date: string; costCents: number; callCount: number }[];
  byAgent: CostBreakdownAgentRow[];
  byModel: CostBreakdownModelRow[];
  /** Null when Mission cost monitoring is off for the company. */
  runs: {
    items: CostBreakdownRunRow[];
    /** Root runs with spend in the window, before the item limit. */
    totalCount: number;
    /** Spend in the window that is linked to a Mission run. */
    costCents: number;
  } | null;
}

/**
 * Half-open UTC window `[from, to)` covering `days` whole calendar days and
 * ending with the day `now` falls in, so today is always a full bucket.
 */
export function costWindow(days: CostBreakdownDays, now: Date): { from: Date; to: Date } {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = new Date(startOfToday + DAY_MS);
  const from = new Date(to.getTime() - days * DAY_MS);
  return { from, to };
}

/**
 * Every charge the company incurred in `[from, to)`, one row per provider call.
 *
 * `cost_events` is the shared ledger: legacy agent executions write to it
 * directly and every Mission settlement billed to a company agent writes a
 * linked compatibility row. A Mission settlement with no billing agent has no
 * `cost_events` row (`agent_id` is NOT NULL there), so those are unioned in
 * from `budget_settlements`. The two branches are disjoint by construction:
 * the second only takes settlements that never produced a cost event.
 *
 * `cost_events.created_at` is a UTC wall-clock `timestamp`; settlements use
 * `timestamptz` and are converted to the same representation.
 */
function ledger(companyId: string, from: Date, to: Date): SQL {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return sql`
    select ce.agent_id, ce.provider, ce.model, ce.input_tokens, ce.output_tokens,
           ce.cost_cents, ce.created_at, bs.run_id
    from cost_events ce
    left join budget_settlements bs
      on bs.id = ce.budget_settlement_id and bs.company_id = ce.company_id
    where ce.company_id = ${companyId}
      and ce.created_at >= ${fromIso}::timestamptz at time zone 'UTC'
      and ce.created_at < ${toIso}::timestamptz at time zone 'UTC'
    union all
    select null, bs.provider, coalesce(bs.model, 'unknown'), bs.input_tokens, bs.output_tokens,
           bs.cost_cents, bs.created_at at time zone 'UTC', bs.run_id
    from budget_settlements bs
    where bs.company_id = ${companyId}
      and bs.billing_agent_id is null
      and bs.created_at >= ${fromIso}::timestamptz
      and bs.created_at < ${toIso}::timestamptz
  `;
}

const TOTAL_COLUMNS = sql`
  coalesce(sum(l.cost_cents), 0)::bigint as cost_cents,
  coalesce(sum(l.input_tokens), 0)::bigint as input_tokens,
  coalesce(sum(l.output_tokens), 0)::bigint as output_tokens,
  count(*)::bigint as call_count
`;

type Row = Record<string, unknown>;

function totals(row: Row | undefined): CostBreakdownTotals {
  return {
    costCents: Number(row?.cost_cents ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    callCount: Number(row?.call_count ?? 0),
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Company spend for the cost dashboard: totals against the previous window, a
 * zero-filled daily series, and breakdowns by agent, model and Mission run.
 *
 * Runs a fixed number of queries regardless of how many agents, runs or
 * charges exist. `includeRuns` is false when Mission cost monitoring is off;
 * the run breakdown is then omitted rather than returned empty, so a client
 * can tell "no Mission spend" from "not available".
 */
export async function getCostBreakdown(
  db: DbInstance,
  input: { companyId: string; days: CostBreakdownDays; includeRuns: boolean; now?: Date },
): Promise<CostBreakdown> {
  const { companyId, days, includeRuns } = input;
  const { from, to } = costWindow(days, input.now ?? new Date());
  const previousFrom = new Date(from.getTime() - days * DAY_MS);
  const current = ledger(companyId, from, to);
  const previous = ledger(companyId, previousFrom, from);
  const run = (query: SQL) => db.drizzle.execute(query) as unknown as Promise<Row[]>;

  const [totalRows, previousRows, dailyRows, agentRows, modelRows] = await Promise.all([
    run(sql`with l as (${current}) select ${TOTAL_COLUMNS} from l`),
    run(sql`with l as (${previous}) select ${TOTAL_COLUMNS} from l`),
    run(sql`
      with l as (${current})
      select to_char(l.created_at, 'YYYY-MM-DD') as day, ${TOTAL_COLUMNS}
      from l group by 1
    `),
    run(sql`
      with l as (${current})
      select l.agent_id, a.name, a.role, a.status, a.budget_monthly_cents, ${TOTAL_COLUMNS}
      from l
      left join agents a on a.id = l.agent_id and a.company_id = ${companyId}
      group by l.agent_id, a.name, a.role, a.status, a.budget_monthly_cents
      order by cost_cents desc, a.name asc nulls last
    `),
    run(sql`
      with l as (${current})
      select l.provider, l.model, ${TOTAL_COLUMNS}
      from l group by l.provider, l.model
      order by cost_cents desc, l.provider asc, l.model asc
    `),
  ]);

  const byDay = new Map(dailyRows.map((row) => [String(row.day), row]));
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(from.getTime() + index * DAY_MS).toISOString().slice(0, 10);
    const row = totals(byDay.get(date));
    return { date, costCents: row.costCents, callCount: row.callCount };
  });

  let runs: CostBreakdown['runs'] = null;
  if (includeRuns) {
    // Charges are grouped by the root of the run tree: an operator starts and
    // budgets a Mission at its root, and child runs are an execution detail.
    const runRows = await run(sql`
      with l as (${current}),
      per_root as (
        select root.id as run_id, ${TOTAL_COLUMNS},
               count(distinct l.run_id)::bigint as charged_run_count,
               to_char(max(l.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_charge_at
        from l
        join mission_runs r on r.id = l.run_id and r.company_id = ${companyId}
        join mission_runs root on root.id = r.root_run_id and root.company_id = ${companyId}
        group by root.id
      )
      select p.*, root.project_id, root.project_thread_id, root.request_safe_summary, root.status, root.resolved_mode,
             pr.name as project_name,
             count(*) over ()::bigint as total_count,
             sum(p.cost_cents) over ()::bigint as total_cost_cents
      from per_root p
      join mission_runs root on root.id = p.run_id
      left join projects pr on pr.id = root.project_id and pr.company_id = ${companyId}
      order by p.cost_cents desc, p.last_charge_at desc, p.run_id asc
      limit ${RUN_LIMIT}
    `);
    runs = {
      totalCount: Number(runRows[0]?.total_count ?? 0),
      costCents: Number(runRows[0]?.total_cost_cents ?? 0),
      items: runRows.map((row) => ({
        runId: String(row.run_id),
        projectId: String(row.project_id),
        projectThreadId: String(row.project_thread_id),
        projectName: text(row.project_name),
        summary: text(row.request_safe_summary),
        status: String(row.status),
        mode: String(row.resolved_mode),
        chargedRunCount: Number(row.charged_run_count),
        lastChargeAt: String(row.last_charge_at),
        ...totals(row),
      })),
    };
  }

  return {
    range: { days, from: from.toISOString(), to: to.toISOString() },
    totals: totals(totalRows[0]),
    previous: {
      costCents: Number(previousRows[0]?.cost_cents ?? 0),
      callCount: Number(previousRows[0]?.call_count ?? 0),
    },
    daily,
    byAgent: agentRows.map((row) => ({
      agentId: text(row.agent_id),
      name: text(row.name),
      role: text(row.role),
      status: text(row.status),
      budgetMonthlyCents: Number(row.budget_monthly_cents ?? 0),
      ...totals(row),
    })),
    byModel: modelRows.map((row) => ({
      provider: String(row.provider),
      model: String(row.model),
      ...totals(row),
    })),
    runs,
  };
}
