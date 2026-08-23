import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import {
  resolvePolicy,
  resolveCustomPolicy,
  policyContentHash,
  canonicalHash,
  checkAgentEligibility,
  previewPolicy,
  type ResolvedPolicy,
  type CustomProfileConfig,
  type CompanyPolicyInput,
  type UserReductions,
  type PolicyPreview,
  type PreviewKeyInputs,
} from './policy.js';
// requestContentHash is no longer used; start hashes the complete canonical
// request body (mode, limits, projectThreadId, initiatingAgentId, request)
// so different mode/limits with the same request text conflict.
import type { BuiltInMode, MissionMode, ModeLimits } from './modes.js';
import { classifyRequest, type ClassificationResult } from './mode-classifier.js';
import { BudgetService } from './budget.js';
import {
  incrementMissionRunStarted,
  incrementMissionBudgetDenial,
} from '../../middleware/observability.js';
import type { ProjectionSurface } from './projection.js';
import { validateAndEncryptIngress, encryptStartPayload } from './ingress.js';
import { validateIdempotencyKey } from './idempotency.js';

/**
 * Mission start service.
 *
 * Atomically commits one complete durable aggregate in a single Postgres
 * transaction: the run, immutable request + policy snapshots, finite root
 * budget reservation + allocation, the applied start command, and the
 * ordered initial creation/mode/policy/budget events. A failure after any
 * internal write rolls back the entire aggregate so no partial run, command,
 * reservation, projection, or spend is ever visible.
 */

export interface StartRequestBody {
  projectThreadId: string;
  mode: MissionMode;
  /** Required when mode is 'custom': the custom profile ID to use. */
  modeProfileId?: string;
  initiatingAgentId?: string;
  request: {
    text: string;
    attachments?: string[];
    context?: Record<string, unknown>;
  };
  limits?: {
    costCents?: number;
    totalTokens?: number;
    durationSeconds?: number;
    providerCalls?: number;
    steps?: number;
    outputBytes?: number;
  };
  /** User reductions: tools/domains the user explicitly removes (narrowing only, VAL-MODEQ-036). */
  removedTools?: string[];
  removedDomains?: string[];
}

export interface StartInput {
  companyId: string;
  projectId: string;
  /** Idempotency key from the Idempotency-Key header (1-128 safe chars). */
  idempotencyKey: string;
  body: StartRequestBody;
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  traceId?: string | null;
}

export interface StartResult {
  run: RunSnapshot;
  command: CommandSummary;
}

export interface RunSnapshot {
  id: string;
  companyId: string;
  projectId: string;
  projectThreadId: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  resolvedMode: string;
  policySnapshotId: string | null;
  policyContentHash: string | null;
  requestContentHash: string;
  createdAt: string;
  updatedAt: string;
  budget: {
    reservedCents: number;
    settledCents: number;
    releasedCents: number;
    costCentsCeiling: number;
  };
}

export interface CommandSummary {
  id: string;
  type: string;
  idempotencyKey: string;
  status: string;
  resultStatusCode: number;
  createdAt: string;
  appliedAt: string;
  traceId: string | null;
}

/** Test-only failpoint hook. Throwing aborts the transaction. */
export type FailpointHook =
  | 'after_policy'
  | 'after_run'
  | 'after_reservation'
  | 'after_command'
  | 'after_events'
  | 'after_enqueue';

export interface MissionStartDeps {
  clock?: () => Date;
  /** Test-only: throw from the named hook to prove atomic rollback. */
  failpoint?: { at: FailpointHook; throw: () => Error };
  /** Test-only: fail the projection to the named surface after the
   *  authoritative transaction commits. The run remains intact; the
   *  projection is recorded as failed and retryable. */
  projectionFailpoint?: { surface: ProjectionSurface };
}

