import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { artifacts, artifactRevisions } from './artifacts.js';
import { researchSourceRevisions } from './research_sources.js';

/**
 * Citations and artifact provenance.
 *
 * (architecture.md: ResearchSource, Citation, and Artifact Provenance,
 *  VAL-RES-097, VAL-RES-113, VAL-CROSS-034)
 *
 * Citations bind to the EXACT immutable source revision and artifact
 * revision. A citation never silently retargets a newer source or artifact
 * revision. Stable ordinals are unique within an artifact revision.
 *
 * Frozen display metadata (VAL-RES-113): each citation captures a snapshot
 * of the source's display metadata (title, author, canonical URL, retrieval
 * time, provider, content hash) at citation creation time. A historical
 * citation view shows the frozen metadata, not the current source metadata,
 * so a later edit or re-retrieval cannot rewrite the provenance drawer.
 *
 * Artifact provenance binds an artifact revision to its producing run,
 * approved plan revision/hash, policy hash, producing step/child, and cited
 * source revisions. The atomic commit of artifact revision + citations +
 * provenance in one transaction is implemented by m5-f07; the tables and
 * identity/frozen-metadata logic live here.
 *
 * Encryption-at-rest (VAL-RES-107): quote text and frozen display metadata
 * are encrypted by the service layer via the encryption manifest. Hashes,
 * IDs, ordinals, offsets, and the canonical URL remain plaintext.
 *
 * Forward-only and additive: two new tables. No changes to existing
 * enums or constraints.
 */

// ---------------------------------------------------------------------------
// citations — exact-revision-bound citation identity
// ---------------------------------------------------------------------------

export const citations = pgTable(
  'citations',
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
    /** Exact immutable source revision the citation is bound to. */
    sourceRevisionId: text('source_revision_id')
      .notNull()
      .references(() => researchSourceRevisions.id, { onDelete: 'cascade' }),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /** Exact immutable artifact revision the citation is bound to. */
    artifactRevisionId: text('artifact_revision_id')
      .notNull()
      .references(() => artifactRevisions.id, { onDelete: 'cascade' }),
    /** Stable ordinal within the artifact revision. */
    ordinal: integer('ordinal').notNull(),
    /** Exact quote text (encrypted at rest). */
    quoteExactEncrypted: text('quote_exact_encrypted').notNull(),
    /** Prefix context (encrypted at rest). */
    quotePrefixEncrypted: text('quote_prefix_encrypted'),
    /** Suffix context (encrypted at rest). */
    quoteSuffixEncrypted: text('quote_suffix_encrypted'),
    /** SHA-256 of the exact normalized quote (lowercase hex, plaintext). */
    quoteHash: text('quote_hash').notNull(),
    /** Character offset into the normalized source revision text. */
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    section: text('section'),
    /** Frozen display metadata captured at citation creation (VAL-RES-113). */
    frozenTitleEncrypted: text('frozen_title_encrypted'),
    frozenAuthorEncrypted: text('frozen_author_encrypted'),
    /** Canonical URL is plaintext for deep links. */
    frozenCanonicalUrl: text('frozen_canonical_url').notNull(),
    frozenRetrievedAt: timestamp('frozen_retrieved_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }).notNull(),
    frozenProvider: text('frozen_provider').notNull(),
    frozenContentHash: text('frozen_content_hash'),
    /** Artifact locator: {artifactVersion, jsonPointer, blockId?, start?, end?}. */
    artifactLocator: jsonb('artifact_locator').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_citations_artifact_revision_ordinal').on(
      table.artifactRevisionId,
      table.ordinal,
    ),
    index('idx_citations_source_revision').on(table.sourceRevisionId),
    index('idx_citations_run').on(table.runId),
    index('idx_citations_company_project').on(table.companyId, table.projectId),
    check('chk_citations_ordinal_nonneg', sql`${table.ordinal} >= 0`),
    check('chk_citations_quote_hash_hex', sql`length(${table.quoteHash}) = 64`),
  ],
);

