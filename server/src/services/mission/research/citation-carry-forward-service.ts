/**
 * Verified citation carry-forward and revision restoration.
 *
 * (architecture.md: ResearchSource, Citation, and Artifact Provenance,
 *  VAL-RES-034, VAL-RES-099, VAL-CROSS-042)
 *
 * Citations never silently move to a newer source or artifact revision. A
 * later artifact edit either preserves a citation at a verified-unchanged
 * locator (writing a new revision-bound citation row) or marks it
 * not-carried-forward. The original citation remains historical, bound to
 * its original immutable revision.
 *
 * This service provides two operations:
 *
 *  1. `commitWithCarryForward` — atomically creates a new artifact revision
 *     (from edited content), carries forward citations from the previous
 *     revision whose locators still verify against the new content, and
 *     records carry-forward outcomes for every previous citation. New
 *     citation rows are bound to the new revision with new citation IDs.
 *
 *  2. `restoreRevision` — atomically creates a new artifact revision from a
 *     previous revision's exact content (a restoration), carries forward
 *     citations whose locators verify against the restored content, and
 *     records carry-forward outcomes. Because the restored content is
 *     identical to the source revision, all citation marks that were present
 *     should verify.
 *
 * Both operations write artifact revision + citations + provenance + carry-
 * forward outcomes in one transaction. A persistence failpoint (a stale
 * expected-version, a citation scope rejection, or a constraint violation)
 * rolls back the entire transaction, exposing neither a partial revision nor
 * dangling citation/outcome rows.
 */

import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../middleware/error-handler.js';
import { encrypt, decrypt } from '../../crypto.js';
import { encryptContent, decryptContent } from '../../content-encryption.js';
import { createCitationIdentity, type CitationLocator } from './citation-identity.js';
import { freezeDisplayMetadata } from './frozen-metadata.js';
import { validateArtifactLocator, type ArtifactLocator } from './artifact-locator.js';
import type { DbInstance } from '../../../types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CitationCarryForwardServiceDeps {
  drizzle: DbInstance['drizzle'];
  schema: DbInstance['schema'];
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface CarryForwardProvenanceInput {
  approvedPlanRevisionId?: string;
  approvedPlanHash?: string;
  policyHash?: string;
  producingStepKey?: string;
  producingChildRunId?: string | null;
  generationTime: Date;
  /** Cited source revision IDs bound to this artifact revision. */
  citedSourceRevisionIds: string[];
}

export interface CommitWithCarryForwardInput {
  companyId: string;
  projectId: string;
  runId: string;
  rootRunId: string;
  artifactId: string;
  /** Optimistic version check — must match the current artifact version. */
  expectedVersion: number;
  /** The previous revision whose citations are being carried forward from. */
  previousArtifactRevisionId: string;
  /** New content for the artifact revision. */
  content: Record<string, unknown>;
  editSource: 'user' | 'agent' | 'system';
  editedByUserId?: string | null;
  editedByAgentId?: string | null;
  message?: string;
  provenance: CarryForwardProvenanceInput;
}

export interface RestoreRevisionInput {
  companyId: string;
  projectId: string;
  runId: string;
  rootRunId: string;
  artifactId: string;
  /** Optimistic version check — must match the current artifact version. */
  expectedVersion: number;
  /** The revision to restore (its content becomes the new revision's content). */
  restoreFromRevisionId: string;
  editSource: 'user' | 'agent' | 'system';
  editedByUserId?: string | null;
  editedByAgentId?: string | null;
  message?: string;
  provenance: CarryForwardProvenanceInput;
}

export interface CarryForwardOutcome {
  previousCitationId: string;
  newCitationId?: string;
  outcome: 'carried_forward' | 'not_carried_forward';
  reason?: string;
  ordinal: number;
}

