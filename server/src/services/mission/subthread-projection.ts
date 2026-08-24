import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../../types.js';

/**
 * Mission Subthread Projection module (VAL-SUB-007, VAL-SUB-043,
 * VAL-SUB-102, VAL-SUB-104).
 *
 * Creates one dedicated nested `project_threads` subthread for each child
 * run and links it via `run_projection_links` with a deterministic
 * `surface_key` so repeated projection processing does not create duplicate
 * subthreads.
 *
 * Subthreads are company/project isolated: the `project_threads` row
 * carries `company_id` and `project_id`, and cross-scope reads return 404
 * (VAL-SUB-043). The `is_mission_subthread` flag marks the thread as a
 * read-only projection so generic thread/message/item mutations are rejected
 * (VAL-SUB-102). The `mission_run_id` column links the subthread to its
 * child run for authoritative linkage checks (VAL-SUB-104).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface SubthreadProjectionDeps {
  clock?: () => Date;
}

export interface SubthreadProjectionResult {
  /** The project_threads ID of the (existing or newly created) subthread. */
  threadId: string;
  /** Whether a new subthread was created in this call. */
  created: boolean;
}

export class SubthreadProjectionService {
  constructor(
    private db: DbInstance,
    private deps: SubthreadProjectionDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Idempotently create a dedicated nested subthread for a child run.
   *
   * Must be called inside the same transaction that creates the child run
   * (or as a separate idempotent step). The `surface_key`
   * `subthread:<runId>` is deterministic: a duplicate insert is a no-op,
   * not a second row (VAL-SUB-007).
   *
   * The subthread inherits the child run's company and project scope and
   * is marked `is_mission_subthread=true` with `mission_run_id` set to the
   * child run ID (VAL-SUB-043, VAL-SUB-102, VAL-SUB-104).
   */
  async projectChildSubthread(
    tx: Tx,
    input: {
      companyId: string;
      projectId: string;
      runId: string;
      /** Stable step title or label for the subthread title. */
      title: string;
      /** The root project thread ID (the parent conversation). */
      rootThreadId: string;
    },
  ): Promise<SubthreadProjectionResult> {
    const schema = this.db.schema;
    const now = this.now();
    const surfaceKey = `subthread:${input.runId}`;

    // Check for an existing projection link.
    const [existing] = await tx
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, input.companyId),
          eq(schema.runProjectionLinks.runId, input.runId),
          eq(schema.runProjectionLinks.surface, 'subthread'),
          eq(schema.runProjectionLinks.surfaceKey, surfaceKey),
        ),
      )
      .limit(1);

    if (existing && existing.status === 'active') {
      return { threadId: existing.surfaceId, created: false };
    }

    // Create the dedicated subthread.
    const threadId = randomUUID();
    await tx.insert(schema.projectThreads).values({
      id: threadId,
      companyId: input.companyId,
      projectId: input.projectId,
      title: input.title.slice(0, 500),
      type: 'conversation',
      status: 'active',
      createdByUserId: null,
      createdByAgentId: null,
      isMissionSubthread: true,
      missionRunId: input.runId,
      createdAt: now,
      updatedAt: now,
    });

    // Record the projection link.
    if (existing) {
      await tx
        .update(schema.runProjectionLinks)
        .set({
          surfaceId: threadId,
          status: 'active',
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.runProjectionLinks.id, existing.id));
    } else {
      await tx.insert(schema.runProjectionLinks).values({
        companyId: input.companyId,
        projectId: input.projectId,
        runId: input.runId,
        surface: 'subthread',
        surfaceId: threadId,
        surfaceKey,
        eventType: 'child.created',
        eventSequence: null,
        status: 'active',
        traceId: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { threadId, created: true };
  }

  /**
   * Look up the subthread for a child run, scoped to the given
   * company/project. Returns null if no subthread exists or if the
   * subthread belongs to a different scope (VAL-SUB-043).
   */
  async getSubthreadForRun(
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<{ threadId: string; title: string } | null> {
    const schema = this.db.schema;
    const [link] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, companyId),
          eq(schema.runProjectionLinks.runId, runId),
          eq(schema.runProjectionLinks.surface, 'subthread'),
          eq(schema.runProjectionLinks.status, 'active'),
        ),
      )
      .limit(1);

    if (!link) {
      return null;
    }

    // Verify the thread belongs to the same scope.
    const [thread] = await this.db.drizzle
      .select({ id: schema.projectThreads.id, title: schema.projectThreads.title })
      .from(schema.projectThreads)
      .where(
        and(
          eq(schema.projectThreads.id, link.surfaceId),
          eq(schema.projectThreads.companyId, companyId),
          eq(schema.projectThreads.projectId, projectId),
        ),
      )
      .limit(1);

    if (!thread) {
      return null;
    }

    return { threadId: thread.id, title: thread.title };
  }

  /**
   * Check whether a project thread is a Mission subthread (read-only).
   * Returns false if the thread does not exist or is not a Mission subthread.
   */
  async isMissionSubthread(
    companyId: string,
    projectId: string,
    threadId: string,
  ): Promise<boolean> {
    const schema = this.db.schema;
    const [thread] = await this.db.drizzle
      .select({ isMissionSubthread: schema.projectThreads.isMissionSubthread })
      .from(schema.projectThreads)
      .where(
        and(
          eq(schema.projectThreads.id, threadId),
          eq(schema.projectThreads.companyId, companyId),
          eq(schema.projectThreads.projectId, projectId),
        ),
      )
      .limit(1);

    return thread?.isMissionSubthread === true;
  }
}
