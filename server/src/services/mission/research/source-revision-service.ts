/**
 * Source revision persistence service: tenant-local dedup, content-hash
 * dedup, changed-revision versioning, and bounded scoped source summaries.
 *
 * (architecture.md: ResearchSource, Citation, and Artifact Provenance,
 *  VAL-RES-019, VAL-RES-020, VAL-RES-021, VAL-RES-022, VAL-RES-098,
 *  VAL-RES-112, VAL-CROSS-034)
 *
 * This service is the persistence seam between provider-normalized sources
 * and the durable research tables. It:
 *  - canonicalizes each source via the pure `source-normalization` module
 *    (deterministic, versioned);
 *  - upserts a company-scoped source identity keyed by
 *    `(company_id, canonical_url_hash)` (canonical URL dedup, VAL-RES-019;
 *    tenant-local, VAL-RES-022);
 *  - reuses an existing immutable revision for unchanged content
 *    (content-hash dedup, VAL-RES-020) or creates a new immutable revision
 *    when content changes (VAL-RES-021);
 *  - links the run to the revision via `run_research_sources`;
 *  - encrypts content and display-metadata columns at rest (VAL-RES-107);
 *  - exposes only bounded, scoped source summaries (VAL-CROSS-034) and
 *    denies cross-scope reads (VAL-RES-022).
 */

import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { encrypt } from '../../crypto.js';
import {
  normalizeSourceForPersistence,
  SOURCE_NORMALIZATION_VERSION,
} from './source-normalization.js';
import type { NormalizedResearchSource } from './spi.js';
import type { DbInstance } from '../../../types.js';

