import type { MissionRunSnapshot } from '@/lib/api';
import { formatCents } from './mission-child-tree-helpers';

/**
 * MissionCostBreakdown — root cost reconciliation with billing identities
 * (VAL-SUB-101).
 *
 * Renders one currency and the root ceiling / reserved / settled / released
 * / remaining cents from the authoritative root snapshot budget. Remaining
 * is derived as `reserved - settled - released` (the unconsumed hold) and is
 * never negative. Per-child settled costs and billing identities are rendered
 * inline in the child tree nodes; this section is the root reconciliation
 * surface so an authorized user can confirm child settled plus root overhead
 * reconciles to root settled.
 */
export function MissionCostBreakdown({
  snapshot,
  childSettledCents,
}: {
  snapshot: MissionRunSnapshot;
  /** Sum of materialized child settled costs (from completed events). */
  childSettledCents: number;
}) {
  const ceiling = snapshot.budget?.costCentsCeiling ?? 0;
  const reserved = snapshot.budget?.reservedCents ?? 0;
  const settled = snapshot.budget?.settledCents ?? 0;
  const released = snapshot.budget?.releasedCents ?? 0;
  // Remaining unconsumed hold. Never negative (settled + released <= reserved).
  const remaining = Math.max(0, reserved - settled - released);
  // Root overhead = root settled minus the sum of child settled costs
  // (planning/research/synthesis billed to the root initiating agent).
  const rootOverhead = Math.max(0, settled - childSettledCents);

  if (ceiling <= 0) {
    return null;
  }

  return (
    <div
      data-testid="mission-cost-breakdown"
      className="mb-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 w-full max-w-full break-words overflow-hidden"
      aria-label="Cost breakdown"
    >
      <p className="text-xs font-medium text-text-secondary mb-1">Cost breakdown</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          Ceiling: <span className="tabular-nums text-text-primary">{formatCents(ceiling)}</span>
        </span>
        <span>
          Reserved: <span className="tabular-nums text-text-primary">{formatCents(reserved)}</span>
        </span>
        <span>
          Settled: <span className="tabular-nums text-text-primary">{formatCents(settled)}</span>
        </span>
        <span>
          Released:{' '}
          <span className="tabular-nums text-text-secondary">{formatCents(released)}</span>
        </span>
        <span>
          Remaining:{' '}
          <span className="tabular-nums text-text-primary">{formatCents(remaining)}</span>
        </span>
        {rootOverhead > 0 && (
          <span>
            Root overhead:{' '}
            <span className="tabular-nums text-text-secondary">{formatCents(rootOverhead)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
