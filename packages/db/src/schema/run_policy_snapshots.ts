import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

/**
 * Immutable effective-policy snapshot for one Mission run.
 *
 * Workers read only this snapshot, never live profile or agent settings. The
 * canonical `content_hash` (lowercase SHA-256 hex) covers the entire
 * effective policy so approval/execution can bind to an exact version.
 *
 * Phase 1 stores the resolved policy as bounded JSONB fields. Secrets,
 * prompts, and retrieved content are never persisted here — only hashes and
 * allowlists.
 */
export const runPolicySnapshots = pgTable(
  'run_policy_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    schemaVersion: integer('schema_version').notNull().default(1),
    // Built-in mode slug (e.g. "fast") or custom profile slug. Null only if
    // the source is not a profile row (built-ins are code-owned constants).
    sourceProfile: text('source_profile'),
    /**
     * Display name of the source mode/profile at snapshot time. For built-in
     * modes this is the human-readable name (e.g. "Fast", "Deep Work"). For
     * custom profiles this is the profile's name row. Stored so historical
     * mode identity survives profile renames, disables, or deletions
     * (VAL-MODEQ-129). This is display text and is NOT included in the
     * canonical content hash (VAL-MODEQ-127).
     */
    sourceProfileName: text('source_profile_name'),
    /**
     * Description of the source mode/profile at snapshot time. Same
     * survival and exclusion rules as sourceProfileName (VAL-MODEQ-129,
     * VAL-MODEQ-127).
     */
    sourceProfileDescription: text('source_profile_description'),
    sourceProfileVersion: integer('source_profile_version'),
    provider: text('provider').notNull(),
    adapterId: text('adapter_id'),
    model: text('model').notNull(),
    reasoningDepth: text('reasoning_depth'),
    systemPromptHash: text('system_prompt_hash'),
    instructionHash: text('instruction_hash'),
    toolAllowlist: jsonb('tool_allowlist').notNull().$type<string[]>().default([]),
    domainAllowlist: jsonb('domain_allowlist').notNull().$type<string[]>().default([]),
    researchPolicy: jsonb('research_policy').notNull().$type<Record<string, unknown>>().default({}),
    planningPolicy: jsonb('planning_policy').notNull().$type<Record<string, unknown>>().default({}),
    approvalPolicy: jsonb('approval_policy').notNull().$type<Record<string, unknown>>().default({}),
    fallbackPolicy: jsonb('fallback_policy').notNull().$type<Record<string, unknown>>().default({}),
    partialResultPolicy: text('partial_result_policy', {
      enum: ['require_all', 'best_effort'],
    })
      .notNull()
      .default('require_all'),
    // Numeric limits: { steps, durationSeconds, providerCalls, totalTokens,
    // outputBytes, costCents, depth, fanOut, descendants }.
    limits: jsonb('limits').notNull().$type<Record<string, number>>().default({}),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('idx_run_policy_snapshots_content_hash').on(table.contentHash)],
);
