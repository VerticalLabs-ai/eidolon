import { useCallback, useMemo } from 'react';
import { Link2, ShieldCheck } from 'lucide-react';
import { useMissionRunSnapshot, useMissionCurrentPlanRevision } from '@/lib/hooks';
import { useSession } from '@/lib/auth';
import { MissionPlanDecisionControls, type DecisionRole } from './MissionPlanDecisionControls';
import type { Approval, MissionPlanRevision } from '@/lib/api';

/**
 * Mission plan_gate approval surface for the Approvals page
 * (VAL-CROSS-045, VAL-CROSS-085).
 *
 * Renders one authoritative decision mapping for a Mission-linked plan
 * approval: matching scope (company/project), run, revision, content hash,
 * objective, requester, and status. Decisions submit through the canonical
 * Mission `plan.approve` / `plan.reject` command transaction with the
 * current run version (`If-Match`), exact revision ID, and content hash —
 * never through the legacy generic decide route — so every actionable
 * surface shares one command identity, RBAC, stale-state handling, and
 * attribution (VAL-PLAN-104, VAL-CROSS-085).
 *
 * Authority and safety invariants:
 * - The browser never advances decision state optimistically. The Mission
 *   command transaction is authoritative; the approval projection
 *   converges after the server applies the decision (VAL-CROSS-045).
 * - Stale controls are non-actionable: a stale run version (412
 *   `RUN_VERSION_MISMATCH`) surfaces a refresh alert, and a stale revision
 *   (the approval is for a superseded proposal) surfaces a refresh notice
 *   instead of actionable controls (VAL-CROSS-045, VAL-CROSS-053).
 * - A resolved approval (approved/rejected/cancelled) renders as history
 *   with no actionable decision controls; the Mission is authoritative
 *   immediately after the decision commits (VAL-CROSS-045).
 * - Generic legacy decide/cancel controls are never rendered for a
 *   `plan_gate` approval; only the Mission-bound controls are exposed.
 *
 * Accessibility:
 * - The Mission linkage is conveyed as text (run id, revision, hash,
 *   objective, requester, status), never color alone.
 * - Decision controls are keyboard operable with visible focus (delegated
 *   to {@link MissionPlanDecisionControls}).
 * - Errors are surfaced through `role="alert"`.
 */

/** Extract the Mission linkage fields from a plan_gate approval payload. */
interface PlanGatePayload {
  runId: string;
  planRevisionId: string;
  revision?: number;
  contentHash: string;
}

function readPlanGatePayload(approval: Approval): PlanGatePayload | null {
  const p = approval.payload as Partial<PlanGatePayload> | undefined;
  if (
    p &&
    typeof p.runId === 'string' &&
    typeof p.planRevisionId === 'string' &&
    typeof p.contentHash === 'string'
  ) {
    return {
      runId: p.runId,
      planRevisionId: p.planRevisionId,
      revision: p.revision,
      contentHash: p.contentHash,
    };
  }
  return null;
}

/** Derive the user's company role for decision gating (server RBAC is authority). */
function useDecisionRole(): DecisionRole {
  const session = useSession();
  const role = session.data?.user?.role ?? null;
  return (role ?? 'unknown') as DecisionRole;
}

export function MissionPlanGateApproval({
  companyId,
  approval,
}: {
  companyId: string;
  approval: Approval;
}) {
  const payload = readPlanGatePayload(approval);
  const projectId = approval.projectId ?? null;
  const role = useDecisionRole();
  const principalId = useSession().data?.user?.id ?? undefined;

  const snapshotQuery = useMissionRunSnapshot(companyId, projectId ?? '', payload?.runId);
  const snapshot = snapshotQuery.data;

  const currentPlanRevisionId = snapshot?.currentPlanRevisionId ?? null;
  const planQuery = useMissionCurrentPlanRevision(
    companyId,
    projectId ?? '',
    payload?.runId,
    currentPlanRevisionId,
  );
  const currentRevision = planQuery.data as MissionPlanRevision | null | undefined;

  const isPending = approval.status === 'pending';
  // The approval is actionable only if its revision is still the run's
  // current proposal. A superseded approval (revision request) is no longer
  // current even if the approval row is still pending in projection.
  const isCurrentRevision =
    !!payload && !!currentRevision && currentRevision.id === payload.planRevisionId;

  const onRefresh = useCallback(() => {
    void snapshotQuery.refetch();
    void planQuery.refetch();
  }, [snapshotQuery, planQuery]);

  const objective = useMemo(() => {
    if (isCurrentRevision && currentRevision?.content?.objective) {
      return currentRevision.content.objective;
    }
    return approval.title;
  }, [isCurrentRevision, currentRevision, approval.title]);

  if (!payload || !projectId) {
    // Malformed projection — render a safe recovery state rather than
    // guessing authority from missing fields.
    return (
      <div
        role="alert"
        className="rounded-lg border border-warning/20 bg-warning/[0.04] p-3 text-xs text-warning break-words"
        data-testid="plan-gate-malformed"
      >
        This Mission plan approval is missing its run or project linkage. Open the Mission in
        Project Work to review and decide.
      </div>
    );
  }

  return (
    <section
      aria-labelledby={`plan-gate-heading-${approval.id}`}
      data-testid="plan-gate-approval"
      className="flex flex-col gap-3"
    >
      <div>
        <h3
          id={`plan-gate-heading-${approval.id}`}
          className="text-sm font-semibold text-text-primary font-display flex items-center gap-1.5"
        >
          <ShieldCheck className="h-4 w-4 text-success" aria-hidden="true" />
          Mission plan approval
        </h3>
        <p className="mt-1 text-sm text-text-secondary break-words">{objective}</p>
      </div>

      <MissionLinkage
        approval={approval}
        payload={payload}
        projectId={projectId}
        runStatus={snapshot?.status}
      />

      <MissionDecisionSurface
        companyId={companyId}
        projectId={projectId}
        runId={payload.runId}
        isPending={isPending}
        isCurrentRevision={isCurrentRevision}
        currentRevision={currentRevision ?? null}
        stateVersion={snapshot?.stateVersion}
        role={role}
        principalId={principalId}
        onRefresh={onRefresh}
        snapshotLoading={snapshotQuery.isLoading}
      />
    </section>
  );
}