// ---------------------------------------------------------------------------
// artifact_provenance — artifact revision to producing run and sources
// ---------------------------------------------------------------------------

export const artifactProvenance = pgTable(
  'artifact_provenance',
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
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /** Exact immutable artifact revision this provenance describes. */
    artifactRevisionId: text('artifact_revision_id')
      .notNull()
      .references(() => artifactRevisions.id, { onDelete: 'cascade' }),
    approvedPlanRevisionId: text('approved_plan_revision_id'),
    approvedPlanHash: text('approved_plan_hash'),
    policyHash: text('policy_hash'),
    producingStepKey: text('producing_step_key'),
    producingChildRunId: text('producing_child_run_id'),
    generationTime: timestamp('generation_time', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }).notNull(),
    /** Cited source revision IDs (jsonb array of strings, plaintext IDs). */
    citedSourceRevisionIds: jsonb('cited_source_revision_ids')
      .notNull()
      .default([])
      .$type<string[]>(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_artifact_provenance_revision').on(table.artifactRevisionId),
    index('idx_artifact_provenance_run').on(table.runId),
    index('idx_artifact_provenance_company_project').on(table.companyId, table.projectId),
  ],
);

// ---------------------------------------------------------------------------
// citation_carry_forward_outcomes — verified carry-forward tracking
// (m5-f07-provenance-revision-restoration)
//
// VAL-RES-034: Revision-aware carried citation. A later artifact edit either
//   preserves a citation at a verified-unchanged locator (writing a new
//   revision-bound citation row) or marks it not-carried-forward.
// VAL-RES-099: Restoring a cited revision creates verified citation rows.
// VAL-CROSS-042: Edited artifacts do not float citations — citations never
//   silently move to a newer artifact revision.
//
// Each outcome row records what happened to a previous revision's citation
// when a new artifact revision was created (edit or restoration):
//   - outcome 'carried_forward': the locator verified against the new
//     content, a new citation row was written bound to the new revision,
//     and `new_citation_id` points at it.
//   - outcome 'not_carried_forward': the locator did not verify (the cited
//     passage changed, the citation mark was removed, or the source locator
//     no longer verifies). The original citation remains historical, bound
//     to its original revision. `reason` explains why it was not carried.
//
// Forward-only and additive: one new table + one new enum. No changes to
// existing tables, enums, or constraints.
// ---------------------------------------------------------------------------

export const carryForwardOutcomeEnum = pgEnum('carry_forward_outcome', [
  'carried_forward',
  'not_carried_forward',
]);

export const citationCarryForwardOutcomes = pgTable(
  'citation_carry_forward_outcomes',
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
    /** The citation from the previous revision being evaluated. */
    previousCitationId: text('previous_citation_id')
      .notNull()
      .references(() => citations.id, { onDelete: 'cascade' }),
    /** The new artifact revision the citation was evaluated against. */
    newArtifactRevisionId: text('new_artifact_revision_id')
      .notNull()
      .references(() => artifactRevisions.id, { onDelete: 'cascade' }),
    /** The new citation row when carried forward; null when not carried. */
    newCitationId: text('new_citation_id').references(() => citations.id, { onDelete: 'set null' }),
    outcome: carryForwardOutcomeEnum('outcome').notNull(),
    /** Reason when not carried forward (nullable when carried). */
    reason: text('reason'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_carry_forward_prev_new').on(
      table.previousCitationId,
      table.newArtifactRevisionId,
    ),
    index('idx_carry_forward_new_revision').on(table.newArtifactRevisionId),
    index('idx_carry_forward_run').on(table.runId),
    index('idx_carry_forward_company_project').on(table.companyId, table.projectId),
    check(
      'chk_carry_forward_outcome_new_citation',
      sql`(${table.outcome} = 'carried_forward' AND ${table.newCitationId} IS NOT NULL) OR (${table.outcome} = 'not_carried_forward')`,
    ),
  ],
);