export interface CarryForwardResult {
  artifactRevisionId: string;
  version: number;
  provenanceId: string;
  outcomes: CarryForwardOutcome[];
}

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CitationCarryForwardService {
  constructor(private readonly deps: CitationCarryForwardServiceDeps) {}

  /**
   * Atomically commit a new artifact revision (edited content) and carry
   * forward citations from the previous revision whose locators still
   * verify against the new content (VAL-RES-034, VAL-CROSS-042).
   *
   * Citations whose artifact locators resolve in the new content (the cited
   * passage is unchanged) are carried forward: a new citation row is written
   * bound to the new revision with a new citation ID, preserving the same
   * source revision, quote, and frozen display metadata.
   *
   * Citations whose locators do NOT verify (the passage changed, the
   * citation mark was removed, or the source locator no longer verifies)
   * are NOT carried forward. The original citation remains historical,
   * bound to its original revision, and a `not_carried_forward` outcome is
   * recorded with the reason.
   */
  async commitWithCarryForward(input: CommitWithCarryForwardInput): Promise<CarryForwardResult> {
    this.validateInput(input);
    return this.deps.drizzle.transaction(async (tx) => {
      const newVersion = input.expectedVersion + 1;
      const content = input.content;
      return this.commitAndCarryForward(tx, input, content, newVersion);
    });
  }

  /**
   * Atomically restore a previous revision's content as a new artifact
   * revision and carry forward citations whose locators verify against the
   * restored content (VAL-RES-099).
   *
   * Restoration creates a NEW immutable revision (with a new version number)
   * whose content is the exact decrypted content of the source revision.
   * Citations from the source revision whose locators verify in the restored
   * content are carried forward to the new revision with new citation IDs.
   */
  async restoreRevision(input: RestoreRevisionInput): Promise<CarryForwardResult> {
    this.validateInput(input);
    return this.deps.drizzle.transaction(async (tx) => {
      // Load the source revision's content (scoped).
      const sourceContent = await this.loadRevisionContent(
        tx,
        input.companyId,
        input.artifactId,
        input.restoreFromRevisionId,
      );
      if (!sourceContent) {
        throw new AppError(404, 'REVISION_NOT_FOUND', 'Revision not found in scope');
      }
      const newVersion = input.expectedVersion + 1;
      return this.commitAndCarryForward(
        tx,
        input,
        sourceContent,
        newVersion,
        input.restoreFromRevisionId,
      );
    });
  }

  /**
   * List carry-forward outcomes for a new artifact revision, scoped by
   * company and project. Returns non-enumerating empty for cross-scope.
   */
  async listOutcomes(
    companyId: string,
    projectId: string | undefined,
    newArtifactRevisionId: string,
  ): Promise<CarryForwardOutcome[]> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT "previous_citation_id","new_citation_id","outcome","reason"
      FROM "citation_carry_forward_outcomes"
      WHERE "new_artifact_revision_id" = ${newArtifactRevisionId}
        AND "company_id" = ${companyId}
        ${projectId ? sql`AND "project_id" = ${projectId}` : sql`AND "project_id" IS NULL`}
      ORDER BY "created_at"
    `)) as unknown as {
      previous_citation_id: string;
      new_citation_id: string | null;
      outcome: 'carried_forward' | 'not_carried_forward';
      reason: string | null;
    }[];
    // Join ordinal from the new citation or previous citation for stable ordering.
    const outcomes: CarryForwardOutcome[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      outcomes.push({
        previousCitationId: r.previous_citation_id,
        newCitationId: r.new_citation_id ?? undefined,
        outcome: r.outcome,
        reason: r.reason ?? undefined,
        ordinal: i + 1,
      });
    }
    return outcomes;
  }

  // -----------------------------------------------------------------------
  // Private: atomic commit + carry-forward core
  // -----------------------------------------------------------------------

  /**
   * Core logic shared by commitWithCarryForward and restoreRevision.
   * Creates the new revision, carries forward verified citations, writes
   * provenance, and records outcomes — all inside the given transaction.
   */
  private async commitAndCarryForward(
    tx: Tx,
    input: CommitWithCarryForwardInput | RestoreRevisionInput,
    content: Record<string, unknown>,
    newVersion: number,
    sourceRevisionId?: string,
  ): Promise<CarryForwardResult> {
    // Use ISO 8601 string for raw SQL templates so PostgreSQL always
    // receives a parseable timestamp. Drizzle's typed .set() expects a
    // Date for timestamp columns, so keep both (fix-ut-m5-date-serialization-sweep).
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const artifactRevisionId = randomUUID();
    const provenanceId = randomUUID();
    const encryptedContent = encryptContent(content);

    // 1. Lock the artifact row and verify the optimistic version.
    const [updated] = await tx
      .update(this.deps.schema.artifacts)
      .set({
        content: encryptedContent,
        version: newVersion,
        updatedAt: nowDate,
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

    // 3. Load the previous revision's citations (scoped).
    const prevRevisionId =
      sourceRevisionId ?? (input as CommitWithCarryForwardInput).previousArtifactRevisionId;
    const prevCitations = await this.loadRevisionCitations(
      tx,
      input.companyId,
      input.projectId,
      prevRevisionId,
    );

    // 4. Evaluate each citation for carry-forward.
    const outcomes: CarryForwardOutcome[] = [];
    let nextOrdinal = 1;
    const carriedSourceRevisionIds: string[] = [];

    for (const cite of prevCitations) {
      const evaluation = await this.evaluateCitationForCarryForward(
        tx,
        input.companyId,
        input.projectId,
        cite,
        content,
        newVersion,
      );

      if (evaluation.canCarryForward) {
        // Write a new citation row bound to the new revision.
        const newCitationId = await this.insertCarriedCitation(
          tx,
          input,
          cite,
          evaluation,
          artifactRevisionId,
          newVersion,
          nextOrdinal,
          now,
        );
        carriedSourceRevisionIds.push(cite.source_revision_id);
        outcomes.push({
          previousCitationId: cite.id,
          newCitationId,
          outcome: 'carried_forward',
          ordinal: nextOrdinal,
        });
        nextOrdinal += 1;
      } else {
        outcomes.push({
          previousCitationId: cite.id,
          outcome: 'not_carried_forward',
          reason: evaluation.reason,
          ordinal: nextOrdinal,
        });
        // Do NOT increment nextOrdinal for not-carried — ordinals are only
        // assigned to carried citations in the new revision.
      }

      // 5. Record the carry-forward outcome row.
      const lastOutcome = outcomes[outcomes.length - 1];
      await tx.execute(sql`
        INSERT INTO "citation_carry_forward_outcomes"
          ("id","company_id","project_id","run_id",
           "previous_citation_id","new_artifact_revision_id",
           "new_citation_id","outcome","reason","created_at")
        VALUES
          (${randomUUID()}, ${input.companyId}, ${input.projectId}, ${input.runId},
           ${cite.id}, ${artifactRevisionId},
           ${evaluation.canCarryForward ? lastOutcome.newCitationId : null},
           ${evaluation.canCarryForward ? 'carried_forward' : 'not_carried_forward'},
           ${evaluation.canCarryForward ? null : evaluation.reason},
           ${now})
      `);
    }

    // 6. Insert provenance bound to the new revision.
    const citedIds =
      carriedSourceRevisionIds.length > 0
        ? carriedSourceRevisionIds
        : input.provenance.citedSourceRevisionIds;
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
         ${input.provenance.generationTime.toISOString()},
         ${JSON.stringify(citedIds)}::jsonb,
         ${now})
    `);

    return {
      artifactRevisionId,
      version: newVersion,
      provenanceId,
      outcomes,
    };
  }

  // -----------------------------------------------------------------------
  // Private: citation evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate whether a previous citation can be carried forward to the new
   * revision. Two checks:
   *
   * 1. Artifact locator: the citation's artifact locator must still resolve
   *    in the new revision's content (the cited passage / citation mark is
   *    present at the same block/pointer).
   * 2. Source locator: the quote must still verify against the source
   *    revision's normalized text (the source is immutable, so this should
   *    always pass unless the source revision has been deleted or is
   *    cross-scope).
   */
  private async evaluateCitationForCarryForward(
    tx: Tx,
    companyId: string,
    projectId: string,
    cite: PreviousCitation,
    newContent: Record<string, unknown>,
    newVersion: number,
  ): Promise<CitationEvaluation> {
    // Check 1: Artifact locator verification.
    if (cite.artifact_locator) {
      // Update the locator to point at the new version for validation.
      const locator: ArtifactLocator = {
        ...(cite.artifact_locator as unknown as ArtifactLocator),
        artifactVersion: newVersion,
      };
      const result = validateArtifactLocator(locator, newVersion, newContent);
      if (!result.valid) {
        return {
          canCarryForward: false,
          reason: `ARTIFACT_LOCATOR_INVALID: ${result.errors.join('; ')}`,
        };
      }
    } else {
      // No artifact locator stored — cannot verify the citation mark in the
      // new content. Fail closed: do not carry forward.
      return {
        canCarryForward: false,
        reason: 'ARTIFACT_LOCATOR_MISSING',
      };
    }

    // Check 2: Source locator verification (quote still in source revision).
    const sourceText = await this.fetchNormalizedSourceText(
      tx,
      companyId,
      projectId,
      cite.source_revision_id,
    );
    if (sourceText === undefined) {
      return {
        canCarryForward: false,
        reason: 'SOURCE_REVISION_UNAVAILABLE',
      };
    }

    // Verify the quote still occurs in the source text. The quote is
    // decrypted from the citation row.
    const quote = safeDecrypt(cite.quote_exact_encrypted);
    if (quote === undefined) {
      return {
        canCarryForward: false,
        reason: 'QUOTE_DECRYPTION_FAILED',
      };
    }

    // Use resolveQuoteLocator to verify the quote is present.
    const { resolveQuoteLocator } = await import('./citation-identity.js');
    const locator: CitationLocator | undefined =
      cite.char_start !== null && cite.char_end !== null
        ? { charStart: cite.char_start, charEnd: cite.char_end, section: cite.section ?? undefined }
        : undefined;
    const resolved = resolveQuoteLocator(sourceText, quote, locator);
    if (resolved.kind === 'rejected' || resolved.kind === 'ambiguous') {
      return {
        canCarryForward: false,
        reason: `SOURCE_LOCATOR_INVALID: ${resolved.reason ?? resolved.kind}`,
      };
    }

    // Both checks passed — the citation can be carried forward.
    return {
      canCarryForward: true,
      charStart: resolved.charStart,
      charEnd: resolved.charEnd,
      section: cite.section ?? undefined,
      quote,
      sourceText,
    };
  }

  // -----------------------------------------------------------------------
  // Private: citation insertion
  // -----------------------------------------------------------------------

  /**
   * Insert a carried-forward citation row bound to the new artifact
   * revision. The new citation preserves the same source revision, quote,
   * and frozen display metadata from the previous citation, but gets a new
   * citation ID, a new ordinal, and an updated artifact locator pointing at
   * the new version.
   */
  private async insertCarriedCitation(
    tx: Tx,
    input: CommitWithCarryForwardInput | RestoreRevisionInput,
    cite: PreviousCitation,
    evaluation: CitationEvaluation,
    newArtifactRevisionId: string,
    newVersion: number,
    ordinal: number,
    now: string,
  ): Promise<string> {
    // Build the new citation identity using the verified quote/locator
    // and the frozen metadata from the previous citation.
    const frozenTitle = cite.frozen_title_encrypted
      ? safeDecrypt(cite.frozen_title_encrypted)
      : undefined;
    const frozenAuthor = cite.frozen_author_encrypted
      ? safeDecrypt(cite.frozen_author_encrypted)
      : undefined;

    const identity = createCitationIdentity({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: input.runId,
      sourceRevisionId: cite.source_revision_id,
      artifactId: input.artifactId,
      artifactRevisionId: newArtifactRevisionId,
      ordinal,
      quote: evaluation.quote!,
      locator:
        evaluation.charStart !== undefined && evaluation.charEnd !== undefined
          ? {
              charStart: evaluation.charStart,
              charEnd: evaluation.charEnd,
              section: evaluation.section,
            }
          : undefined,
      normalizedSourceText: evaluation.sourceText,
      frozenTitle,
      frozenAuthor,
      frozenCanonicalUrl: cite.frozen_canonical_url,
      frozenRetrievedAt:
        cite.frozen_retrieved_at instanceof Date
          ? cite.frozen_retrieved_at.toISOString()
          : new Date(cite.frozen_retrieved_at).toISOString(),
      frozenProvider: cite.frozen_provider,
      frozenContentHash: cite.frozen_content_hash ?? undefined,
    });

    const frozen = freezeDisplayMetadata({
      title: identity.frozenTitle,
      author: identity.frozenAuthor,
      canonicalUrl: identity.frozenCanonicalUrl,
      retrievedAt: identity.frozenRetrievedAt,
      provider: identity.frozenProvider,
      contentHash: identity.frozenContentHash,
      now: () => new Date(now),
    });

    const id = randomUUID();
    // Update the artifact locator to point at the new version.
    const newArtifactLocator = cite.artifact_locator
      ? { ...(cite.artifact_locator as Record<string, unknown>), artifactVersion: newVersion }
      : null;

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
         ${cite.source_revision_id}, ${input.artifactId}, ${newArtifactRevisionId},
         ${ordinal},
         ${encrypt(identity.quote)}, ${identity.quoteHash},
         ${identity.charStart ?? null}, ${identity.charEnd ?? null},
         ${identity.section ?? null},
         ${frozen.title ? encrypt(frozen.title) : null},
         ${frozen.author ? encrypt(frozen.author) : null},
         ${frozen.canonicalUrl}, ${frozen.retrievedAt}, ${frozen.provider},
         ${frozen.contentHash ?? null},
         ${newArtifactLocator ? JSON.stringify(newArtifactLocator) : null}::jsonb,
         ${now})
    `);

    return id;
  }

  // -----------------------------------------------------------------------
  // Private: loading helpers
  // -----------------------------------------------------------------------

  /**
   * Load all citations bound to a given artifact revision, scoped by
   * company and project. Ordered by ordinal.
   */
  private async loadRevisionCitations(
    tx: Tx,
    companyId: string,
    projectId: string,
    artifactRevisionId: string,
  ): Promise<PreviousCitation[]> {
    const rows = (await tx.execute(sql`
      SELECT "id","source_revision_id","ordinal",
             "quote_exact_encrypted","quote_hash",
             "char_start","char_end","section",
             "frozen_title_encrypted","frozen_author_encrypted",
             "frozen_canonical_url","frozen_retrieved_at",
             "frozen_provider","frozen_content_hash",
             "artifact_locator"
      FROM "citations"
      WHERE "artifact_revision_id" = ${artifactRevisionId}
        AND "company_id" = ${companyId}
        AND "project_id" = ${projectId}
      ORDER BY "ordinal" ASC
    `)) as unknown as PreviousCitation[];
    return rows;
  }

  /**
   * Load and decrypt the content of a specific artifact revision, scoped
   * by company and artifact ID.
   */
  private async loadRevisionContent(
    tx: Tx,
    companyId: string,
    artifactId: string,
    revisionId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = (await tx.execute(sql`
      SELECT "content" FROM "artifact_revisions"
      WHERE "id" = ${revisionId} AND "artifact_id" = ${artifactId}
    `)) as unknown as { content: Record<string, unknown> }[];
    if (rows.length === 0) {
      return null;
    }
    // The revision content is encrypted; decrypt it.
    return decryptContent(rows[0].content);
  }

  /**
   * Load and decrypt the normalized source text for a source revision,
   * scoped by company and project.
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
    return safeDecrypt(rows[0].normalized_text_encrypted);
  }

  // -----------------------------------------------------------------------
  // Private: validation
  // -----------------------------------------------------------------------

  private validateInput(input: CommitWithCarryForwardInput | RestoreRevisionInput): void {
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
    if ('content' in input && (!input.content || typeof input.content !== 'object')) {
      throw new AppError(400, 'VALIDATION_ERROR', 'content is required');
    }
    if ('previousArtifactRevisionId' in input && !input.previousArtifactRevisionId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'previousArtifactRevisionId is required');
    }
    if ('restoreFromRevisionId' in input && !input.restoreFromRevisionId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'restoreFromRevisionId is required');
    }
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PreviousCitation {
  id: string;
  source_revision_id: string;
  ordinal: number;
  quote_exact_encrypted: string;
  quote_hash: string;
  char_start: number | null;
  char_end: number | null;
  section: string | null;
  frozen_title_encrypted: string | null;
  frozen_author_encrypted: string | null;
  frozen_canonical_url: string;
  frozen_retrieved_at: Date;
  frozen_provider: string;
  frozen_content_hash: string | null;
  artifact_locator: Record<string, unknown> | null;
}

interface CitationEvaluation {
  canCarryForward: boolean;
  reason?: string;
  charStart?: number;
  charEnd?: number;
  section?: string;
  quote?: string;
  sourceText?: string;
}

function safeDecrypt(ciphertext: string): string | undefined {
  try {
    return decrypt(ciphertext);
  } catch {
    return undefined;
  }
}

// Re-export for convenience.
export type { CitationLocator, ArtifactLocator };