/** Render the Mission linkage (run, revision, hash, requester, status). */
function MissionLinkage({
  approval,
  payload,
  projectId,
  runStatus,
}: {
  approval: Approval;
  payload: PlanGatePayload;
  projectId: string;
  runStatus?: string;
}) {
  const requester = approval.requestedByAgentId ?? approval.requestedByUserId ?? null;
  return (
    <dl
      className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-xs text-text-secondary sm:grid-cols-2"
      data-testid="plan-gate-linkage"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Link2 className="h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
        <dt className="text-text-muted">Mission run:</dt>
        <dd className="font-mono text-text-primary break-all">{payload.runId}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-text-muted">Plan revision:</dt>
        <dd className="font-mono text-text-primary break-all">
          {payload.revision !== null && payload.revision !== undefined
            ? `rev ${payload.revision} · `
            : ''}
          {payload.planRevisionId}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-text-muted">Content hash:</dt>
        <dd className="font-mono text-text-primary break-all">
          {payload.contentHash.slice(0, 12)}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-text-muted">Project:</dt>
        <dd className="font-mono text-text-primary break-all">{projectId}</dd>
      </div>
      {requester && (
        <div className="min-w-0">
          <dt className="text-text-muted">Requested by:</dt>
          <dd className="font-mono text-text-primary break-all">{requester}</dd>
        </div>
      )}
      <div className="min-w-0">
        <dt className="text-text-muted">Run status:</dt>
        <dd className="text-text-primary">{runStatus ?? '—'}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-text-muted">Approval status:</dt>
        <dd className="text-text-primary">{approval.status}</dd>
      </div>
    </dl>
  );
}

/** Render the actionable decision surface or the resolved/stale state. */
function MissionDecisionSurface({
  companyId,
  projectId,
  runId,
  isPending,
  isCurrentRevision,
  currentRevision,
  stateVersion,
  role,
  principalId,
  onRefresh,
  snapshotLoading,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  isPending: boolean;
  isCurrentRevision: boolean;
  currentRevision: MissionPlanRevision | null;
  stateVersion?: number;
  role: DecisionRole;
  principalId?: string;
  onRefresh: () => void;
  snapshotLoading: boolean;
}) {
  // Resolved approval: render as history with no actionable controls.
  if (!isPending) {
    return (
      <p className="text-xs text-text-secondary break-words" data-testid="plan-gate-resolved">
        This Mission plan approval has been resolved. The Mission is authoritative — open Project
        Work to review the current state.
      </p>
    );
  }

  if (snapshotLoading) {
    return (
      <p className="text-xs text-text-muted" role="status">
        Loading Mission state…
      </p>
    );
  }

  // Pending but the approval revision is no longer the current proposal
  // (superseded by a revision request). Show a stale-revision notice; the
  // stale approval is non-actionable.
  if (!isCurrentRevision || !currentRevision) {
    return (
      <div
        className="rounded-lg border border-warning/20 bg-warning/[0.04] p-3 text-xs text-warning break-words"
        role="alert"
        data-testid="plan-stale-revision-notice"
      >
        This plan is no longer the current proposal. Refresh to see the latest revision before
        deciding.
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh plan"
          className="ml-2 inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-xs font-medium text-warning hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/40 focus-visible:outline-none motion-reduce:transition-none"
        >
          Refresh
        </button>
      </div>
    );
  }

  // Actionable: render the canonical Mission decision controls so the
  // Approvals surface shares one command identity with Project Work
  // (VAL-PLAN-104, VAL-CROSS-085).
  return (
    <MissionPlanDecisionControls
      companyId={companyId}
      projectId={projectId}
      runId={runId}
      revision={currentRevision}
      stateVersion={stateVersion}
      role={role}
      principalId={principalId}
      isCurrentRevision={true}
      onRefresh={onRefresh}
    />
  );
}
