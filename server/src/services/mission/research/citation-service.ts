/**
 * Citation persistence service: exact-revision-bound citation identity,
 * quote/locator validation, frozen display metadata, and scoped historical
 * reads.
 *
 * (architecture.md: ResearchSource, Citation, and Artifact Provenance,
 *  VAL-RES-097, VAL-RES-113, VAL-RES-022, VAL-CROSS-034)
 *
 * A citation binds to the EXACT immutable source revision and artifact
 * revision. It never retargets a newer source revision — the row stores the
 * source revision id at creation time and is never updated to point at a
 * later revision. Frozen display metadata is captured at creation time
 * (VAL-RES-113) so historical views are stable across later re-retrievals.
 *
 * Repeated quotes require an unambiguous locator (VAL-RES-097): when the
 * exact quote occurs more than once in the normalized source text, a
 * character-offset locator that pins one occurrence is required.
 *
 * The atomic commit of artifact revision + citations + provenance in one
 * transaction is owned by m5-f07; this service stores individual citation
 * rows given an already-existing artifact revision.
 */

import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from '../../crypto.js';
import { createCitationIdentity, type CitationLocator } from './citation-identity.js';
import { freezeDisplayMetadata, type FrozenDisplayMetadata } from './frozen-metadata.js';
import type { DbInstance } from '../../../types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CitationServiceDeps {
  drizzle: DbInstance['drizzle'];
  schema: DbInstance['schema'];
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface PersistCitationInput {
  companyId: string;
  projectId?: string;
  runId: string;
  sourceRevisionId: string;
  artifactId: string;
  artifactRevisionId: string;
  ordinal: number;
  /**
   * Exact quote text from the source. When omitted, a metadata-only
   * citation is created from the frozen source metadata without requiring
   * a verbatim quote match (fix-ut-m5-citation-quote-validation).
   */
  quote?: string;
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
  /** Optional artifact locator ({artifactVersion, jsonPointer, blockId?, start?, end?}). */
  artifactLocator?: Record<string, unknown>;
}

