import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import { buildMissionUiLink } from '@eidolon/shared';
import type { DbInstance, EidolonDbSchema } from '../../types.js';
import { MissionWorkerHealthService, type QueueHealth } from './worker-health.js';
import { SubthreadProjectionService } from './subthread-projection.js';

/** Inferred row types for the authoritative tables read by snapshots. */
type MissionRunRow = EidolonDbSchema['missionRuns']['$inferSelect'];
type BudgetReservationRow = EidolonDbSchema['budgetReservations']['$inferSelect'];

/**
 * Mission run snapshot + list reads.
 *
 * Postgres is the system of record. These reads reconstruct the complete
 * authoritative card from durable rows so a client that lost its state can
 * recover every visible field. The strong ETag is the run's `state_version`,
 * which an applied command increments for every snapshot-visible mutation
 * even when the lifecycle status does not change (VAL-RUN-129).
 *
 * Reads are company-scoped first, then project-validated at the route layer.
 * Cross-scope identifiers return 404 without revealing existence.
 */

/** A complete authoritative run snapshot for card reconstruction. */
export interface RunSnapshot {
  id: string;
  companyId: string;
  projectId: string;
  projectThreadId: string;
  rootRunId: string;
  parentRunId: string | null;
  retryOfRunId: string | null;
  depth: number;
  childOrdinal: number | null;
  routingKind: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  resolvedMode: string;
  modeProfileId: string | null;
  policySnapshotId: string | null;
  policyContentHash: string | null;
  /**
   * Complete immutable policy snapshot fields (VAL-MODEQ-039, VAL-MODEQ-115).
   * Exposed so workers and user-visible history use complete hash-bound
   * snapshots. Null when no policy snapshot exists (legacy/edge case).
   */
  policy: {
    schemaVersion: number;
    sourceProfile: string | null;
    sourceProfileName: string | null;
    sourceProfileDescription: string | null;
    sourceProfileVersion: number | null;
    provider: string;
    adapterId: string | null;
    model: string;
    reasoningDepth: string | null;
    systemPromptHash: string | null;
    instructionHash: string | null;
    toolAllowlist: string[];
    domainAllowlist: string[];
    researchPolicy: Record<string, unknown>;
    planningPolicy: Record<string, unknown>;
    approvalPolicy: Record<string, unknown>;
    fallbackPolicy: Record<string, unknown>;
    partialResultPolicy: string;
    limits: Record<string, number>;
  } | null;
  requestContentHash: string;
  currentQuestionSetId: string | null;
  currentPlanRevisionId: string | null;
  approvedPlanRevisionId: string | null;
  waitingFromStatus: string | null;
  partialResultPolicy: string;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
  cancellationDeadlineAt: string | null;
  failureCategory: string | null;
  failureCode: string | null;
  safeErrorMessage: string | null;
  /**
   * Durable result completeness outcome (VAL-CROSS-091, VAL-CROSS-102).
   *
   * `null` until a completion outcome is determined (nonterminal, failed,
   * or cancelled before synthesis). `full` when all required children
   * completed and synthesis succeeded, or a direct (non-composite) run
   * completed. `partial` when best-effort synthesis completed with
   * disclosed gaps. This field governs synthesis, artifact metadata,
   * parent tree, Project Plan, Activity, and cards; no surface infers a
   * conflicting label.
   */
  resultCompleteness: 'full' | 'partial' | null;
  startedAt: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  providerCallCount: number;
  descendantCount: number;
  inputTokens: number;
  outputTokens: number;
  outputBytes: number;
  actualCostCents: number;
  budget: {
    reservedCents: number;
    settledCents: number;
    releasedCents: number;
    costCentsCeiling: number;
    actualCostCents: number;
  };
  childSummary: {
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
  /** Output links. Empty until the artifact/provenance feature populates them. */
  artifacts: never[];
  links: { ui: string };
  /**
   * The dedicated subthread ID for this run, if it is a child run with a
   * Mission subthread projection (VAL-SUB-007). Null for root runs or when
   * no subthread projection exists. The subthread is company/project scoped
   * (VAL-SUB-043) and read-only (VAL-SUB-102).
   */
  subthreadId: string | null;
  /**
   * Worker availability derived from the most recent worker heartbeat age
   * (VAL-RUN-088). `"unavailable"` when no worker heartbeat has been
   * recorded for at least 30 seconds; otherwise `"available"`. The browser
   * never infers worker unavailability from a local timer — it reads this
   * authoritative field.
   */
  queueHealth: QueueHealth;
  /**
   * Absolute Mission wall-time deadline (createdAt + limits.durationSeconds)
   * (VAL-MODEQ-128). Null when no policy snapshot exists. The deadline is
   * absolute from root creation and includes awaiting-input and
   * awaiting-approval time as well as active work; restart cannot reset it.
   */
  deadlineAt: string | null;
  /**
   * Remaining wall time in milliseconds until the deadline (VAL-MODEQ-128).
   * Negative when the deadline has already passed (the run should be
   * terminalized by deadline enforcement). Null when no deadline is known.
   */
  remainingWallMs: number | null;
  /**
   * Current open question set with its immutable question definitions
   * (VAL-MODEQ-044). Null when the run is not awaiting_input or has no
   * open set. Questions are ordered by their persisted `order` field.
   */
  currentQuestionSet: {
    id: string;
    ordinal: number;
    version: number;
    status: string;
    invalidationReason: string | null;
    createdAt: string;
    questions: Array<{
      questionKey: string;
      order: number;
      type: string;
      label: string;
      help: string | null;
      required: boolean;
      default: unknown;
      options: unknown[] | null;
      validation: Record<string, unknown> | null;
    }>;
  } | null;
}

/** A lean summary used by the scoped run list. */
export interface RunSummary {
  id: string;
  companyId: string;
  projectId: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  resolvedMode: string;
  policyContentHash: string | null;
  requestContentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListInput {
  companyId: string;
  projectId: string;
  status?: string;
  limit: number;
  cursor?: string;
}

export interface ListResult {
  runs: RunSummary[];
  nextCursor: string | null;
}

const STATUS_VALUES = [
  'draft',
  'awaiting_input',
  'planning',
  'awaiting_approval',
  'queued',
  'running',
  'synthesizing',
  'completed',
  'failed',
  'cancelled',
] as const;

export function isValidStatus(value: string): value is (typeof STATUS_VALUES)[number] {
  return (STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Decode an opaque keyset cursor. The cursor is base64url-encoded JSON
 * `{ c: createdAtIso, i: id }` anchoring the last row of the previous page.
 * Returns null for an absent cursor. Throws AppError(400) for malformed input.
 */
export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined || cursor === null || cursor === '') {
    return null;
  }
  let json: string;
  try {
    // base64url → UTF-8 JSON.
    const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    json = Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { c?: unknown }).c !== 'string' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  const obj = parsed as { c: string; i: string };
  return { createdAt: obj.c, id: obj.i };
}

/** Encode a keyset cursor from the last row of a page. */
export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = typeof createdAt === 'string' ? createdAt : createdAt.toISOString();
  const json = JSON.stringify({ c: iso, i: id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export interface SnapshotDeps {
  clock?: () => Date;
}

export class MissionSnapshotService {
  private readonly healthService: MissionWorkerHealthService;
  private readonly deps: SnapshotDeps;

  constructor(
    private db: DbInstance,
    healthService?: MissionWorkerHealthService,
    deps: SnapshotDeps = {},
  ) {
    this.healthService = healthService ?? new MissionWorkerHealthService(db);
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Read the complete authoritative snapshot for one run, scoped to the
   * given company/project. Throws 404 RUN_NOT_FOUND for an absent or
   * cross-scope id.
   */
  async getSnapshot(companyId: string, projectId: string, runId: string): Promise<RunSnapshot> {
    const schema = this.db.schema;
    const [run] = await this.db.drizzle
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.id, runId),
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    const [reservation] = await this.db.drizzle
      .select()
      .from(schema.budgetReservations)
      .where(eq(schema.budgetReservations.runId, run.id))
      .limit(1);

    let policyContentHash: string | null = null;
    let policyRow: EidolonDbSchema['runPolicySnapshots']['$inferSelect'] | null = null;
    if (run.policySnapshotId) {
      const [policy] = await this.db.drizzle
        .select()
        .from(schema.runPolicySnapshots)
        .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId))
        .limit(1);
      if (policy) {
        policyContentHash = policy.contentHash;
        policyRow = policy;
      }
    }

    const childSummary = await this.computeChildSummary(companyId, projectId, run.id);

    const queueHealth = await this.healthService.queueHealth();

    // Read the current open question set with its question definitions
    // (VAL-MODEQ-044).
    const currentQuestionSet = await this.readCurrentQuestionSet(
      run.companyId,
      run.id,
      run.currentQuestionSetId,
    );

    // Compute the absolute wall-time deadline and remaining wall time
    // (VAL-MODEQ-128). The deadline is createdAt + limits.durationSeconds
    // from the immutable policy snapshot. It is absolute from root creation
    // and includes awaiting-input and awaiting-approval time.
    let deadlineAt: string | null = null;
    let remainingWallMs: number | null = null;
    if (policyRow) {
      const limits = policyRow.limits as Record<string, number>;
      const durationSeconds = limits.durationSeconds ?? 3600;
      const deadline = new Date(run.createdAt.getTime() + durationSeconds * 1000);
      deadlineAt = deadline.toISOString();
      remainingWallMs = deadline.getTime() - this.now().getTime();
    }

    // Resolve the dedicated subthread for this run, if it is a child run
    // with a Mission subthread projection (VAL-SUB-007, VAL-SUB-043).
    let subthreadId: string | null = null;
    if (run.parentRunId !== null) {
      const subthreadService = new SubthreadProjectionService(this.db);
      const subthread = await subthreadService.getSubthreadForRun(
        run.companyId,
        run.projectId,
        run.id,
      );
      subthreadId = subthread?.threadId ?? null;
    }

    return this.toSnapshot(
      run,
      reservation,
      policyContentHash,
      policyRow,
      childSummary,
      queueHealth,
      currentQuestionSet,
      deadlineAt,
      remainingWallMs,
      subthreadId,
    );
  }

  /**
   * List runs scoped to a company/project with stable opaque keyset
   * pagination ordered by (createdAt DESC, id DESC) and an optional status
   * filter. The anchor is carried by the opaque cursor so runs inserted or
   * changing status during traversal do not duplicate or skip the anchored
   * result set.
   */
  async listRuns(input: ListInput): Promise<ListResult> {
    const { companyId, projectId, status, limit, cursor } = input;
    const schema = this.db.schema;
    const anchor = decodeCursor(cursor);

    // Fetch limit + 1 to detect a next page without an extra round-trip.
    const fetchLimit = limit + 1;

    const conditions = [
      eq(schema.missionRuns.companyId, companyId),
      eq(schema.missionRuns.projectId, projectId),
    ];
    if (status) {
      if (!isValidStatus(status)) {
        throw new AppError(400, 'VALIDATION_ERROR', `Unknown status filter: ${status}`);
      }
      conditions.push(eq(schema.missionRuns.status, status));
    }
    if (anchor) {
      // Keyset: rows strictly before the anchor in (createdAt DESC, id DESC).
      // (createdAt, id) < (anchor.createdAt, anchor.id) lexicographically.
      const cursorCondition = or(
        lt(schema.missionRuns.createdAt, new Date(anchor.createdAt)),
        and(
          eq(schema.missionRuns.createdAt, new Date(anchor.createdAt)),
          lt(schema.missionRuns.id, anchor.id),
        ),
      );
      // `or` with two args is always defined; the union type is a TS artifact
      // of the zero-arg overload.
      conditions.push(cursorCondition!);
    }

    const rows = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        companyId: schema.missionRuns.companyId,
        projectId: schema.missionRuns.projectId,
        status: schema.missionRuns.status,
        stateVersion: schema.missionRuns.stateVersion,
        lastEventSequence: schema.missionRuns.lastEventSequence,
        resolvedMode: schema.missionRuns.resolvedMode,
        policySnapshotId: schema.missionRuns.policySnapshotId,
        requestContentHash: schema.missionRuns.requestContentHash,
        createdAt: schema.missionRuns.createdAt,
        updatedAt: schema.missionRuns.updatedAt,
      })
      .from(schema.missionRuns)
      .where(and(...conditions))
      .orderBy(desc(schema.missionRuns.createdAt), desc(schema.missionRuns.id))
      .limit(fetchLimit);

