import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { clsx } from 'clsx';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, DollarSign, Minus } from 'lucide-react';
import { buildMissionUiLink } from '@eidolon/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAnalyticsOverview, useCostBreakdown } from '@/lib/hooks';
import type {
  CostBreakdown,
  CostBreakdownAgentRow,
  CostBreakdownDays,
  CostBreakdownRunRow,
} from '@/lib/api';

const RANGES: { days: CostBreakdownDays; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const count = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dayLabel = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}

function formatDay(date: string): string {
  return dayLabel.format(new Date(`${date}T00:00:00Z`));
}

/**
 * Change against the previous window. Null when there is nothing to compare
 * against: a percentage of zero is not a number worth showing.
 */
export function changePct(current: number, previous: number): number | null {
  if (previous <= 0) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 100);
}

const RUN_STATUS: Record<
  string,
  { label: string; variant: 'success' | 'error' | 'info' | 'warning' | 'default' }
> = {
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'error' },
  cancelled: { label: 'Cancelled', variant: 'default' },
  running: { label: 'Running', variant: 'info' },
  synthesizing: { label: 'Synthesizing', variant: 'info' },
  planning: { label: 'Planning', variant: 'info' },
  queued: { label: 'Queued', variant: 'default' },
  draft: { label: 'Draft', variant: 'default' },
  awaiting_input: { label: 'Needs input', variant: 'warning' },
  awaiting_approval: { label: 'Needs approval', variant: 'warning' },
};

const MODE_LABEL: Record<string, string> = {
  fast: 'Fast',
  deep_work: 'Deep work',
  analyst: 'Analyst',
  auto: 'Auto',
  custom: 'Custom',
};

function Stat({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-xl glass px-4 py-3.5 min-w-0">
      <p className="text-[11px] uppercase tracking-wider text-text-secondary font-display">
        {label}
      </p>
      <p className="mt-1 truncate text-2xl font-bold text-text-primary font-display tabular-nums">
        {value}
      </p>
      {detail && <div className="mt-1 text-xs text-text-secondary">{detail}</div>}
    </div>
  );
}

function Change({ current, previous, days }: { current: number; previous: number; days: number }) {
  const pct = changePct(current, previous);
  if (pct === null) {
    return <span>No spend in the prior {days} days</span>;
  }
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      {/* Direction is carried by the icon and sign, not by colour alone. */}
      <Icon
        aria-hidden
        className={clsx('h-3.5 w-3.5', pct > 0 ? 'text-warning' : pct < 0 ? 'text-success' : '')}
      />
      <span className="tabular-nums text-text-primary">
        {pct > 0 ? '+' : ''}
        {pct}%
      </span>
      <span className="whitespace-nowrap">vs prior {days} days</span>
    </span>
  );
}