export interface CitationView {
  citationId: string;
  sourceRevisionId: string;
  artifactRevisionId: string;
  ordinal: number;
  quoteHash: string;
  charStart?: number;
  charEnd?: number;
  section?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CitationService {
  constructor(private readonly deps: CitationServiceDeps) {}

  /**
   * Persist a citation bound to the exact source and artifact revisions,
   * with frozen display metadata. Validates the quote locator (VAL-RES-097)
   * against the stored normalized source revision text.
   */
  async persistCitation(input: PersistCitationInput): Promise<string> {
    // Tenant isolation (VAL-RES-022): the source revision must belong to the
    // requesting company/project scope before a citation may bind to it.
    // This is an explicit guard independent of quote/locator verification, so
    // a caller cannot create a citation referencing a foreign revision.
    const inScope = await this.isSourceRevisionInScope(
      input.companyId,
      input.projectId,
      input.sourceRevisionId,
    );
    if (!inScope) {
      throw new Error('source revision not found in scope');
    }

    // Resolve the normalized source text: prefer caller-supplied text,
    // otherwise fetch + decrypt the stored revision text (scoped). This
    // enforces VAL-RES-097 against the actual immutable revision content.
    // Skip loading when no quote is provided (metadata-only citation,
    // fix-ut-m5-citation-quote-validation).
    let normalizedSourceText = input.normalizedSourceText;
    if (normalizedSourceText === undefined && input.quote) {
      normalizedSourceText = await this.fetchNormalizedSourceText(
        input.companyId,
        input.projectId,
        input.sourceRevisionId,
      );
    }

    // Build the citation identity (validates quote, locator, ordinal, and
    // freezes display metadata).
    const identity = createCitationIdentity({
      companyId: input.companyId,
      projectId: input.projectId ?? '',
      runId: input.runId,
      sourceRevisionId: input.sourceRevisionId,
      artifactId: input.artifactId,
      artifactRevisionId: input.artifactRevisionId,
      ordinal: input.ordinal,
      quote: input.quote,
      locator: input.locator,
      normalizedSourceText,
      frozenTitle: input.frozenTitle,
      frozenAuthor: input.frozenAuthor,
      frozenCanonicalUrl: input.frozenCanonicalUrl,
      frozenRetrievedAt: input.frozenRetrievedAt,
      frozenProvider: input.frozenProvider,
      frozenContentHash: input.frozenContentHash,
    });

    const id = randomUUID();
    // Use ISO 8601 string for raw SQL templates so PostgreSQL always
    // receives a parseable timestamp (fix-ut-m5-date-serialization-sweep).
    const now = new Date().toISOString();
    const frozen = freezeDisplayMetadata({
      title: identity.frozenTitle,
      author: identity.frozenAuthor,
      canonicalUrl: identity.frozenCanonicalUrl,
      retrievedAt: identity.frozenRetrievedAt,
      provider: identity.frozenProvider,
      contentHash: identity.frozenContentHash,
      now: () => new Date(now),
    });

    await this.deps.drizzle.execute(sql`
      INSERT INTO "citations"
        ("id","company_id","project_id","run_id","source_revision_id",
         "artifact_id","artifact_revision_id","ordinal",
         "quote_exact_encrypted","quote_hash","char_start","char_end","section",
         "frozen_title_encrypted","frozen_author_encrypted","frozen_canonical_url",
         "frozen_retrieved_at","frozen_provider","frozen_content_hash",
         "artifact_locator","created_at")
      VALUES
        (${id}, ${input.companyId}, ${input.projectId ?? null}, ${input.runId},
         ${identity.sourceRevisionId}, ${input.artifactId}, ${identity.artifactRevisionId},
         ${identity.ordinal},
         ${encrypt(identity.quote)}, ${identity.quoteHash},
         ${identity.charStart ?? null}, ${identity.charEnd ?? null},
         ${identity.section ?? null},
         ${frozen.title ? encrypt(frozen.title) : null},
         ${frozen.author ? encrypt(frozen.author) : null},
         ${frozen.canonicalUrl}, ${frozen.retrievedAt}, ${frozen.provider},
         ${frozen.contentHash ?? null},
         ${input.artifactLocator ? JSON.stringify(input.artifactLocator) : null}::jsonb,
         ${now})
    `);

    return id;
  }

  /**
   * Fetch + decrypt the normalized source text for a revision, scoped by
   * company and project. Returns undefined when the revision is absent,
   * cross-scope, or has no stored text.
   */
  private async fetchNormalizedSourceText(
    companyId: string,
    projectId: string | undefined,
    sourceRevisionId: string,
  ): Promise<string | undefined> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT "normalized_text_encrypted"
      FROM "research_source_revisions"
      WHERE "id" = ${sourceRevisionId}
        AND "company_id" = ${companyId}
        ${projectId ? sql`AND "project_id" = ${projectId}` : sql`AND "project_id" IS NULL`}
    `)) as unknown as { normalized_text_encrypted: string | null }[];
    if (rows.length === 0 || !rows[0].normalized_text_encrypted) {
      return undefined;
    }
    return safeDecrypt(rows[0].normalized_text_encrypted);
  }

  /**
   * Verify that a source revision exists within the requesting company/project
   * scope (VAL-RES-022). Returns false for absent or cross-scope revisions.
   */
  private async isSourceRevisionInScope(
    companyId: string,
    projectId: string | undefined,
    sourceRevisionId: string,
  ): Promise<boolean> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT 1 FROM "research_source_revisions"
      WHERE "id" = ${sourceRevisionId}
        AND "company_id" = ${companyId}
        ${projectId ? sql`AND "project_id" = ${projectId}` : sql`AND "project_id" IS NULL`}
      LIMIT 1
    `)) as unknown as { 1?: number }[];
    return rows.length > 0;
  }

  /**
   * Fetch a single citation, scoped by company and project. Returns null for
   * an absent or cross-scope citation (non-enumerating, VAL-RES-022).
   */
  async getCitation(
    companyId: string,
    projectId: string | undefined,
    citationId: string,
  ): Promise<CitationView | null> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT "id","source_revision_id","artifact_revision_id","ordinal",
             "quote_hash","char_start","char_end","section"
      FROM "citations"
      WHERE "id" = ${citationId}
        AND "company_id" = ${companyId}
        ${projectId ? sql`AND "project_id" = ${projectId}` : sql`AND "project_id" IS NULL`}
    `)) as unknown as {
      id: string;
      source_revision_id: string;
      artifact_revision_id: string;
      ordinal: number;
      quote_hash: string;
      char_start: number | null;
      char_end: number | null;
      section: string | null;
    }[];
    if (rows.length === 0) {
      return null;
    }
    const r = rows[0];
    return {
      citationId: r.id,
      sourceRevisionId: r.source_revision_id,
      artifactRevisionId: r.artifact_revision_id,
      ordinal: r.ordinal,
      quoteHash: r.quote_hash,
      charStart: r.char_start ?? undefined,
      charEnd: r.char_end ?? undefined,
      section: r.section ?? undefined,
    };
  }

  /**
   * Fetch the frozen display metadata for a citation (VAL-RES-113). The
   * metadata is decrypted from the citation row and is stable across later
   * re-retrievals of the source.
   */
  async getFrozenMetadata(
    companyId: string,
    projectId: string | undefined,
    citationId: string,
  ): Promise<FrozenDisplayMetadata | null> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT "frozen_title_encrypted","frozen_author_encrypted","frozen_canonical_url",
             "frozen_retrieved_at","frozen_provider","frozen_content_hash"
      FROM "citations"
      WHERE "id" = ${citationId}
        AND "company_id" = ${companyId}
        ${projectId ? sql`AND "project_id" = ${projectId}` : sql`AND "project_id" IS NULL`}
    `)) as unknown as {
      frozen_title_encrypted: string | null;
      frozen_author_encrypted: string | null;
      frozen_canonical_url: string;
      frozen_retrieved_at: Date | string;
      frozen_provider: string;
      frozen_content_hash: string | null;
    }[];
    if (rows.length === 0) {
      return null;
    }
    const r = rows[0];
    const retrievedAt =
      r.frozen_retrieved_at instanceof Date
        ? r.frozen_retrieved_at.toISOString()
        : new Date(r.frozen_retrieved_at).toISOString();
    return {
      title: r.frozen_title_encrypted ? safeDecrypt(r.frozen_title_encrypted) : undefined,
      author: r.frozen_author_encrypted ? safeDecrypt(r.frozen_author_encrypted) : undefined,
      canonicalUrl: r.frozen_canonical_url,
      retrievedAt,
      provider: r.frozen_provider,
      contentHash: r.frozen_content_hash ?? undefined,
      frozenAt: retrievedAt,
    };
  }
}

function safeDecrypt(ciphertext: string): string | undefined {
  try {
    return decrypt(ciphertext);
  } catch {
    return undefined;
  }
}