    // Resolve policy content hashes for the page in one query.
    const policyIds = rows.map((r) => r.policySnapshotId).filter((id): id is string => id !== null);
    const hashById = new Map<string, string>();
    if (policyIds.length > 0) {
      const policies = await this.db.drizzle
        .select({
          id: schema.runPolicySnapshots.id,
          contentHash: schema.runPolicySnapshots.contentHash,
        })
        .from(schema.runPolicySnapshots)
        .where(inArray(schema.runPolicySnapshots.id, policyIds));
      for (const p of policies) {
        hashById.set(p.id, p.contentHash);
      }
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const runs: RunSummary[] = page.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      projectId: r.projectId,
      status: r.status,
      stateVersion: r.stateVersion,
      lastEventSequence: Number(r.lastEventSequence),
      resolvedMode: r.resolvedMode,
      policyContentHash: r.policySnapshotId ? (hashById.get(r.policySnapshotId) ?? null) : null,
      requestContentHash: r.requestContentHash,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeCursor(last.createdAt, last.id);
    }

    return { runs, nextCursor };
  }

  /**
   * Compute a bounded child-status summary for a run from durable child rows.
   * Children are same-root runs with depth > 0 and parent_run_id = this run.
   */
  private async computeChildSummary(
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<RunSnapshot['childSummary']> {
    const schema = this.db.schema;
    const children = await this.db.drizzle
      .select({ status: schema.missionRuns.status })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.parentRunId, runId),
        ),
      );
    const summary = { running: 0, completed: 0, failed: 0, cancelled: 0, total: children.length };
    for (const c of children) {
      if (
        c.status === 'running' ||
        c.status === 'queued' ||
        c.status === 'planning' ||
        c.status === 'synthesizing' ||
        c.status === 'awaiting_input' ||
        c.status === 'awaiting_approval'
      ) {
        summary.running += 1;
      } else if (c.status === 'completed') {
        summary.completed += 1;
      } else if (c.status === 'failed') {
        summary.failed += 1;
      } else if (c.status === 'cancelled') {
        summary.cancelled += 1;
      }
    }
    return summary;
  }

  private async readCurrentQuestionSet(
    companyId: string,
    runId: string,
    questionSetId: string | null,
  ): Promise<RunSnapshot['currentQuestionSet']> {
    if (!questionSetId) {
      return null;
    }
    const schema = this.db.schema;

    const [questionSet] = await this.db.drizzle
      .select()
      .from(schema.runQuestionSets)
      .where(
        and(
          eq(schema.runQuestionSets.companyId, companyId),
          eq(schema.runQuestionSets.id, questionSetId),
        ),
      )
      .limit(1);

    if (!questionSet || questionSet.status !== 'open') {
      return null;
    }

    const questions = await this.db.drizzle
      .select()
      .from(schema.runQuestions)
      .where(eq(schema.runQuestions.questionSetId, questionSet.id))
      .orderBy(schema.runQuestions.order);

    return {
      id: questionSet.id,
      ordinal: questionSet.ordinal,
      version: questionSet.version,
      status: questionSet.status,
      invalidationReason: questionSet.invalidationReason,
      createdAt: questionSet.createdAt.toISOString(),
      questions: questions.map((q) => ({
        questionKey: q.questionKey,
        order: q.order,
        type: q.type,
        label: q.label,
        help: q.help,
        required: q.required === 1,
        default: q.defaultValue,
        options: q.options,
        validation: q.validation,
      })),
    };
  }

  private toSnapshot(
    run: MissionRunRow,
    reservation: BudgetReservationRow | undefined,
    policyContentHash: string | null,
    policyRow: EidolonDbSchema['runPolicySnapshots']['$inferSelect'] | null,
    childSummary: RunSnapshot['childSummary'],
    queueHealth: QueueHealth,
    currentQuestionSet: RunSnapshot['currentQuestionSet'],
    deadlineAt: string | null,
    remainingWallMs: number | null,
    subthreadId: string | null,
  ): RunSnapshot {
    const { companyId, projectId } = run;
    return {
      id: run.id,
      companyId: run.companyId,
      projectId: run.projectId,
      projectThreadId: run.projectThreadId,
      rootRunId: run.rootRunId,
      parentRunId: run.parentRunId,
      retryOfRunId: run.retryOfRunId,
      depth: run.depth,
      childOrdinal: run.childOrdinal,
      routingKind: run.routingKind,
      status: run.status,
      stateVersion: run.stateVersion,
      lastEventSequence: Number(run.lastEventSequence),
      resolvedMode: run.resolvedMode,
      modeProfileId: run.modeProfileId,
      policySnapshotId: run.policySnapshotId,
      policyContentHash,
      policy: policyRow
        ? {
            schemaVersion: policyRow.schemaVersion,
            sourceProfile: policyRow.sourceProfile,
            sourceProfileName: policyRow.sourceProfileName,
            sourceProfileDescription: policyRow.sourceProfileDescription,
            sourceProfileVersion: policyRow.sourceProfileVersion,
            provider: policyRow.provider,
            adapterId: policyRow.adapterId,
            model: policyRow.model,
            reasoningDepth: policyRow.reasoningDepth,
            systemPromptHash: policyRow.systemPromptHash,
            instructionHash: policyRow.instructionHash,
            toolAllowlist: policyRow.toolAllowlist,
            domainAllowlist: policyRow.domainAllowlist,
            researchPolicy: policyRow.researchPolicy,
            planningPolicy: policyRow.planningPolicy,
            approvalPolicy: policyRow.approvalPolicy,
            fallbackPolicy: policyRow.fallbackPolicy,
            partialResultPolicy: policyRow.partialResultPolicy,
            limits: policyRow.limits,
          }
        : null,
      requestContentHash: run.requestContentHash,
      currentQuestionSetId: run.currentQuestionSetId,
      currentPlanRevisionId: run.currentPlanRevisionId,
      approvedPlanRevisionId: run.approvedPlanRevisionId,
      waitingFromStatus: run.waitingFromStatus,
      partialResultPolicy: run.partialResultPolicy,
      cancelRequestedAt: run.cancelRequestedAt ? run.cancelRequestedAt.toISOString() : null,
      cancelRequestedBy: run.cancelRequestedBy,
      cancellationDeadlineAt: run.cancellationDeadlineAt
        ? run.cancellationDeadlineAt.toISOString()
        : null,
      failureCategory: run.failureCategory,
      failureCode: run.failureCode,
      safeErrorMessage: run.safeErrorMessage,
      resultCompleteness: (run.resultCompleteness as 'full' | 'partial' | null) ?? null,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      terminalAt: run.terminalAt ? run.terminalAt.toISOString() : null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      attemptCount: run.attemptCount,
      providerCallCount: run.providerCallCount,
      descendantCount: run.descendantCount,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      outputBytes: run.outputBytes,
      actualCostCents: run.actualCostCents,
      budget: {
        reservedCents: reservation ? reservation.reservedCents : 0,
        settledCents: reservation ? reservation.settledCents : 0,
        releasedCents: reservation ? reservation.releasedCents : 0,
        costCentsCeiling: reservation ? reservation.reservedCents : 0,
        actualCostCents: run.actualCostCents,
      },
      childSummary,
      artifacts: [],
      links: {
        ui: buildMissionUiLink({
          companyId,
          projectId,
          threadId: run.projectThreadId,
          runId: run.id,
        }),
      },
      subthreadId,
      queueHealth,
      deadlineAt,
      remainingWallMs,
      currentQuestionSet,
    };
  }
}