function DailyChart({ daily }: { daily: CostBreakdown['daily'] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...daily.map((day) => day.costCents), 1);
  const peak = daily.reduce((best, day) => (day.costCents > best.costCents ? day : best), daily[0]);
  const shown = active === null ? null : daily[active];

  return (
    <div>
      <div className="mb-3 h-5 text-xs">
        <span className="text-text-secondary" data-testid="cost-chart-readout">
          {shown ? (
            <>
              <span className="text-text-primary">{formatDay(shown.date)}</span>
              {' · '}
              <span className="tabular-nums text-text-primary">{formatUsd(shown.costCents)}</span>
              {' · '}
              {count.format(shown.callCount)} {shown.callCount === 1 ? 'call' : 'calls'}
            </>
          ) : (
            <>
              Peak {formatUsd(peak.costCents)} on {formatDay(peak.date)}
            </>
          )}
        </span>
      </div>
      <div
        role="img"
        aria-label={`Daily spend from ${formatDay(daily[0].date)} to ${formatDay(
          daily[daily.length - 1].date,
        )}. Peak ${formatUsd(peak.costCents)} on ${formatDay(peak.date)}.`}
        className="flex h-36 items-end gap-px border-b border-white/[0.08] sm:gap-0.5"
        onPointerLeave={() => setActive(null)}
      >
        {daily.map((day, index) => (
          <div
            key={day.date}
            className="flex h-full min-w-0 flex-1 items-end"
            onPointerEnter={() => setActive(index)}
            onPointerDown={() => setActive(index)}
          >
            <div
              className={clsx(
                'w-full rounded-t-sm transition-colors duration-150',
                day.costCents === 0
                  ? 'bg-white/[0.06]'
                  : active === index
                    ? 'bg-accent'
                    : 'bg-accent/55',
              )}
              style={{
                height: day.costCents === 0 ? 1 : `${Math.max(2, (day.costCents / max) * 100)}%`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-text-muted tabular-nums">
        <span>{formatDay(daily[0].date)}</span>
        <span>{formatDay(daily[daily.length - 1].date)}</span>
      </div>
      <table className="sr-only">
        <caption>Daily spend</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Spend</th>
            <th scope="col">Calls</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((day) => (
            <tr key={day.date}>
              <th scope="row">{formatDay(day.date)}</th>
              <td>{formatUsd(day.costCents)}</td>
              <td>{day.callCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A labelled row whose bar shows its share of the largest row. */
function ShareRow({
  title,
  subtitle,
  costCents,
  totalCents,
  maxCents,
  callCount,
}: {
  title: React.ReactNode;
  subtitle?: string | null;
  costCents: number;
  totalCents: number;
  maxCents: number;
  callCount: number;
}) {
  const share = totalCents > 0 ? Math.round((costCents / totalCents) * 100) : 0;
  return (
    <li className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <span className="block truncate text-sm text-text-primary font-display">{title}</span>
          {subtitle && (
            <span className="block truncate text-xs text-text-secondary">{subtitle}</span>
          )}
        </div>
        <div className="shrink-0 text-right">
          <span className="block text-sm tabular-nums text-text-primary">
            {formatUsd(costCents)}
          </span>
          <span className="block text-xs tabular-nums text-text-secondary">
            {share}% · {count.format(callCount)} {callCount === 1 ? 'call' : 'calls'}
          </span>
        </div>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
        <div
          className="h-full rounded-full bg-accent/70"
          style={{ width: `${maxCents > 0 ? (costCents / maxCents) * 100 : 0}%` }}
        />
      </div>
    </li>
  );
}

/** `ceo` → `CEO`, `engineer` → `Engineer`. Roles are free text on the agent. */
function roleLabel(role: string | null): string {
  if (!role) {
    return 'Agent';
  }
  return role.length <= 3 ? role.toUpperCase() : role.charAt(0).toUpperCase() + role.slice(1);
}

function agentTitle(row: CostBreakdownAgentRow): string {
  if (row.agentId === null) {
    return 'Not billed to an agent';
  }
  return row.name ?? 'Removed agent';
}

function RunRow({ run, companyId }: { run: CostBreakdownRunRow; companyId: string }) {
  const status = RUN_STATUS[run.status] ?? { label: run.status, variant: 'default' as const };
  const href = buildMissionUiLink({
    companyId,
    projectId: run.projectId,
    threadId: run.projectThreadId,
    runId: run.runId,
  });
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <Link
          to={href}
          className="line-clamp-2 text-sm text-text-primary font-display underline-offset-4 hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline focus-visible:outline-none sm:line-clamp-1"
        >
          {run.summary ?? 'Mission run'}
        </Link>
        <p className="mt-0.5 truncate text-xs text-text-secondary">
          {run.projectName ?? 'Project'} · {MODE_LABEL[run.mode] ?? run.mode}
          {run.chargedRunCount > 1 && ` · ${run.chargedRunCount} runs in tree`}
        </p>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-4 sm:justify-end">
        <Badge variant={status.variant}>{status.label}</Badge>
        <div className="text-right">
          <span className="block text-sm tabular-nums text-text-primary">
            {formatUsd(run.costCents)}
          </span>
          <span className="block text-xs tabular-nums text-text-secondary">
            {count.format(run.callCount)} {run.callCount === 1 ? 'call' : 'calls'}
          </span>
        </div>
      </div>
    </li>
  );
}

export function CostDashboard() {
  const { companyId } = useParams();
  const [days, setDays] = useState<CostBreakdownDays>(30);
  const { data, isLoading, isError, isFetching, refetch } = useCostBreakdown(companyId, days);
  const { data: overview } = useAnalyticsOverview(companyId);

  const month = useMemo(() => {
    const costs = (overview as { costs?: { budgetCents?: number; spentThisMonthCents?: number } })
      ?.costs;
    const budget = costs?.budgetCents ?? 0;
    const spent = costs?.spentThisMonthCents ?? 0;
    return { budget, spent, pct: budget > 0 ? Math.round((spent / budget) * 100) : null };
  }, [overview]);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6 lg:p-8" aria-busy>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-[92px] animate-pulse rounded-xl glass" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-xl glass" />
      </div>
    );
  }

  if (isError || !data || !companyId) {
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={<AlertTriangle className="h-5 w-5" />}
          title="Spend could not be loaded"
          description="Nothing is shown rather than a number that may be wrong."
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const { totals, previous, daily, byAgent, byModel, runs } = data;
  // While the next window loads, the previous one stays on screen. Label the
  // figures with the window they belong to, not the one just selected.
  const shownDays = data.range.days;
  const hasSpend = totals.callCount > 0;
  const maxAgent = byAgent[0]?.costCents ?? 0;
  const maxModel = byModel[0]?.costCents ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-text-primary font-display">
          Spend
          <span className="ml-2 font-normal text-text-secondary">
            {formatDay(daily[0].date)} – {formatDay(daily[daily.length - 1].date)} (UTC)
          </span>
        </h2>
        <div
          role="group"
          aria-label="Time range"
          className="inline-flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5"
        >
          {RANGES.map((range) => (
            <button
              key={range.days}
              type="button"
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
              className={clsx(
                'min-h-9 rounded-md px-3 text-xs font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                days === range.days
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {range.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className={clsx(
          'space-y-4 transition-opacity duration-150',
          isFetching && shownDays !== days && 'opacity-60',
        )}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            testId="cost-stat-spend"
            label={`Spend, ${shownDays} days`}
            value={formatUsd(totals.costCents)}
            detail={
              <Change current={totals.costCents} previous={previous.costCents} days={shownDays} />
            }
          />
          <Stat
            testId="cost-stat-daily"
            label="Average per day"
            value={formatUsd(Math.round(totals.costCents / shownDays))}
            detail={`${count.format(totals.callCount)} provider ${
              totals.callCount === 1 ? 'call' : 'calls'
            }`}
          />
          <Stat
            testId="cost-stat-tokens"
            label="Tokens"
            value={compact.format(totals.inputTokens + totals.outputTokens)}
            detail={`${compact.format(totals.inputTokens)} in · ${compact.format(
              totals.outputTokens,
            )} out`}
          />
          <Stat
            testId="cost-stat-month"
            label="This month"
            value={formatUsd(month.spent)}
            detail={
              month.pct === null
                ? 'No monthly budget set'
                : `${month.pct}% of ${formatUsd(month.budget)} budget`
            }
          />
        </div>

        {!hasSpend ? (
          <EmptyState
            icon={<DollarSign className="h-5 w-5" />}
            title={`No spend in the last ${shownDays} days`}
            description="Charges appear here as soon as an agent makes a provider call."
          />
        ) : (
          <>
            <Card animated={false} header="Daily spend">
              <DailyChart daily={daily} />
            </Card>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card animated={false} header="By agent">
                <ul className="-my-2.5 divide-y divide-white/[0.05]" data-testid="cost-by-agent">
                  {byAgent.map((row) => (
                    <ShareRow
                      key={row.agentId ?? 'unassigned'}
                      title={
                        row.agentId ? (
                          <Link
                            to={`/company/${companyId}/agents/${row.agentId}`}
                            className="underline-offset-4 hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline focus-visible:outline-none"
                          >
                            {agentTitle(row)}
                          </Link>
                        ) : (
                          agentTitle(row)
                        )
                      }
                      subtitle={
                        row.agentId === null
                          ? 'Mission calls with no billing agent'
                          : row.budgetMonthlyCents > 0
                            ? `${roleLabel(row.role)} · ${formatUsd(row.budgetMonthlyCents)} monthly budget`
                            : roleLabel(row.role)
                      }
                      costCents={row.costCents}
                      totalCents={totals.costCents}
                      maxCents={maxAgent}
                      callCount={row.callCount}
                    />
                  ))}
                </ul>
              </Card>

              <Card animated={false} header="By model">
                <ul className="-my-2.5 divide-y divide-white/[0.05]" data-testid="cost-by-model">
                  {byModel.map((row) => (
                    <ShareRow
                      key={`${row.provider}/${row.model}`}
                      title={row.model}
                      subtitle={`${row.provider} · ${compact.format(
                        row.inputTokens + row.outputTokens,
                      )} tokens`}
                      costCents={row.costCents}
                      totalCents={totals.costCents}
                      maxCents={maxModel}
                      callCount={row.callCount}
                    />
                  ))}
                </ul>
              </Card>
            </div>

            {runs && (
              <Card
                animated={false}
                header={
                  <div className="flex items-baseline justify-between gap-3">
                    <span>Mission runs</span>
                    {runs.totalCount > 0 && (
                      <span className="text-xs font-normal tabular-nums text-text-secondary">
                        {formatUsd(runs.costCents)} across {count.format(runs.totalCount)}{' '}
                        {runs.totalCount === 1 ? 'run' : 'runs'}
                      </span>
                    )}
                  </div>
                }
              >
                {runs.items.length === 0 ? (
                  <p className="py-4 text-center text-sm text-text-secondary">
                    No Mission run was charged in this window.
                  </p>
                ) : (
                  <>
                    <ul className="-my-3 divide-y divide-white/[0.05]" data-testid="cost-by-run">
                      {runs.items.map((run) => (
                        <RunRow key={run.runId} run={run} companyId={companyId} />
                      ))}
                    </ul>
                    {runs.totalCount > runs.items.length && (
                      <p className="mt-4 text-xs text-text-secondary">
                        Showing the {runs.items.length} most expensive of{' '}
                        {count.format(runs.totalCount)} runs.
                      </p>
                    )}
                  </>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