export class MissionStartService {
  constructor(
    private db: DbInstance,
    private deps: MissionStartDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private fireFailpoint(at: FailpointHook): void {
    if (this.deps.failpoint?.at === at) {
      throw this.deps.failpoint.throw();
    }
  }

  /**
   * Determine whether a run should be enqueued (draft→queued) immediately
   * after the start aggregate commits. Modes that require mandatory
   * planning (planning='always') or mandatory approval (approval='always')
   * stay in draft; their draft→planning transition is owned by a later
   * milestone. Modes with 'when_complex' or 'never' planning/approval are
   * enqueued — without a complexity classifier yet, 'when_complex' is
   * treated as simple (the default), connecting the start service to the
   * worker so runs actually progress.
   */
  private shouldEnqueue(policy: ResolvedPolicy): boolean {
    const planningStrategy = (policy.planningPolicy as { strategy?: string })?.strategy;
    const approvalStrategy = (policy.approvalPolicy as { strategy?: string })?.strategy;
    return planningStrategy !== 'always' && approvalStrategy !== 'always';
  }

  async start(input: StartInput): Promise<StartResult> {
    const { companyId, projectId, body, actorType, actorId, traceId } = input;
    const schema = this.db.schema;
    const now = this.now();
    // Defense-in-depth: validate the idempotency key at the service boundary
    // before any database query or state change (VAL-RUN-114). The route
    // also validates, but Node's HTTP parser strips leading/trailing OWS
    // from header values per RFC 7230 before Express sees them, so this
    // service-level check is the authoritative seam for callers that reach
    // the service directly (internal calls, tests, non-OWS Unicode
    // whitespace that survives HTTP parsing).
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);

    // 1. Idempotency replay/conflict check (start is scoped by project).
    const existing = await this.lookupStartCommand(companyId, projectId, idempotencyKey);
    if (existing) {
      return await this.replayOrConflict(existing, body);
    }

    // 2. Validate thread ownership (same company + project). Non-enumerating 404.
    await this.validateThread(companyId, projectId, body.projectThreadId);

    // 3. Ingress hardening: structural bounds + reference validation +
    //    encryption (VAL-RUN-133, VAL-RUN-134, VAL-RUN-135). Runs BEFORE any
    //    database writes so a validation failure creates no run, applied
    //    command, reservation, projection, provider/tool call, or metadata
    //    leak. All references (attachments, context UUIDs) are validated
    //    against the database for same-company, same-project, present, and
    //    accessible. The request envelope is encrypted at rest.
    const ingress = await validateAndEncryptIngress(this.db, {
      companyId,
      projectId,
      text: body.request.text,
      attachments: body.request.attachments,
      context: body.request.context,
    });

    // 4. Resolve the initiating agent (provider/model/tools/status) if provided.
    const agent = body.initiatingAgentId
      ? await this.lookupAgent(companyId, body.initiatingAgentId)
      : undefined;

    // 4a. Read company governance (mission policy from company settings).
    //     This is the company layer in the deny-biased precedence
    //     (VAL-MODEQ-035, VAL-CROSS-008).
    const companyPolicy = await this.lookupCompanyPolicy(companyId);

    // 4b. For custom mode, resolve the custom profile from the database.
    let customProfile: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      config: Record<string, unknown>;
      version: number;
      enabled: boolean;
    } | null = null;
    if (body.mode === 'custom') {
      if (!body.modeProfileId) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'modeProfileId is required when mode is "custom"',
        );
      }
      const { ModeRegistryService } = await import('./mode-registry.js');
      const registry = new ModeRegistryService(this.db);
      customProfile = await registry.resolveProfileForStart(companyId, body.modeProfileId);
    }

    // 5. Resolve the effective policy.
    //    For Auto mode, the deterministic complexity classifier runs over
    //    validated request metadata to select a concrete mode (Fast, Deep
    //    Work, or Analyst) before policy resolution. The classifier does not
    //    use external/retrieved content — resolution is complete before any
    //    research is performed (VAL-MODEQ-021..025, VAL-MODEQ-146).
    const { policy, autoClassification } = await this.resolveStartPolicy(
      body,
      agent,
      customProfile,
      companyPolicy,
    );

    // Hash the COMPLETE canonical request body (mode, limits, projectThreadId,
    // initiatingAgentId, request, modeProfileId) so that different mode/limits
    // with the same request text conflict (HIGH-RISK REPAIR: complete-body
    // start hash).
    const reqHash = canonicalHash({
      mode: body.mode,
      modeProfileId: body.modeProfileId ?? null,
      projectThreadId: body.projectThreadId,
      initiatingAgentId: body.initiatingAgentId ?? null,
      request: body.request,
      limits: body.limits ?? null,
      removedTools: body.removedTools ?? null,
      removedDomains: body.removedDomains ?? null,
    });
    const policyHash = policyContentHash(policy);
    const ceiling = policy.limits.costCents;

    // 5. One atomic transaction committing the entire aggregate.
    try {
      const result = await this.db.drizzle.transaction(async (tx) => {
        // 5a. Immutable policy snapshot.
        const [policyRow] = await tx
          .insert(schema.runPolicySnapshots)
          .values({
            companyId,
            schemaVersion: policy.schemaVersion,
            sourceProfile: policy.sourceProfile,
            sourceProfileName: policy.sourceProfileName ?? null,
            sourceProfileDescription: policy.sourceProfileDescription ?? null,
            sourceProfileVersion: policy.sourceProfileVersion ?? null,
            provider: policy.provider,
            adapterId: policy.adapterId,
            model: policy.model,
            reasoningDepth: policy.reasoningDepth,
            systemPromptHash: policy.systemPromptHash,
            instructionHash: policy.instructionHash,
            toolAllowlist: policy.toolAllowlist,
            domainAllowlist: policy.domainAllowlist,
            researchPolicy: policy.researchPolicy,
            planningPolicy: policy.planningPolicy,
            approvalPolicy: policy.approvalPolicy,
            fallbackPolicy: policy.fallbackPolicy,
            partialResultPolicy: policy.partialResultPolicy,
            limits: policy.limits as unknown as Record<string, number>,
            contentHash: policyHash,
            createdAt: now,
          })
          .returning({ id: schema.runPolicySnapshots.id });
        const policySnapshotId = policyRow.id;

        this.fireFailpoint('after_policy');

        // 5b. Run row. root_run_id equals its own id for a root run; the id is
        // generated up front so the root-self check constraint holds on insert.
        const runId = randomUUID();
        await tx.insert(schema.missionRuns).values({
          id: runId,
          companyId,
          projectId,
          projectThreadId: body.projectThreadId,
          rootRunId: runId,
          depth: 0,
          initiatingUserId: actorType === 'user' ? actorId : null,
          initiatingAgentId: body.initiatingAgentId ?? null,
          billingAgentId: body.initiatingAgentId ?? null,
          routingKind: 'company_agent',
          requestEnvelope: ingress.encryptedEnvelope,
          requestContentHash: reqHash,
          requestSafeSummary: ingress.safeSummary,
          modeProfileId: customProfile?.id ?? null,
          resolvedMode: policy.resolvedMode,
          policySnapshotId,
          status: 'draft',
          stateVersion: 1,
          lastEventSequence: 0,
          partialResultPolicy: policy.partialResultPolicy,
          createdAt: now,
          updatedAt: now,
        });

        this.fireFailpoint('after_run');

        // 5c. Finite root budget reservation + initial allocation. The
        //     budget module locks company + billing agent in stable order,
        //     checks headroom, and creates the reservation + allocation
        //     atomically. Throws 409 BUDGET_UNAVAILABLE when headroom is
        //     insufficient (VAL-RUN-061, VAL-CROSS-061).
        const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        const budgetService = new BudgetService(this.db, { clock: () => now });
        const budgetResult = await budgetService.reserveRoot(tx, {
          companyId,
          runId,
          billingAgentId: body.initiatingAgentId ?? null,
          requestedCents: ceiling,
          periodKey,
        });
        const reservedCents = budgetResult.reservedCents;

        this.fireFailpoint('after_reservation');

        // 5d. Applied start command with a placeholder result_body; the
        //     exact replayable result is stored at the end of the tx after
        //     all writes are committed (HIGH-RISK REPAIR: atomic replay
        //     persistence — the result_body is persisted atomically with the
        //     initial aggregate, not after the tx commits).
        const [commandRow] = await tx
          .insert(schema.runCommands)
          .values({
            companyId,
            projectId,
            runId,
            type: 'run.start',
            idempotencyKey,
            requestHash: reqHash,
            payload: encryptStartPayload({
              request: body.request,
              mode: body.mode,
              limits: body.limits ?? null,
            } as Record<string, unknown>),
            actorType,
            actorId: actorId ?? null,
            status: 'applied',
            resultStatusCode: 202,
            resultBody: { runId } as Record<string, unknown>,
            traceId: traceId ?? null,
            createdAt: now,
            appliedAt: now,
          })
          .returning();

        this.fireFailpoint('after_command');

        // 5e. Ordered initial events: creation, mode, policy, budget.
        const events = [
          { type: 'run.created', payload: { runId, status: 'draft' } },
          {
            type: 'mode.resolved',
            payload: {
              mode: body.mode,
              resolvedMode: policy.resolvedMode,
              ...(customProfile
                ? { profileSlug: customProfile.slug, profileVersion: customProfile.version }
                : {}),
              ...(autoClassification
                ? {
                    classifierVersion: autoClassification.classifierVersion,
                    reasons: autoClassification.reasons,
                  }
                : {}),
            },
          },
          { type: 'policy.snapshotted', payload: { policySnapshotId, contentHash: policyHash } },
          { type: 'budget.reserved', payload: { reservedCents, periodKey } },
        ];
        let seq = 0;
        for (const event of events) {
          seq += 1;
          await tx.insert(schema.runEvents).values({
            companyId,
            projectId,
            runId,
            sequence: seq,
            type: event.type,
            schemaVersion: 1,
            payload: event.payload,
            commandId: commandRow.id,
            actorType,
            actorId: actorId ?? null,
            traceId: traceId ?? null,
            occurredAt: now,
          });
        }

        // 5f. Advance the run's event counter.
        await tx
          .update(schema.missionRuns)
          .set({ lastEventSequence: seq, updatedAt: now })
          .where(eq(schema.missionRuns.id, runId));

        this.fireFailpoint('after_events');

        // 5g. Enqueue step: for Fast/simple modes that don't require
        //     mandatory planning or approval, transition the run from
        //     draft → queued so the orchestration worker can claim and
        //     progress it. Modes with planning='always' or approval='always'
        //     (e.g. Deep Work, Analyst) stay in draft; their draft→planning
        //     transition is owned by a later milestone.
        //
        //     The run starts in draft (event 1: run.created with
        //     status:'draft') and then transitions to queued within the
        //     same atomic transaction, recording a run.status_changed
        //     event. This connects the start service to the worker —
        //     without this step, runs would be stranded in draft and the
        //     worker (which only claims queued/running/synthesizing) could
        //     never progress them.
        let finalStatus: string = 'draft';
        let finalStateVersion = 1;
        if (this.shouldEnqueue(policy)) {
          seq += 1;
          finalStatus = 'queued';
          finalStateVersion = 2;
          await tx.insert(schema.runEvents).values({
            companyId,
            projectId,
            runId,
            sequence: seq,
            type: 'run.status_changed',
            schemaVersion: 1,
            payload: { from: 'draft', to: 'queued' },
            commandId: commandRow.id,
            actorType: 'system',
            actorId: null,
            traceId: traceId ?? null,
            occurredAt: now,
          });
          await tx
            .update(schema.missionRuns)
            .set({
              status: 'queued',
              availableAt: now,
              stateVersion: finalStateVersion,
              lastEventSequence: seq,
              updatedAt: now,
            })
            .where(eq(schema.missionRuns.id, runId));

          this.fireFailpoint('after_enqueue');
        }

        // 5h. Build the exact replayable result snapshot from the
        //     in-transaction data and persist it in the command's
        //     result_body within the same transaction. This ensures the
        //     replayable status, headers, and body are committed atomically
        //     with the initial aggregate (HIGH-RISK REPAIR: atomic replay
        //     persistence). A crash between the tx commit and a post-tx
        //     update can no longer leave a command without its replayable
        //     result.
        const built = this.buildStartResultFromTx({
          runId,
          commandId: commandRow.id,
          companyId,
          projectId,
          projectThreadId: body.projectThreadId,
          policySnapshotId,
          policyHash,
          reqHash,
          resolvedMode: policy.resolvedMode,
          ceiling,
          reservedCents,
          lastEventSequence: seq,
          finalStatus,
          finalStateVersion,
          now,
          commandCreatedAt: commandRow.createdAt,
          commandIdempotencyKey: idempotencyKey,
          traceId: traceId ?? null,
        });
        await tx
          .update(schema.runCommands)
          .set({ resultBody: built as unknown as Record<string, unknown> })
          .where(eq(schema.runCommands.id, commandRow.id));

        return built;
      });

      // Increment the run-started counter only for new runs, not replays
      // (VAL-RUN-078: idempotent replay must not count as a second run).
      incrementMissionRunStarted(policy.resolvedMode);

      // Project the run.created event to mutable surfaces (thread items,
      // activity log). Projection failure does NOT roll back the
      // authoritative state — it records a retryable error
      // (VAL-CROSS-075, VAL-RUN-099).
      await this.projectRunCreated(result, companyId, projectId, traceId ?? null);

      return result;
    } catch (err) {
      // Increment budget denial counter when budget is unavailable
      // (VAL-RUN-078). The error propagates after the counter is incremented.
      if (err instanceof AppError && err.code === 'BUDGET_UNAVAILABLE') {
        incrementMissionBudgetDenial();
      }
      // A unique-violation on the start idempotency index means a concurrent
      // identical start won; re-read and replay/conflict.
      if (this.isUniqueViolation(err)) {
        const existing = await this.lookupStartCommand(companyId, projectId, idempotencyKey);
        if (existing) {
          return await this.replayOrConflict(existing, body);
        }
      }
      throw err;
    }
  }

  /**
   * Build the exact replayable StartResult from in-transaction data without
   * re-reading from the database. This is called inside the start
   * transaction so the result_body is persisted atomically with the
   * initial aggregate (HIGH-RISK REPAIR: atomic replay persistence).
   */
  private buildStartResultFromTx(input: {
    runId: string;
    commandId: string;
    companyId: string;
    projectId: string;
    projectThreadId: string;
    policySnapshotId: string;
    policyHash: string;
    reqHash: string;
    resolvedMode: string;
    ceiling: number;
    reservedCents: number;
    lastEventSequence: number;
    finalStatus: string;
    finalStateVersion: number;
    now: Date;
    commandCreatedAt: Date;
    commandIdempotencyKey: string;
    traceId: string | null;
  }): StartResult {
    const nowIso = input.now.toISOString();
    return {
      run: {
        id: input.runId,
        companyId: input.companyId,
        projectId: input.projectId,
        projectThreadId: input.projectThreadId,
        status: input.finalStatus,
        stateVersion: input.finalStateVersion,
        lastEventSequence: input.lastEventSequence,
        resolvedMode: input.resolvedMode,
        policySnapshotId: input.policySnapshotId,
        policyContentHash: input.policyHash,
        requestContentHash: input.reqHash,
        createdAt: nowIso,
        updatedAt: nowIso,
        budget: {
          reservedCents: input.reservedCents,
          settledCents: 0,
          releasedCents: 0,
          costCentsCeiling: input.ceiling,
        },
      },
      command: {
        id: input.commandId,
        type: 'run.start',
        idempotencyKey: input.commandIdempotencyKey,
        status: 'applied',
        resultStatusCode: 202,
        createdAt: input.commandCreatedAt.toISOString(),
        appliedAt: input.commandCreatedAt.toISOString(),
        traceId: input.traceId,
      },
    };
  }

  /**
   * Resolve the effective policy for a start request. For Auto mode, run
   * the deterministic complexity classifier over validated request metadata
   * to select a concrete mode before policy resolution. The sourceProfile
   * for Auto is 'auto' (the selected mode), while resolvedMode is the
   * classified concrete mode (VAL-MODEQ-015, VAL-MODEQ-021..025).
   *
   * Returns the resolved policy and the Auto classification (null for
   * non-Auto modes).
   */
  private async resolveStartPolicy(
    body: StartRequestBody,
    agent: Awaited<ReturnType<MissionStartService['lookupAgent']>> | undefined,
    customProfile: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      config: Record<string, unknown>;
      version: number;
      enabled: boolean;
    } | null,
    companyPolicy?: CompanyPolicyInput,
  ): Promise<{ policy: ResolvedPolicy; autoClassification: ClassificationResult | null }> {
    // Build user reductions from the request body (limits + removed tools/domains).
    const userReductions: UserReductions = {
      ...body.limits,
      removedTools: body.removedTools,
      removedDomains: body.removedDomains,
    };

    if (body.mode === 'custom' && customProfile) {
      const policy = resolveCustomPolicy({
        profileSlug: customProfile.slug,
        profileVersion: customProfile.version,
        profileId: customProfile.id,
        profileName: customProfile.name,
        profileDescription: customProfile.description ?? null,
        config: customProfile.config as CustomProfileConfig,
        agent: agent
          ? {
              provider: agent.provider,
              adapterId: agent.adapterId ?? undefined,
              model: agent.model,
              toolAllowlist: agent.toolsEnabled ?? [],
              domainAllowlist: agent.allowedDomains ?? [],
              status: agent.status,
              capabilities: agent.capabilities ?? [],
            }
          : undefined,
        company: companyPolicy,
        userReductions,
      });
      return { policy, autoClassification: null };
    }

    let effectiveMode: BuiltInMode = body.mode as BuiltInMode;
    let autoClassification: ClassificationResult | null = null;
    if (body.mode === 'auto') {
      autoClassification = classifyRequest({
        text: body.request.text,
        context: body.request.context,
      });
      effectiveMode = autoClassification.resolvedMode;
    }
    const policy = resolvePolicy({
      mode: effectiveMode,
      agent: agent
        ? {
            provider: agent.provider,
            adapterId: agent.adapterId ?? undefined,
            model: agent.model,
            toolAllowlist: agent.toolsEnabled ?? [],
            domainAllowlist: agent.allowedDomains ?? [],
            status: agent.status,
            capabilities: agent.capabilities ?? [],
          }
        : undefined,
      company: companyPolicy,
      userReductions,
    });
    // For Auto, the source profile is the selected mode ('auto'), not the
    // classified concrete mode. The concrete mode is recorded in
    // resolvedMode and the mode.resolved event (VAL-MODEQ-015).
    if (autoClassification) {
      policy.sourceProfile = 'auto';
    }
    return { policy, autoClassification };
  }

  /**
   * Project the run.created event to mutable surfaces after the
   * authoritative transaction commits. Projection failure is caught and
   * recorded as a retryable error — it never rolls back the run.
   *
   * The test-only projectionFailpoint throws during a specific surface's
   * projection to exercise the failure/repair path.
   */
  private async projectRunCreated(
    result: StartResult,
    companyId: string,
    projectId: string,
    traceId: string | null,
  ): Promise<void> {
    const now = this.now();
    const event = {
      runId: result.run.id,
      companyId,
      projectId,
      sequence: 1,
      type: 'run.created',
      payload: { runId: result.run.id, status: 'draft' },
      actorType: 'user' as const,
      actorId: null,
      traceId,
      occurredAt: now,
    };

    const failSurface = this.deps.projectionFailpoint?.surface;
    const { MissionProjectionService } = await import('./projection.js');
    const projService = new MissionProjectionService(this.db, { clock: () => now });

    // Thread item projection.
    if (failSurface === 'thread_item') {
      await projService.recordProjectionFailure(
        this.db,
        event,
        'thread_item',
        new Error('Projection failpoint: thread_item'),
        now,
      );
    } else {
      try {
        await projService.projectThreadItem(event, now);
      } catch (err) {
        await projService.recordProjectionFailure(this.db, event, 'thread_item', err, now);
      }
    }

    // Activity log projection.
    if (failSurface === 'activity_log') {
      await projService.recordProjectionFailure(
        this.db,
        event,
        'activity_log',
        new Error('Projection failpoint: activity_log'),
        now,
      );
    } else {
      try {
        await projService.projectActivityLog(event, now);
      } catch (err) {
        await projService.recordProjectionFailure(this.db, event, 'activity_log', err, now);
      }
    }
  }

  /**
   * Compute a policy preview for a start request (VAL-MODEQ-126).
   *
   * The preview is labelled a preview (kind:'preview'), keyed by all
   * resolution inputs (company, project, thread, agent, classifier inputs,
   * profile ID/version, reductions). Changing any input invalidates the
   * preview key. Start always re-resolves transactionally — the preview
   * can never authorize a stale policy. The run card displays the actual
   * narrowed snapshot if it differs from the preview.
   *
   * This method does NOT create a run, command, reservation, or event.
   * It only resolves the effective policy and returns a preview summary.
   */
  async preview(input: StartInput): Promise<PolicyPreview> {
    const { companyId, projectId, body } = input;

    // Validate thread ownership (same company + project). Non-enumerating 404.
    await this.validateThread(companyId, projectId, body.projectThreadId);

    // Resolve the initiating agent if provided.
    const agent = body.initiatingAgentId
      ? await this.lookupAgent(companyId, body.initiatingAgentId)
      : undefined;

    // Read company governance.
    const companyPolicy = await this.lookupCompanyPolicy(companyId);

    // Resolve the custom profile if custom mode.
    let customProfile: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      config: Record<string, unknown>;
      version: number;
      enabled: boolean;
    } | null = null;
    if (body.mode === 'custom') {
      if (!body.modeProfileId) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'modeProfileId is required when mode is "custom"',
        );
      }
      const { ModeRegistryService } = await import('./mode-registry.js');
      const registry = new ModeRegistryService(this.db);
      customProfile = await registry.resolveProfileForStart(companyId, body.modeProfileId);
    }

    // Resolve the effective policy (same path as start — deny-biased).
    const { policy } = await this.resolveStartPolicy(body, agent, customProfile, companyPolicy);

    // Compute the preview key from all resolution inputs.
    const requestTextHash = canonicalHash(body.request.text);
    const contextHash = canonicalHash(body.request.context ?? null);
    const reductionsHash = canonicalHash({
      limits: body.limits ?? null,
      removedTools: body.removedTools ?? null,
      removedDomains: body.removedDomains ?? null,
    });
    const keyInputs: PreviewKeyInputs = {
      companyId,
      projectId,
      projectThreadId: body.projectThreadId,
      initiatingAgentId: body.initiatingAgentId ?? null,
      requestTextHash,
      contextHash,
      mode: body.mode,
      modeProfileId: body.modeProfileId ?? null,
      modeProfileVersion: customProfile?.version ?? null,
      reductionsHash,
    };

    return previewPolicy(policy, keyInputs);
  }

  private async lookupStartCommand(companyId: string, projectId: string, key: string) {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select()
      .from(schema.runCommands)
      .where(
        and(
          eq(schema.runCommands.companyId, companyId),
          eq(schema.runCommands.projectId, projectId),
          eq(schema.runCommands.idempotencyKey, key),
          eq(schema.runCommands.type, 'run.start'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async replayOrConflict(
    existing: {
      requestHash: string;
      runId: string | null;
      id: string;
      idempotencyKey: string;
      createdAt: Date;
      appliedAt: Date | null;
      resultBody: Record<string, unknown> | null;
      traceId: string | null;
    },
    body: StartRequestBody,
  ): Promise<StartResult> {
    const reqHash = canonicalHash({
      mode: body.mode,
      modeProfileId: body.modeProfileId ?? null,
      projectThreadId: body.projectThreadId,
      initiatingAgentId: body.initiatingAgentId ?? null,
      request: body.request,
      limits: body.limits ?? null,
      removedTools: body.removedTools ?? null,
      removedDomains: body.removedDomains ?? null,
    });
    if (existing.requestHash !== reqHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key already used for different content',
      );
    }
    if (!existing.runId) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key already used');
    }
    // Durable replay: return the exact stored result so a replay (even after
    // the run advanced) returns the original status, headers, and body
    // (VAL-RUN-052, VAL-RUN-116). Fall back to re-reading only if a legacy
    // command row predates stored results.
    const stored = existing.resultBody as {
      run?: StartResult['run'];
      command?: StartResult['command'];
    } | null;
    if (stored?.run && stored?.command) {
      return { run: stored.run, command: { ...stored.command, traceId: existing.traceId ?? null } };
    }
    const [run] = await this.db.drizzle
      .select()
      .from(this.db.schema.missionRuns)
      .where(eq(this.db.schema.missionRuns.id, existing.runId))
      .limit(1);
    const [reservation] = await this.db.drizzle
      .select()
      .from(this.db.schema.budgetReservations)
      .where(eq(this.db.schema.budgetReservations.runId, existing.runId))
      .limit(1);
    let policyContentHash: string | null = null;
    if (run.policySnapshotId) {
      const [policy] = await this.db.drizzle
        .select({ contentHash: this.db.schema.runPolicySnapshots.contentHash })
        .from(this.db.schema.runPolicySnapshots)
        .where(eq(this.db.schema.runPolicySnapshots.id, run.policySnapshotId))
        .limit(1);
      policyContentHash = policy?.contentHash ?? null;
    }
    return {
      run: {
        id: run.id,
        companyId: run.companyId,
        projectId: run.projectId,
        projectThreadId: run.projectThreadId,
        status: run.status,
        stateVersion: run.stateVersion,
        lastEventSequence: Number(run.lastEventSequence),
        resolvedMode: run.resolvedMode,
        policySnapshotId: run.policySnapshotId,
        policyContentHash,
        requestContentHash: run.requestContentHash,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        budget: {
          reservedCents: reservation.reservedCents,
          settledCents: reservation.settledCents,
          releasedCents: reservation.releasedCents,
          costCentsCeiling: reservation.reservedCents,
        },
      },
      command: {
        id: existing.id,
        type: 'run.start',
        idempotencyKey: existing.idempotencyKey,
        status: 'applied',
        resultStatusCode: 202,
        createdAt: existing.createdAt.toISOString(),
        appliedAt: existing.appliedAt
          ? existing.appliedAt.toISOString()
          : existing.createdAt.toISOString(),
        traceId: existing.traceId ?? null,
      },
    };
  }

  private async validateThread(
    companyId: string,
    projectId: string,
    threadId: string,
  ): Promise<void> {
    const schema = this.db.schema;
    const [thread] = await this.db.drizzle
      .select({ id: schema.projectThreads.id })
      .from(schema.projectThreads)
      .where(
        and(
          eq(schema.projectThreads.id, threadId),
          eq(schema.projectThreads.companyId, companyId),
          eq(schema.projectThreads.projectId, projectId),
        ),
      )
      .limit(1);
    if (!thread) {
      throw new AppError(404, 'THREAD_NOT_FOUND', 'Choose a thread from this project.');
    }
  }

  private async lookupAgent(companyId: string, agentId: string) {
    const schema = this.db.schema;
    const [agent] = await this.db.drizzle
      .select({
        id: schema.agents.id,
        provider: schema.agents.provider,
        adapterId: schema.agents.adapterId,
        model: schema.agents.model,
        toolsEnabled: schema.agents.toolsEnabled,
        allowedDomains: schema.agents.allowedDomains,
        status: schema.agents.status,
        capabilities: schema.agents.capabilities,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, agentId), eq(schema.agents.companyId, companyId)))
      .limit(1);
    if (!agent) {
      throw new AppError(404, 'AGENT_NOT_FOUND', 'Choose an agent from this company.');
    }
    // Check agent eligibility for Mission start (VAL-MODEQ-123): reject
    // inactive (paused/error/offline) agents with POLICY_UNSATISFIABLE.
    checkAgentEligibility(
      {
        id: agent.id,
        provider: agent.provider,
        adapterId: agent.adapterId ?? undefined,
        model: agent.model,
        toolAllowlist: agent.toolsEnabled ?? [],
        domainAllowlist: agent.allowedDomains ?? [],
        status: agent.status,
        capabilities: agent.capabilities ?? [],
      },
      undefined,
    );
    return agent;
  }

  /**
   * Read company governance (mission policy) from company settings.
   * Returns undefined if no mission policy is configured (no restriction
   * at the company layer). The settings are stored in
   * `companies.settings.missionPolicy` (VAL-MODEQ-035, VAL-CROSS-008).
   */
  private async lookupCompanyPolicy(companyId: string): Promise<CompanyPolicyInput | undefined> {
    const schema = this.db.schema;
    const [company] = await this.db.drizzle
      .select({ settings: schema.companies.settings })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    if (!company) {
      return undefined;
    }
    const settings = company.settings as Record<string, unknown>;
    const missionPolicy = settings.missionPolicy as Record<string, unknown> | undefined;
    if (!missionPolicy) {
      return undefined;
    }
    return {
      allowedProviders: (missionPolicy.allowedProviders as string[] | undefined)?.filter(
        (p): p is string => typeof p === 'string',
      ),
      allowedTools: (missionPolicy.allowedTools as string[] | undefined)?.filter(
        (t): t is string => typeof t === 'string',
      ),
      allowedDomains: (missionPolicy.allowedDomains as string[] | undefined)?.filter(
        (d): d is string => typeof d === 'string',
      ),
      deniedTools: (missionPolicy.deniedTools as string[] | undefined)?.filter(
        (t): t is string => typeof t === 'string',
      ),
      deniedDomains: (missionPolicy.deniedDomains as string[] | undefined)?.filter(
        (d): d is string => typeof d === 'string',
      ),
      limits: missionPolicy.limits as Partial<ModeLimits> | undefined,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    return code === '23505';
  }
}

/** Re-export for route/test use. */
export type { ResolvedPolicy };
export type { PolicyPreview, PreviewKeyInputs };