function toISOString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SourceRevisionServiceDeps {
  drizzle: DbInstance['drizzle'];
  schema: DbInstance['schema'];
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface PersistSourceRevisionInput {
  companyId: string;
  projectId?: string;
  runId: string;
  rootRunId: string;
  logicalCallId: string;
  provider: string;
  operation: string;
  /** SHA-256 hash of the provider request id (lowercase hex). */
  providerRequestIdHash?: string;
  source: NormalizedResearchSource;
  rank?: number;
  relevanceScore?: number;
  /** SHA-256 of the search query (lowercase hex). */
  queryHash?: string;
  warnings?: string[];
}

export interface PersistedSourceRevision {
  sourceId: string;
  sourceRevisionId: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  contentHash?: string;
  byteCount: number;
  retrievedAt: string;
  normalizationVersion: number;
  createdNewSource: boolean;
  createdNewRevision: boolean;
}

/**
 * A bounded, public-safe source summary (VAL-CROSS-034). Contains no full
 * content and no display metadata; only IDs, hashes, counts, timestamps,
 * canonical URL, rank, score, and status.
 */
export interface SourceSummary {
  sourceRevisionId: string;
  sourceId: string;
  runId: string;
  canonicalUrl: string;
  contentHash?: string;
  byteCount: number;
  retrievedAt: string;
  rank?: number;
  relevanceScore?: number;
  status: string;
  provider: string;
  operation: string;
  /**
   * Plaintext injection/exfiltration risk labels (metadata, not content)
   * (VAL-RES-047). Exposed so the provider-neutral source UI can surface an
   * explicit accessible warning without rendering untrusted content.
   */
  injectionRiskLabels: string[];
  /** Bounded safe plaintext warnings (no credentials/body) (VAL-RES-047). */
  warnings: string[];
  /** Whether the run excluded this source revision (VAL-RES-018). */
  excluded: boolean;
  /** Safe plaintext exclusion reason (VAL-RES-018, VAL-RES-047). */
  exclusionReason: string | null;
  /** Whether the run selected this source revision for synthesis. */
  selected: boolean;
  /** Latest availability-check status, if any (VAL-RES-119, VAL-RES-041). */
  latestAvailabilityStatus?: 'available' | 'unavailable' | 'unknown' | null;
  latestAvailabilityCheckedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SourceRevisionService {
  constructor(private readonly deps: SourceRevisionServiceDeps) {}

  /**
   * Persist a provider-normalized source as a source identity + immutable
   * revision, deduplicating within the company by canonical URL and within
   * the source by content hash.
   */
  async persistSourceRevision(input: PersistSourceRevisionInput): Promise<PersistedSourceRevision> {
    const rec = normalizeSourceForPersistence(input.source);
    // Use ISO 8601 string for raw SQL templates so PostgreSQL always
    // receives a parseable timestamp. Passing a Date object to the pg
    // driver through drizzle's raw sql`` template can serialize as
    // Date.toString() (e.g. 'Tue Aug 25 2026 18:31:24 GMT-0500') which
    // PostgreSQL rejects with "time zone 'gmt-0500' not recognized"
    // (fix-ut-m5-date-serialization-sweep).
    const now = new Date().toISOString();

    // 1. Upsert the company-scoped source identity (VAL-RES-019, VAL-RES-022).
    const sourceRow = (await this.deps.drizzle.execute(sql`
      INSERT INTO "research_sources"
        ("id","company_id","canonical_url","canonical_url_hash","origin_domain",
         "title_encrypted","author_encrypted","published_at_encrypted","language_encrypted",
         "first_seen_at","last_seen_at","created_at","updated_at")
      VALUES
        (${randomUUID()}, ${input.companyId}, ${rec.canonicalUrl}, ${rec.canonicalUrlHash}, ${rec.originDomain},
         ${rec.title ? encrypt(rec.title) : null},
         ${rec.author ? encrypt(rec.author) : null},
         ${rec.publishedAt ? encrypt(rec.publishedAt) : null},
         ${rec.language ? encrypt(rec.language) : null},
         ${now}, ${now}, ${now}, ${now})
      ON CONFLICT ("company_id", "canonical_url_hash") DO UPDATE
        SET "last_seen_at" = ${now},
            "updated_at" = ${now},
            "title_encrypted" = COALESCE(excluded."title_encrypted", "research_sources"."title_encrypted"),
            "author_encrypted" = COALESCE(excluded."author_encrypted", "research_sources"."author_encrypted"),
            "published_at_encrypted" = COALESCE(excluded."published_at_encrypted", "research_sources"."published_at_encrypted"),
            "language_encrypted" = COALESCE(excluded."language_encrypted", "research_sources"."language_encrypted"),
            "origin_domain" = "research_sources"."origin_domain"
      RETURNING "id", (xmax = 0) AS "inserted"
    `)) as unknown as { id: string; inserted: boolean }[];
    const sourceId = sourceRow[0].id;
    const createdNewSource = sourceRow[0].inserted;

    // 2. Reuse or create an immutable revision (VAL-RES-020, VAL-RES-021).
    let sourceRevisionId: string;
    let createdNewRevision: boolean;

    if (rec.contentHash !== undefined) {
      const existing = (await this.deps.drizzle.execute(sql`
        SELECT "id" FROM "research_source_revisions"
        WHERE "source_id" = ${sourceId} AND "content_hash" = ${rec.contentHash}
        LIMIT 1
      `)) as unknown as { id: string }[];
      if (existing.length > 0) {
        sourceRevisionId = existing[0].id;
        createdNewRevision = false;
      } else {
        sourceRevisionId = await this.insertRevision(input, rec, sourceId, now);
        createdNewRevision = true;
      }
    } else {
      // No text → no content hash → always a fresh revision (each retrieval
      // of text-less content is a distinct retrieval event).
      sourceRevisionId = await this.insertRevision(input, rec, sourceId, now);
      createdNewRevision = true;
    }

    // 3. Link the run to the revision (idempotent per run+revision).
    await this.deps.drizzle.execute(sql`
      INSERT INTO "run_research_sources"
        ("id","company_id","project_id","run_id","root_run_id","logical_call_id",
         "source_revision_id","rank","relevance_score","query_hash","created_at")
      VALUES
        (${randomUUID()}, ${input.companyId}, ${input.projectId ?? null}, ${input.runId}, ${input.rootRunId},
         ${input.logicalCallId}, ${sourceRevisionId},
         ${input.rank ?? null}, ${input.relevanceScore ?? null},
         ${input.queryHash ?? null}, ${now})
      ON CONFLICT ("run_id", "source_revision_id") DO UPDATE
        SET "logical_call_id" = excluded."logical_call_id",
            "rank" = COALESCE(excluded."rank", "run_research_sources"."rank"),
            "relevance_score" = COALESCE(excluded."relevance_score", "run_research_sources"."relevance_score")
    `);

    return {
      sourceId,
      sourceRevisionId,
      canonicalUrl: rec.canonicalUrl,
      canonicalUrlHash: rec.canonicalUrlHash,
      contentHash: rec.contentHash,
      byteCount: rec.byteCount,
      retrievedAt: input.source.retrievedAt,
      normalizationVersion: SOURCE_NORMALIZATION_VERSION,
      createdNewSource,
      createdNewRevision,
    };
  }

  private async insertRevision(
    input: PersistSourceRevisionInput,
    rec: ReturnType<typeof normalizeSourceForPersistence>,
    sourceId: string,
    now: string,
  ): Promise<string> {
    const id = randomUUID();
    const rows = (await this.deps.drizzle.execute(sql`
      INSERT INTO "research_source_revisions"
        ("id","company_id","project_id","source_id","run_id","root_run_id","logical_call_id",
         "provider","operation","provider_request_id_hash","retrieved_at",
         "normalization_version","content_hash","normalized_text_encrypted","excerpt_encrypted",
         "byte_count","mime_type_encrypted","title_encrypted","author_encrypted",
         "published_at_encrypted","language_encrypted","injection_risk_labels","warnings","status","created_at")
      VALUES
        (${id}, ${input.companyId}, ${input.projectId ?? null}, ${sourceId}, ${input.runId}, ${input.rootRunId},
         ${input.logicalCallId}, ${input.provider}, ${input.operation},
         ${input.providerRequestIdHash ?? null}, ${rec.retrievedAt},
         ${rec.normalizationVersion}, ${rec.contentHash ?? null},
         ${rec.normalizedText ? encrypt(rec.normalizedText) : null},
         ${rec.normalizedText ? encrypt(rec.normalizedText.slice(0, 500)) : null},
         ${rec.byteCount},
         ${rec.mimeType ? encrypt(rec.mimeType) : null},
         ${rec.title ? encrypt(rec.title) : null},
         ${rec.author ? encrypt(rec.author) : null},
         ${rec.publishedAt ? encrypt(rec.publishedAt) : null},
         ${rec.language ? encrypt(rec.language) : null},
         ${JSON.stringify(rec.injectionRiskLabels)}::jsonb,
         ${JSON.stringify(input.warnings ?? [])}::jsonb,
         'available', ${now})
      RETURNING "id"
    `)) as unknown as { id: string }[];
    return rows[0].id;
  }

  /**
   * Fetch a single source revision, scoped by company and project.
   * Returns null for an absent or cross-scope revision (non-enumerating,
   * VAL-RES-022).
   */
  async getSourceRevision(
    companyId: string,
    projectId: string | undefined,
    sourceRevisionId: string,
  ): Promise<{
    sourceRevisionId: string;
    sourceId: string;
    canonicalUrl: string;
    contentHash?: string;
    byteCount: number;
    retrievedAt: string;
    status: string;
  } | null> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT
        rsr."id" AS "source_revision_id",
        rsr."source_id" AS "source_id",
        rs."canonical_url" AS "canonical_url",
        rsr."content_hash" AS "content_hash",
        rsr."byte_count" AS "byte_count",
        rsr."retrieved_at" AS "retrieved_at",
        rsr."status" AS "status"
      FROM "research_source_revisions" rsr
      JOIN "research_sources" rs ON rs."id" = rsr."source_id"
      WHERE rsr."id" = ${sourceRevisionId}
        AND rsr."company_id" = ${companyId}
        ${projectId ? sql`AND rsr."project_id" = ${projectId}` : sql`AND rsr."project_id" IS NULL`}
    `)) as unknown as {
      source_revision_id: string;
      source_id: string;
      canonical_url: string;
      content_hash: string | null;
      byte_count: number;
      retrieved_at: Date;
      status: string;
    }[];
    if (rows.length === 0) {
      return null;
    }
    const r = rows[0];
    return {
      sourceRevisionId: r.source_revision_id,
      sourceId: r.source_id,
      canonicalUrl: r.canonical_url,
      contentHash: r.content_hash ?? undefined,
      byteCount: r.byte_count,
      retrievedAt: toISOString(r.retrieved_at),
      status: r.status,
    };
  }

  /**
   * List bounded source summaries for a run, scoped by company and project
   * (VAL-CROSS-034, VAL-RES-022). Returns only safe summary fields; never
   * full content or display metadata. Includes plaintext risk labels,
   * warnings, exclusion metadata, and the latest availability-check status
   * so the provider-neutral source UI can render distinct states, explicit
   * high-risk warnings, and unavailable/failed indicators without rendering
   * untrusted content (VAL-RES-018, VAL-RES-041, VAL-RES-047, VAL-RES-076,
   * VAL-RES-105, VAL-RES-117, VAL-CROSS-030).
   */
  async listRunSourceSummaries(
    companyId: string,
    projectId: string | undefined,
    runId: string,
  ): Promise<SourceSummary[]> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT
        rsr."id" AS "source_revision_id",
        rsr."source_id" AS "source_id",
        rrs."run_id" AS "run_id",
        rs."canonical_url" AS "canonical_url",
        rsr."content_hash" AS "content_hash",
        rsr."byte_count" AS "byte_count",
        rsr."retrieved_at" AS "retrieved_at",
        rrs."rank" AS "rank",
        rrs."relevance_score" AS "relevance_score",
        rsr."status" AS "status",
        rsr."provider" AS "provider",
        rsr."operation" AS "operation",
        rsr."injection_risk_labels" AS "injection_risk_labels",
        rsr."warnings" AS "warnings",
        rrs."excluded" AS "excluded",
        rrs."exclusion_reason" AS "exclusion_reason",
        rrs."selected" AS "selected",
        latest_avail."status" AS "latest_availability_status",
        latest_avail."created_at" AS "latest_availability_checked_at"
      FROM "run_research_sources" rrs
      JOIN "research_source_revisions" rsr ON rsr."id" = rrs."source_revision_id"
      JOIN "research_sources" rs ON rs."id" = rsr."source_id"
      LEFT JOIN LATERAL (
        SELECT "status", "created_at"
        FROM "research_source_availability_checks"
        WHERE "source_revision_id" = rsr."id"
          AND "company_id" = ${companyId}
        ORDER BY "created_at" DESC
        LIMIT 1
      ) latest_avail ON TRUE
      WHERE rrs."run_id" = ${runId}
        AND rrs."company_id" = ${companyId}
        ${projectId ? sql`AND rrs."project_id" = ${projectId}` : sql`AND rrs."project_id" IS NULL`}
      ORDER BY rrs."rank" NULLS LAST, rrs."created_at"
    `)) as unknown as {
      source_revision_id: string;
      source_id: string;
      run_id: string;
      canonical_url: string;
      content_hash: string | null;
      byte_count: number;
      retrieved_at: Date;
      rank: number | null;
      relevance_score: number | null;
      status: string;
      provider: string;
      operation: string;
      injection_risk_labels: string[] | null;
      warnings: string[] | null;
      excluded: boolean | null;
      exclusion_reason: string | null;
      selected: boolean | null;
      latest_availability_status: string | null;
      latest_availability_checked_at: Date | null;
    }[];
    return rows.map((r) => ({
      sourceRevisionId: r.source_revision_id,
      sourceId: r.source_id,
      runId: r.run_id,
      canonicalUrl: r.canonical_url,
      contentHash: r.content_hash ?? undefined,
      byteCount: r.byte_count,
      retrievedAt: toISOString(r.retrieved_at),
      rank: r.rank ?? undefined,
      relevanceScore: r.relevance_score ?? undefined,
      status: r.status,
      provider: r.provider,
      operation: r.operation,
      injectionRiskLabels: r.injection_risk_labels ?? [],
      warnings: r.warnings ?? [],
      excluded: r.excluded ?? false,
      exclusionReason: r.exclusion_reason,
      selected: r.selected ?? true,
      latestAvailabilityStatus:
        (r.latest_availability_status as 'available' | 'unavailable' | 'unknown' | null) ?? null,
      latestAvailabilityCheckedAt: r.latest_availability_checked_at
        ? toISOString(r.latest_availability_checked_at)
        : null,
    }));
  }

  /**
   * List bounded source summaries aggregated across a root run and all its
   * descendant child runs, scoped by company and project
   * (fix-ut-m5-artifact-id-source-aggregation).
   *
   * When a root run's `/sources` endpoint is queried, sources were only
   * visible at the child run level because `run_research_sources.run_id`
   * stores the child run ID, not the root run ID. This method queries by
   * `root_run_id` instead, aggregating all sources from the root run and
   * every child run in one response. The `runId` field in each summary
   * remains the actual producing (child) run ID so the UI can attribute
   * each source to its originating child run.
   *
   * Returns the same safe summary fields as `listRunSourceSummaries`; never
   * full content, display metadata, credentials, or raw provider payloads.
   */
  async listAggregatedSourceSummaries(
    companyId: string,
    projectId: string | undefined,
    rootRunId: string,
  ): Promise<SourceSummary[]> {
    const rows = (await this.deps.drizzle.execute(sql`
      SELECT
        rsr."id" AS "source_revision_id",
        rsr."source_id" AS "source_id",
        rrs."run_id" AS "run_id",
        rs."canonical_url" AS "canonical_url",
        rsr."content_hash" AS "content_hash",
        rsr."byte_count" AS "byte_count",
        rsr."retrieved_at" AS "retrieved_at",
        rrs."rank" AS "rank",
        rrs."relevance_score" AS "relevance_score",
        rsr."status" AS "status",
        rsr."provider" AS "provider",
        rsr."operation" AS "operation",
        rsr."injection_risk_labels" AS "injection_risk_labels",
        rsr."warnings" AS "warnings",
        rrs."excluded" AS "excluded",
        rrs."exclusion_reason" AS "exclusion_reason",
        rrs."selected" AS "selected",
        latest_avail."status" AS "latest_availability_status",
        latest_avail."created_at" AS "latest_availability_checked_at"
      FROM "run_research_sources" rrs
      JOIN "research_source_revisions" rsr ON rsr."id" = rrs."source_revision_id"
      JOIN "research_sources" rs ON rs."id" = rsr."source_id"
      LEFT JOIN LATERAL (
        SELECT "status", "created_at"
        FROM "research_source_availability_checks"
        WHERE "source_revision_id" = rsr."id"
          AND "company_id" = ${companyId}
        ORDER BY "created_at" DESC
        LIMIT 1
      ) latest_avail ON TRUE
      WHERE rrs."root_run_id" = ${rootRunId}
        AND rrs."company_id" = ${companyId}
        ${projectId ? sql`AND rrs."project_id" = ${projectId}` : sql`AND rrs."project_id" IS NULL`}
      ORDER BY rrs."rank" NULLS LAST, rsr."created_at"
    `)) as unknown as {
      source_revision_id: string;
      source_id: string;
      run_id: string;
      canonical_url: string;
      content_hash: string | null;
      byte_count: number;
      retrieved_at: Date;
      rank: number | null;
      relevance_score: number | null;
      status: string;
      provider: string;
      operation: string;
      injection_risk_labels: string[] | null;
      warnings: string[] | null;
      excluded: boolean | null;
      exclusion_reason: string | null;
      selected: boolean | null;
      latest_availability_status: string | null;
      latest_availability_checked_at: Date | null;
    }[];
    return rows.map((r) => ({
      sourceRevisionId: r.source_revision_id,
      sourceId: r.source_id,
      runId: r.run_id,
      canonicalUrl: r.canonical_url,
      contentHash: r.content_hash ?? undefined,
      byteCount: r.byte_count,
      retrievedAt: toISOString(r.retrieved_at),
      rank: r.rank ?? undefined,
      relevanceScore: r.relevance_score ?? undefined,
      status: r.status,
      provider: r.provider,
      operation: r.operation,
      injectionRiskLabels: r.injection_risk_labels ?? [],
      warnings: r.warnings ?? [],
      excluded: r.excluded ?? false,
      exclusionReason: r.exclusion_reason,
      selected: r.selected ?? true,
      latestAvailabilityStatus:
        (r.latest_availability_status as 'available' | 'unavailable' | 'unknown' | null) ?? null,
      latestAvailabilityCheckedAt: r.latest_availability_checked_at
        ? toISOString(r.latest_availability_checked_at)
        : null,
    }));
  }
}
