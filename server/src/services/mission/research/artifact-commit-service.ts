/**
 * Atomic artifact revision + citation + provenance commit.
 *
 * (architecture.md: ArtifactCommit module — commitArtifactWithProvenance,
 *  VAL-RES-032, VAL-RES-033, VAL-RES-100, VAL-CROSS-043)
 *
 * Each visible cited artifact revision commits with all citation and
 * provenance rows bound to its run, exact approved plan revision/hash,
 * policy hash, producing step/child, generation time, and cited source
 * revisions — in ONE database transaction. A persistence failpoint (a
 * citation scope rejection, a duplicate provenance row, or a stale
 * expected-version) rolls back the entire transaction, exposing neither a
 * partial artifact revision nor dangling citation/provenance rows.
 *
 * Concurrent expected-version edits are serialized by the artifact row
 * lock: exactly one caller wins and advances the version; every loser
 * observes the advanced version and receives a version-conflict error
 * before inserting any citation or provenance row.
 *
 * This module reuses the pure citation-identity and frozen-metadata
 * helpers (VAL-RES-097, VAL-RES-113) so quote/locator validation and
 * frozen display metadata are identical to `CitationService`. The
 * difference is atomicity: every row is written inside one transaction
 * rather than as independent auto-committed inserts.
 */

import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../middleware/error-handler.js';
import { encrypt } from '../../crypto.js';
import { encryptContent } from '../../content-encryption.js';
import { createCitationIdentity, type CitationLocator } from './citation-identity.js';
import { freezeDisplayMetadata } from './frozen-metadata.js';
import type { DbInstance } from '../../../types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ArtifactCommitServiceDeps {
  drizzle: DbInstance['drizzle'];
  schema: DbInstance['schema'];
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface CitationCommitInput {
  sourceRevisionId: string;
  ordinal: number;
  quote: string;
  /** Required when the quote is repeated in the source (VAL-RES-097). */
  locator?: CitationLocator;
  /** Normalized source text; required to verify the locator/uniqueness. */
  normalizedSourceText?: string;
  /** Frozen display metadata (VAL-RES-113). */
  frozenTitle?: string;
  frozenAuthor?: string;
  frozenCanonicalUrl: string;
  frozenRetrievedAt: string;
  frozenProvider: string;
  frozenContentHash?: string;
  /** Artifact locator: {artifactVersion, jsonPointer?, blockId?, start?, end?}. */
  artifactLocator?: Record<string, unknown>;
}

export interface ProvenanceCommitInput {
  approvedPlanRevisionId?: string;
  approvedPlanHash?: string;
  policyHash?: string;
  producingStepKey?: string;
  producingChildRunId?: string | null;
  generationTime: Date;
  /** Cited source revision IDs bound to this artifact revision. */
  citedSourceRevisionIds: string[];
}

export interface CommitArtifactWithProvenanceInput {
  companyId: string;
  projectId: string;
  runId: string;
  rootRunId: string;
  artifactId: string;
  /** Optimistic version check — must match the current artifact version. */
  expectedVersion: number;
  content: Record<string, unknown>;
  editSource: 'user' | 'agent' | 'system';
  editedByUserId?: string | null;
  editedByAgentId?: string | null;
  message?: string;
  citations: CitationCommitInput[];
  provenance: ProvenanceCommitInput;
}

