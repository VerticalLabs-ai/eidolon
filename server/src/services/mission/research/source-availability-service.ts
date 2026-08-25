/**
 * Source availability refresh: an explicit, nonmutating availability check
 * linked to an immutable source revision.
 *
 * (architecture.md: VAL-RES-119)
 *
 * `POST .../source-revisions/:sourceRevisionId/availability-checks` is an
 * authorized, idempotent, separately budgeted and cancellable logical call
 * under current URL/network policy. It appends availability metadata linked
 * to the immutable revision but NEVER mutates the source revision,
 * citation, artifact, or original retrieval. No automatic polling occurs,
 * and browser external-link failure alone changes no provenance state.
 *
 * The check is itself a budgeted research attempt (so its cost settles
 * exactly once), but it records only availability metadata (status, HTTP
 * status, bounded safe warning) — never provider bodies, credentials, or
 * retrieved content.
 */

import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../middleware/error-handler.js';
import type { DbInstance } from '../../../types.js';
import { SourceRevisionService } from './source-revision-service.js';

export interface AvailabilityCheckDeps {
  clock?: () => Date;
}

/** Input for an availability check. */
export interface AvailabilityCheckInput {
  companyId: string;
  projectId?: string;
  runId: string;
  rootRunId: string;
  sourceRevisionId: string;
  /** Deterministic logical call id for the availability-check call. */
  logicalCallId: string;
  /** Idempotency key (bounded safe characters). */
  idempotencyKey: string;
  /** Linked budgeted research attempt id. */
  attemptId?: string;
  /** Result of the URL/network availability probe. */
  status: 'available' | 'unavailable' | 'unknown';
  httpStatus?: number;
  /** Bounded safe warning/reason (no credentials, no body). */
  warning?: string;
}

/** Result of an availability check record. */
export interface AvailabilityCheckResult {
  id: string;
  sourceRevisionId: string;
  status: string;
  httpStatus?: number;
  warning?: string;
  createdAt: string;
  /** True if this was a replay of an existing check (idempotent). */
  replayed: boolean;
}

export class SourceAvailabilityService {
  private readonly clock: () => Date;
  private readonly sourceRevisions: SourceRevisionService;

  constructor(
    private db: DbInstance,
    deps: AvailabilityCheckDeps = {},
  ) {
    this.clock = deps.clock ?? (() => new Date());
    this.sourceRevisions = new SourceRevisionService({
      drizzle: db.drizzle,
      schema: db.schema,
    });
  }

  /**
   * Record an availability check for an immutable source revision. The
   * check is idempotent per `(sourceRevisionId, idempotencyKey)`: a repeated
   * request with the same key returns the original record. The source
   * revision, citation, artifact, and original retrieval are never mutated.
   *
   * This method does NOT perform the network probe itself; the caller
   * performs the bounded, cancellable URL/network check under current
   * policy and passes the safe result. The service only persists the
   * nonmutating availability record.
   */
  async recordAvailabilityCheck(input: AvailabilityCheckInput): Promise<AvailabilityCheckResult> {
    // Verify the source revision exists and is same-scope (non-enumerating
    // 404 for cross-scope, VAL-RES-022).
    const revision = await this.sourceRevisions.getSourceRevision(
      input.companyId,
      input.projectId,
      input.sourceRevisionId,
    );
    if (!revision) {
      throw new AppError(404, 'SOURCE_REVISION_NOT_FOUND', 'Source revision not found');
    }

    // If a budgeted attempt is linked, verify it belongs to the same run
    // and company so a caller cannot attribute its availability check to a
    // foreign attempt (defense in depth; settlement authority is still
    // enforced separately by the accounting service).
    if (input.attemptId) {
      const [attempt] = (await this.db.drizzle.execute(sql`
        SELECT 1 FROM "research_attempts"
        WHERE "id" = ${input.attemptId}
          AND "run_id" = ${input.runId}
          AND "company_id" = ${input.companyId}
        LIMIT 1
      `)) as unknown as { 1: number }[];
      if (!attempt) {
        throw new AppError(404, 'RESEARCH_ATTEMPT_NOT_FOUND', 'Research attempt not found');
      }
    }

    // Idempotent: check for an existing record with the same key.
    const existing = (await this.db.drizzle.execute(sql`
      SELECT "id", "source_revision_id", "status", "http_status", "warning", "created_at"
      FROM "research_source_availability_checks"
      WHERE "source_revision_id" = ${input.sourceRevisionId}
        AND "idempotency_key" = ${input.idempotencyKey}
      LIMIT 1
    `)) as unknown as {
      id: string;
      source_revision_id: string;
      status: string;
      http_status: number | null;
      warning: string | null;
      created_at: Date;
    }[];

    if (existing.length > 0) {
      const r = existing[0]!;
      return {
        id: r.id,
        sourceRevisionId: r.source_revision_id,
        status: r.status,
        httpStatus: r.http_status ?? undefined,
        warning: r.warning ?? undefined,
        createdAt: new Date(r.created_at).toISOString(),
        replayed: true,
      };
    }

    const id = randomUUID();
    // Use ISO 8601 string for raw SQL templates so PostgreSQL always
    // receives a parseable timestamp (fix-ut-m5-date-serialization-sweep).
    const now = this.clock().toISOString();
    await this.db.drizzle.execute(sql`
      INSERT INTO "research_source_availability_checks"
        ("id","company_id","project_id","run_id","root_run_id","source_revision_id",
         "logical_call_id","attempt_id","checked_url","status","http_status",
         "warning","idempotency_key","created_at")
      VALUES
        (${id}, ${input.companyId}, ${input.projectId ?? null}, ${input.runId},
         ${input.rootRunId}, ${input.sourceRevisionId},
         ${input.logicalCallId}, ${input.attemptId ?? null},
         ${revision.canonicalUrl}, ${input.status}, ${input.httpStatus ?? null},
         ${input.warning ?? null}, ${input.idempotencyKey}, ${now})
    `);

    return {
      id,
      sourceRevisionId: input.sourceRevisionId,
      status: input.status,
      httpStatus: input.httpStatus,
      warning: input.warning,
      createdAt: now,
      replayed: false,
    };
  }

  /**
   * List bounded availability-check records for a source revision, scoped
   * by company and project. Returns only safe metadata.
   */
  async listAvailabilityChecks(
    companyId: string,
    projectId: string | undefined,
    sourceRevisionId: string,
  ): Promise<
    {
      id: string;
      status: string;
      httpStatus?: number;
      warning?: string;
      createdAt: string;
    }[]
  > {
    // Verify scope first (non-enumerating 404 for cross-scope).
    const revision = await this.sourceRevisions.getSourceRevision(
      companyId,
      projectId,
      sourceRevisionId,
    );
    if (!revision) {
      throw new AppError(404, 'SOURCE_REVISION_NOT_FOUND', 'Source revision not found');
    }

    const rows = (await this.db.drizzle.execute(sql`
      SELECT "id", "status", "http_status", "warning", "created_at"
      FROM "research_source_availability_checks"
      WHERE "source_revision_id" = ${sourceRevisionId}
        AND "company_id" = ${companyId}
      ORDER BY "created_at" DESC
      LIMIT 100
    `)) as unknown as {
      id: string;
      status: string;
      http_status: number | null;
      warning: string | null;
      created_at: Date;
    }[];

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      httpStatus: r.http_status ?? undefined,
      warning: r.warning ?? undefined,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
