import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
  boolean,
  real,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * Normalized research source identity, immutable source revisions, and the
 * run-to-revision join.
 *
 * (architecture.md: ResearchSource, Citation, and Artifact Provenance,
 *  VAL-RES-019, VAL-RES-020, VAL-RES-021, VAL-RES-022, VAL-RES-098,
 *  VAL-RES-112, VAL-CROSS-034)
 *
 * Dedup invariants:
 * - `research_sources` is unique on `(company_id, canonical_url_hash)`:
 *   the same canonical URL within one company is a single source identity.
 *   Different companies get independent rows (tenant-local dedup,
 *   VAL-RES-022). No cross-company deduplication.
 * - `research_source_revisions` is unique on `(source_id, content_hash)`:
 *   unchanged content reuses an existing immutable revision (content-hash
 *   dedup, VAL-RES-020). Changed content has a different content hash and
 *   creates a new immutable revision (VAL-RES-021). Revision rows are never
 *   updated in place.
 *
 * Encryption-at-rest (VAL-RES-107): content and display-metadata columns
 * are encrypted by the service layer via the encryption manifest before
 * being written. Hashes, IDs, counts, ordinals, statuses, timestamps, and
 * the canonical URL remain plaintext for queryability and deep links.
 *
 * Forward-only and additive: three new tables. No changes to existing
 * enums or constraints.
 */

// ---------------------------------------------------------------------------
// research_sources — company-scoped source identity
// ---------------------------------------------------------------------------

export const researchSources = pgTable(
  'research_sources',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Canonical HTTPS URL (plaintext for deep links). */
    canonicalUrl: text('canonical_url').notNull(),
    /** SHA-256 of the canonical URL (lowercase hex, plaintext for dedup). */
    canonicalUrlHash: text('canonical_url_hash').notNull(),
    /** Registered domain extracted from the canonical URL host. */
    originDomain: text('origin_domain').notNull(),
    /** Latest known title (encrypted at rest). */
    titleEncrypted: text('title_encrypted'),
    /** Latest known author (encrypted at rest). */
    authorEncrypted: text('author_encrypted'),
    /** Latest known publication timestamp (encrypted at rest). */
    publishedAtEncrypted: text('published_at_encrypted'),
    /** Latest known language (encrypted at rest). */
    languageEncrypted: text('language_encrypted'),
    firstSeenAt: timestamp('first_seen_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_research_sources_company_url_hash').on(table.companyId, table.canonicalUrlHash),
    index('idx_research_sources_company_domain').on(table.companyId, table.originDomain),
    check('chk_research_sources_url_hash_hex', sql`length(${table.canonicalUrlHash}) = 64`),
  ],
);

// ---------------------------------------------------------------------------
// research_source_revisions — immutable retrieval
// ---------------------------------------------------------------------------

export const researchSourceRevisions = pgTable(
  'research_source_revisions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => researchSources.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    rootRunId: text('root_run_id').notNull(),
    /** Deterministic logical call ID (separate from physical attempt IDs). */
    logicalCallId: text('logical_call_id').notNull(),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    /** SHA-256 hash of the provider request id (lowercase hex). */
    providerRequestIdHash: text('provider_request_id_hash'),
    retrievedAt: timestamp('retrieved_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }).notNull(),
    /** Source normalization algorithm version (VAL-RES-112). */
    normalizationVersion: integer('normalization_version').notNull(),
    /** SHA-256 of the normalized text (lowercase hex). Null when no text. */
    contentHash: text('content_hash'),
    /** Bounded normalized source content (encrypted at rest, ≤1 MiB). */
    normalizedTextEncrypted: text('normalized_text_encrypted'),
    /** Bounded excerpt (encrypted at rest). */
    excerptEncrypted: text('excerpt_encrypted'),
    byteCount: integer('byte_count').notNull().default(0),
    /** MIME type (encrypted at rest). */
    mimeTypeEncrypted: text('mime_type_encrypted'),
    /** Title at retrieval time (encrypted at rest; frozen per revision). */
    titleEncrypted: text('title_encrypted'),
    /** Author at retrieval time (encrypted at rest; frozen per revision). */
    authorEncrypted: text('author_encrypted'),
    /** Publication timestamp at retrieval time (encrypted at rest). */
    publishedAtEncrypted: text('published_at_encrypted'),
    /** Language at retrieval time (encrypted at rest). */
    languageEncrypted: text('language_encrypted'),
    httpStatus: integer('http_status'),
    /** Injection-risk labels (plaintext metadata, not content). */
    injectionRiskLabels: jsonb('injection_risk_labels').notNull().default([]).$type<string[]>(),
    /** Bounded safe warnings (plaintext). */
    warnings: jsonb('warnings').notNull().default([]).$type<string[]>(),
    /** 'available' | 'excluded'. */
    status: text('status').notNull().default('available'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // Reuse an existing immutable revision for unchanged content (VAL-RES-020).
    // Partial unique index: only applies when content_hash is not null.
    uniqueIndex('uq_research_source_revisions_source_hash')
      .on(table.sourceId, table.contentHash)
      .where(sql`${table.contentHash} IS NOT NULL`),
    index('idx_research_source_revisions_run').on(table.runId),
    index('idx_research_source_revisions_source').on(table.sourceId),
    index('idx_research_source_revisions_company_project').on(table.companyId, table.projectId),
    check('chk_research_source_revisions_version_positive', sql`${table.normalizationVersion} > 0`),
    check('chk_research_source_revisions_byte_count_nonneg', sql`${table.byteCount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// run_research_sources — run/logical-call/source-revision join
// ---------------------------------------------------------------------------

export const runResearchSources = pgTable(
  'run_research_sources',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    rootRunId: text('root_run_id').notNull(),
    logicalCallId: text('logical_call_id').notNull(),
    sourceRevisionId: text('source_revision_id')
      .notNull()
      .references(() => researchSourceRevisions.id, { onDelete: 'cascade' }),
    /** Provider-assigned rank (0-based). */
    rank: integer('rank'),
    /** Provider-assigned relevance score (0–1). */
    relevanceScore: real('relevance_score'),
    /** SHA-256 of the search query (lowercase hex). */
    queryHash: text('query_hash'),
    selected: boolean('selected').notNull().default(true),
    excluded: boolean('excluded').notNull().default(false),
    exclusionReason: text('exclusion_reason'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_research_sources_run_revision').on(table.runId, table.sourceRevisionId),
    index('idx_run_research_sources_run').on(table.runId),
    index('idx_run_research_sources_logical_call').on(table.logicalCallId),
  ],
);