export interface CommitResult {
  artifactRevisionId: string;
  version: number;
  citationIds: string[];
  provenanceId: string;
}

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ArtifactCommitService {
  constructor(private readonly deps: ArtifactCommitServiceDeps) {}

  /**
   * Atomically commit a new artifact revision together with all its
   * citations and provenance in one transaction.
   *
   * On any failure (stale expected-version, citation scope/quote rejection,
   * provenance constraint violation) the entire transaction rolls back:
   * no partial artifact revision, citation, or provenance row is visible
   * (VAL-RES-032, VAL-CROSS-043). Concurrent edits at the same expected
   * version yield exactly one winner; losers receive a version-conflict
   * error and leave no orphan rows (VAL-RES-100).
   */
  async commitArtifactWithProvenance(
    input: CommitArtifactWithProvenanceInput,
  ): Promise<CommitResult> {
    this.validateInput(input);

    return this.deps.drizzle.transaction(async (tx) => {
      const now = new Date();
      const newVersion = input.expectedVersion + 1;
      const artifactRevisionId = randomUUID();
      const provenanceId = randomUUID();
      const encryptedContent = encryptContent(input.content);

      // 0. Cancellation fence (VAL-RES-062, VAL-RES-063): check the run's
      //    status inside this transaction before any artifact, citation, or
      //    provenance row is written. If the run is cancelled or has a
      //    pending cancellation request, reject the commit so no late
      //    artifact becomes visible — even if the remote provider later
      //    returns. Prior evidence (source revisions) committed before
      //    cancellation remains immutable and auditable.
      await this.fenceCancelledRun(tx, input.companyId, input.runId);

      // 1. Lock the artifact row and verify the optimistic version
      //    (VAL-RES-100). FOR UPDATE serializes concurrent edits; a stale
      //    expectedVersion is rejected before any citation/provenance row
      //    is written.
      const [updated] = await tx
        .update(this.deps.schema.artifacts)
        .set({
          content: encryptedContent,
          version: newVersion,
          updatedAt: now,
          lastEditedByUserId: input.editedByUserId ?? null,
          lastEditedByAgentId: input.editedByAgentId ?? null,
        })
        .where(
          and(
            eq(this.deps.schema.artifacts.id, input.artifactId),
            eq(this.deps.schema.artifacts.companyId, input.companyId),
            eq(this.deps.schema.artifacts.version, input.expectedVersion),
          ),
        )
        .returning({ id: this.deps.schema.artifacts.id });

      if (!updated) {
        // Either the artifact is absent/cross-scope, or the version
        // advanced. Distinguish so callers can react to a version conflict.
        const [existing] = await tx
          .select({
            id: this.deps.schema.artifacts.id,
            version: this.deps.schema.artifacts.version,
          })
          .from(this.deps.schema.artifacts)
          .where(
            and(
              eq(this.deps.schema.artifacts.id, input.artifactId),
              eq(this.deps.schema.artifacts.companyId, input.companyId),
            ),
          )
          .limit(1);
        if (!existing) {
          throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found in scope');
        }
        throw new AppError(
          409,
          'ARTIFACT_VERSION_CONFLICT',
          'Artifact was updated by another client',
          { currentVersion: existing.version },
        );
      }

      // 2. Insert the new immutable artifact revision row.
      await tx.insert(this.deps.schema.artifactRevisions).values({
        id: artifactRevisionId,
        artifactId: input.artifactId,
        version: newVersion,
        content: encryptedContent,
        editedByUserId: input.editedByUserId ?? null,
        editedByAgentId: input.editedByAgentId ?? null,
        editSource: input.editSource,
        message: input.message ?? null,
      });

      // 3. Insert every citation bound to the exact new artifact revision.
      //    Each citation's source revision is scope-checked inside this
      //    transaction (VAL-RES-022); a foreign revision rolls back the
      //    whole commit (VAL-RES-032, VAL-CROSS-043).
      const citationIds: string[] = [];
      for (const c of input.citations) {
        const citationId = await this.insertCitation(
          tx,
          input,
          c,
          artifactRevisionId,
          newVersion,
          now,
        );
        citationIds.push(citationId);
      }

      // 4. Insert the artifact provenance row bound to the new revision,
      //    run, exact approved plan revision/hash, policy hash, producing
      //    step/child, generation time, and cited source revisions
      //    (VAL-RES-033). The unique index on artifact_revision_id makes a
      //    duplicate provenance row a transaction-level failure.
      await tx.execute(sql`
        INSERT INTO "artifact_provenance"
          ("id","company_id","project_id","run_id","root_run_id","artifact_id",
           "artifact_revision_id","approved_plan_revision_id","approved_plan_hash",
           "policy_hash","producing_step_key","producing_child_run_id","generation_time",
           "cited_source_revision_ids","created_at")
        VALUES
          (${provenanceId}, ${input.companyId}, ${input.projectId}, ${input.runId},
           ${input.rootRunId}, ${input.artifactId}, ${artifactRevisionId},
           ${input.provenance.approvedPlanRevisionId ?? null},
           ${input.provenance.approvedPlanHash ?? null},
           ${input.provenance.policyHash ?? null},
           ${input.provenance.producingStepKey ?? null},
           ${input.provenance.producingChildRunId ?? null},
           ${input.provenance.generationTime},
           ${JSON.stringify(input.provenance.citedSourceRevisionIds)}::jsonb,
           ${now})
      `);

      return {
        artifactRevisionId,
        version: newVersion,
        citationIds,
        provenanceId,
      };
    });
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Cancellation fence (VAL-RES-062, VAL-RES-063): query the run's status
   * and cancellation state inside the current transaction. If the run is
   * cancelled or has a pending cancellation request, throw `RUN_CANCELLED`
   * so the entire transaction rolls back — no artifact, citation, or
   * provenance row becomes visible. Prior evidence (source revisions)
   * committed independently before cancellation remains immutable.
   */
  private async fenceCancelledRun(tx: Tx, companyId: string, runId: string): Promise<void> {
    const rows = (await tx.execute(sql`
      SELECT "status", "cancel_requested_at"
      FROM "mission_runs"
      WHERE "id" = ${runId} AND "company_id" = ${companyId}
      LIMIT 1
    `)) as unknown as { status: string; cancel_requested_at: Date | null }[];

    if (rows.length === 0) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Run not found in scope');
    }

    const run = rows[0]!;
    if (run.status === 'cancelled' || run.cancel_requested_at !== null) {
      throw new AppError(
        409,
        'RUN_CANCELLED',
        'Cannot commit artifact for a cancelled or cancel-requested run',
      );
    }
  }

  /**
   * Validate the commit input shape before any database work. Keeps the
   * transaction body focused on atomic writes.
   */
  private validateInput(input: CommitArtifactWithProvenanceInput): void {
    if (!input.companyId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'companyId is required');
    }
    if (!input.projectId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'projectId is required');
    }
    if (!input.runId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'runId is required');
    }
    if (!input.rootRunId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'rootRunId is required');
    }
    if (!input.artifactId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'artifactId is required');
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new AppError(400, 'VALIDATION_ERROR', 'expectedVersion must be a positive integer');
    }
    if (!input.content || typeof input.content !== 'object') {
      throw new AppError(400, 'VALIDATION_ERROR', 'content is required');
    }
    if (!Array.isArray(input.citations)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'citations must be an array');
    }
    if (!input.provenance || !(input.provenance.generationTime instanceof Date)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'provenance.generationTime is required');
    }
    if (!Array.isArray(input.provenance.citedSourceRevisionIds)) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'provenance.citedSourceRevisionIds must be an array',
      );
    }
  }

  /**
   * Scope-check the source revision inside the transaction and insert a
   * citation row bound to the exact new artifact revision. Throws on a
   * cross-scope/absent source revision (VAL-RES-022), rolling back the
   * entire commit (VAL-RES-032, VAL-CROSS-043).
   */
  private async insertCitation(
    tx: Tx,
    input: CommitArtifactWithProvenanceInput,
    c: CitationCommitInput,
    artifactRevisionId: string,
    newVersion: number,
    now: Date,
  ): Promise<string> {
    // Scope-check the source revision (VAL-RES-022). A foreign-company or
    // absent revision is rejected inside the transaction so the whole
    // commit rolls back.
    const inScope = await this.isSourceRevisionInScope(
      tx,
      input.companyId,
      input.projectId,
      c.sourceRevisionId,
    );
    if (!inScope) {
      throw new AppError(404, 'SOURCE_REVISION_NOT_FOUND', 'source revision not found in scope');
    }

    // When the caller did not supply normalized source text, load + decrypt
    // it from the scoped revision so quote/locator validation runs against
    // the actual immutable revision content (VAL-RES-097).
    let normalizedSourceText = c.normalizedSourceText;
    if (normalizedSourceText === undefined) {
      normalizedSourceText = await this.fetchNormalizedSourceText(
        tx,
        input.companyId,
        input.projectId,
        c.sourceRevisionId,
      );
    }

    const identity = createCitationIdentity({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: input.runId,
      sourceRevisionId: c.sourceRevisionId,
      artifactId: input.artifactId,
      artifactRevisionId,
      ordinal: c.ordinal,
      quote: c.quote,
      locator: c.locator,
      normalizedSourceText,
      frozenTitle: c.frozenTitle,
      frozenAuthor: c.frozenAuthor,
      frozenCanonicalUrl: c.frozenCanonicalUrl,
      frozenRetrievedAt: c.frozenRetrievedAt,
      frozenProvider: c.frozenProvider,
      frozenContentHash: c.frozenContentHash,
    });

    const frozen = freezeDisplayMetadata({
      title: identity.frozenTitle,
      author: identity.frozenAuthor,
      canonicalUrl: identity.frozenCanonicalUrl,
      retrievedAt: identity.frozenRetrievedAt,
      provider: identity.frozenProvider,
      contentHash: identity.frozenContentHash,
      now: () => now,
    });

    const id = randomUUID();
    await tx.execute(sql`
      INSERT INTO "citations"
        ("id","company_id","project_id","run_id","source_revision_id",
         "artifact_id","artifact_revision_id","ordinal",
         "quote_exact_encrypted","quote_hash","char_start","char_end","section",
         "frozen_title_encrypted","frozen_author_encrypted","frozen_canonical_url",
         "frozen_retrieved_at","frozen_provider","frozen_content_hash",
         "artifact_locator","created_at")
      VALUES
        (${id}, ${input.companyId}, ${input.projectId}, ${input.runId},
         ${identity.sourceRevisionId}, ${input.artifactId}, ${identity.artifactRevisionId},
         ${identity.ordinal},
         ${encrypt(identity.quote)}, ${identity.quoteHash},
         ${identity.charStart ?? null}, ${identity.charEnd ?? null},
         ${identity.section ?? null},
         ${frozen.title ? encrypt(frozen.title) : null},
         ${frozen.author ? encrypt(frozen.author) : null},
         ${frozen.canonicalUrl}, ${frozen.retrievedAt}, ${frozen.provider},
         ${frozen.contentHash ?? null},
         ${c.artifactLocator ? JSON.stringify({ ...c.artifactLocator, artifactVersion: newVersion }) : null}::jsonb,
         ${now})
    `);

    return id;
  }

  /**
   * Verify a source revision exists within the requesting company/project
   * scope inside the current transaction (VAL-RES-022).
   */
  private async isSourceRevisionInScope(
    tx: Tx,
    companyId: string,
    projectId: string,
    sourceRevisionId: string,
  ): Promise<boolean> {
    const rows = (await tx.execute(sql`
      SELECT 1 FROM "research_source_revisions"
      WHERE "id" = ${sourceRevisionId}
        AND "company_id" = ${companyId}
        AND "project_id" = ${projectId}
      LIMIT 1
    `)) as unknown as { 1?: number }[];
    return rows.length > 0;
  }

  /**
   * Load + decrypt the normalized source text for a scoped revision inside
   * the current transaction. Returns undefined when the revision has no
   * stored text.
   */
  private async fetchNormalizedSourceText(
    tx: Tx,
    companyId: string,
    projectId: string,
    sourceRevisionId: string,
  ): Promise<string | undefined> {
    const rows = (await tx.execute(sql`
      SELECT "normalized_text_encrypted"
      FROM "research_source_revisions"
      WHERE "id" = ${sourceRevisionId}
        AND "company_id" = ${companyId}
        AND "project_id" = ${projectId}
    `)) as unknown as { normalized_text_encrypted: string | null }[];
    if (rows.length === 0 || !rows[0].normalized_text_encrypted) {
      return undefined;
    }
    try {
      // Lazy import to avoid a circular dependency at module load time.
      const { decrypt } = await import('../../crypto.js');
      return decrypt(rows[0].normalized_text_encrypted);
    } catch {
      return undefined;
    }
  }
}
