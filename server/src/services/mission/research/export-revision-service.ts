/**
 * Export revision data loading: pinned revision content + bound citations
 * with frozen display metadata, scoped by company/project.
 *
 * (VAL-RES-039, VAL-RES-040, VAL-RES-101, VAL-RES-102)
 *
 * Loads the exact requested positive integer revision of an artifact
 * together with the citations bound to that exact artifact revision. The
 * revision content is decrypted from its at-rest envelope, and each
 * citation's exact quote and frozen display metadata (title, author,
 * canonical URL, retrieval time, provider) are decrypted. Only public-safe
 * fields are returned; internal IDs beyond the citation row id (used only
 * for inline mark mapping) are excluded by the pure export renderer.
 *
 * Reads are company/project scoped. A cross-scope or absent revision
 * returns null (non-enumerating, VAL-RES-022). The artifact must belong to
 * the requested project; otherwise null is returned.
 */

import { and, eq, sql } from 'drizzle-orm';
import { decrypt } from '../../crypto.js';
import { decryptContent } from '../../content-encryption.js';
import type { ExportCitation } from './export-service.js';
import type { DbInstance } from '../../../types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ExportRevisionServiceDeps {
  drizzle: DbInstance['drizzle'];
  schema: DbInstance['schema'];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ExportData {
  artifactId: string;
  version: number;
  title: string;
  type: string;
  /** Decrypted revision content (an `EvidenceDocumentV1` for documents). */
  content: Record<string, unknown>;
  citations: ExportCitation[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ExportRevisionService {
  constructor(private readonly deps: ExportRevisionServiceDeps) {}

  /**
   * Load the exact revision content and bound citations, scoped by company
   * and project. Returns null when the artifact or revision is absent or
   * cross-scope (non-enumerating, VAL-RES-022).
   */
  async loadExportData(
    companyId: string,
    projectId: string,
    artifactId: string,
    version: number,
  ): Promise<ExportData | null> {
    // 1. Load the artifact, scoped by company AND project. The export route
    //    is project-scoped, so the artifact must belong to the requested
    //    project; otherwise return null (non-enumerating).
    const [artifact] = await this.deps.drizzle
      .select({
        id: this.deps.schema.artifacts.id,
        title: this.deps.schema.artifacts.title,
        type: this.deps.schema.artifacts.type,
        projectId: this.deps.schema.artifacts.projectId,
        version: this.deps.schema.artifacts.version,
      })
      .from(this.deps.schema.artifacts)
      .where(
        and(
          eq(this.deps.schema.artifacts.id, artifactId),
          eq(this.deps.schema.artifacts.companyId, companyId),
          eq(this.deps.schema.artifacts.projectId, projectId),
        ),
      )
      .limit(1);

    if (!artifact) {
      return null;
    }

    // 2. Load the exact immutable revision row (by artifact + version).
    const [revision] = await this.deps.drizzle
      .select({
        id: this.deps.schema.artifactRevisions.id,
        content: this.deps.schema.artifactRevisions.content,
      })
      .from(this.deps.schema.artifactRevisions)
      .where(
        and(
          eq(this.deps.schema.artifactRevisions.artifactId, artifactId),
          eq(this.deps.schema.artifactRevisions.version, version),
        ),
      )
      .limit(1);

    if (!revision) {
      return null;
    }

    const content = decryptContent(revision.content as Record<string, unknown>);

    // 3. Load the citations bound to the exact artifact revision, scoped by
    //    company and project, ordered by ordinal. Decrypt the quote and
    //    frozen display metadata.
    const citationRows = (await this.deps.drizzle.execute(sql`
      SELECT "id","ordinal",
             "quote_exact_encrypted",
             "frozen_title_encrypted","frozen_author_encrypted",
             "frozen_canonical_url","frozen_retrieved_at","frozen_provider",
             "section"
      FROM "citations"
      WHERE "artifact_revision_id" = ${revision.id}
        AND "company_id" = ${companyId}
        AND "project_id" = ${projectId}
      ORDER BY "ordinal" ASC
    `)) as unknown as {
      id: string;
      ordinal: number;
      quote_exact_encrypted: string;
      frozen_title_encrypted: string | null;
      frozen_author_encrypted: string | null;
      frozen_canonical_url: string;
      frozen_retrieved_at: Date | string;
      frozen_provider: string;
      section: string | null;
    }[];

    const citations: ExportCitation[] = citationRows.map((r) => ({
      citationId: r.id,
      ordinal: r.ordinal,
      quote: safeDecrypt(r.quote_exact_encrypted) ?? '',
      frozenTitle: r.frozen_title_encrypted ? safeDecrypt(r.frozen_title_encrypted) : undefined,
      frozenAuthor: r.frozen_author_encrypted ? safeDecrypt(r.frozen_author_encrypted) : undefined,
      canonicalUrl: r.frozen_canonical_url,
      frozenRetrievedAt:
        r.frozen_retrieved_at instanceof Date
          ? r.frozen_retrieved_at.toISOString()
          : new Date(r.frozen_retrieved_at).toISOString(),
      frozenProvider: r.frozen_provider,
      section: r.section ?? undefined,
    }));

    return {
      artifactId,
      version,
      title: artifact.title,
      type: artifact.type,
      content,
      citations,
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
