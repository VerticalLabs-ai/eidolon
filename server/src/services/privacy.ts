import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbInstance } from '../types.js';
import { createClerkClient } from '@clerk/backend';

/**
 * Subject-data export and erasure.
 *
 * `docs/security/data-handling.md` used to say that operators must handle
 * access and deletion requests by hand. Doing that correctly requires knowing
 * every place a user id is stored, which is exactly the knowledge that goes
 * stale first, so the inventory below is the whole implementation: each table
 * that references a user, and what happens to it.
 *
 * Identity itself lives in Clerk. This database stores the Clerk user id plus
 * whatever the person authored, so erasure removes the link between a person
 * and their activity rather than deleting a profile that was never here.
 */

/** How a reference to the subject is removed. */
export type ErasureStrategy =
  /** The row exists only to describe this person. Delete it. */
  | 'delete'
  /** Attribution on shared content. Null it and keep the content. */
  | 'null'
  /**
   * The column cannot be null, or the row is audit evidence. Replace the id
   * with an irreversible pseudonym so the sequence of actions still reads as
   * one actor without naming them.
   */
  | 'pseudonymise';

export type PersonalDataRule = {
  /** Physical table name. */
  table: string;
  /** Physical column holding the user id. */
  column: string;
  strategy: ErasureStrategy;
  /**
   * How the row is scoped to a company. `direct` means the table has its own
   * `company_id`; otherwise the row is reached through a parent table, because
   * erasure must never cross a company boundary.
   */
  scope:
    | { kind: 'direct' }
    | { kind: 'parent'; parentTable: string; foreignKey: string; parentKey?: string }
    /** Not company-scoped at all: an authentication artifact for the person. */
    | { kind: 'global' };
  /** Included in the export payload. Session and factor rows are not, since
   *  returning them would hand an operator live authentication material. */
  exportable: boolean;
  why: string;
};

/**
 * Every table that stores a user id, and its disposition.
 *
 * `privacy-inventory.test.ts` re-derives this list from the schema sources and
 * fails when a new table gains a user column that is not listed here. Without
 * that check this inventory would be correct exactly once.
 */
export const PERSONAL_DATA_RULES: PersonalDataRule[] = [
  {
    table: 'company_members',
    column: 'user_id',
    strategy: 'delete',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'The membership row exists only to describe this person’s access.',
  },
  {
    table: 'company_members',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Who invited another member is attribution on someone else’s row.',
  },
  {
    table: 'inbox_read_states',
    column: 'user_id',
    strategy: 'delete',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Reading behaviour is personal and has no value to anyone else.',
  },
  {
    table: 'user_mfa_factors',
    column: 'user_id',
    strategy: 'delete',
    scope: { kind: 'global' },
    exportable: false,
    why: 'Authentication factors. Deleted, never exported.',
  },
  {
    table: 'step_up_sessions',
    column: 'user_id',
    strategy: 'delete',
    scope: { kind: 'global' },
    exportable: false,
    why: 'Live elevation sessions. Deleted, never exported.',
  },
  {
    table: 'local_trusted_sessions',
    column: 'user_id',
    strategy: 'delete',
    scope: { kind: 'global' },
    exportable: false,
    why: 'Local development sessions. Deleted, never exported.',
  },
  {
    table: 'team_members',
    column: 'user_id',
    strategy: 'delete',
    scope: { kind: 'parent', parentTable: 'teams', foreignKey: 'team_id' },
    exportable: true,
    why: 'Team membership describes this person’s place in the org chart.',
  },
  {
    table: 'artifacts',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'The artifact is company work product; only the attribution is personal.',
  },
  {
    table: 'artifact_permissions',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Who granted access is attribution; the grant itself must survive.',
  },
  {
    table: 'tasks',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Deleting tasks would destroy company work and break task history.',
  },
  {
    table: 'task_holds',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'A hold constrains a task and must outlive its author’s attribution.',
  },
  {
    table: 'task_thread_items',
    column: 'author_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Thread content is a company record; authorship is the personal part.',
  },
  {
    table: 'approval_comments',
    column: 'author_user_id',
    strategy: 'null',
    scope: { kind: 'parent', parentTable: 'approvals', foreignKey: 'approval_id' },
    exportable: true,
    why: 'An approval decision trail must stay readable without the name.',
  },
  {
    table: 'meetings',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Meeting records belong to the company.',
  },
  {
    table: 'project_threads',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Project discussion is company context.',
  },
  {
    table: 'project_plans',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Plans drive execution and cannot be removed with their author.',
  },
  {
    table: 'project_outcomes',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Outcomes are the record of what the company achieved.',
  },
  {
    table: 'project_decisions',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Decisions must remain auditable after a person leaves.',
  },
  {
    table: 'teams',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'The team outlives whoever created it.',
  },
  {
    table: 'project_templates',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Templates are reusable company assets.',
  },
  {
    table: 'artifact_templates',
    column: 'created_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Templates are reusable company assets.',
  },
  {
    table: 'agent_api_keys',
    column: 'created_by_user_id',
    strategy: 'pseudonymise',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'The column is NOT NULL, and a key must keep a traceable creator.',
  },
  {
    table: 'company_invitations',
    column: 'invited_by_user_id',
    strategy: 'pseudonymise',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'The column is NOT NULL, and who invited whom is access-control evidence.',
  },
  {
    table: 'company_invitations',
    column: 'accepted_by_user_id',
    strategy: 'null',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Acceptance links the invitation to this person.',
  },
  {
    table: 'activity_log',
    column: 'actor_id',
    strategy: 'pseudonymise',
    scope: { kind: 'direct' },
    exportable: true,
    why: 'Audit rows are never deleted. The actor id is replaced so the trail stays intact without identifying the person.',
  },
];

/**
 * Irreversible per-company pseudonym.
 *
 * Salted with the company id so the same person cannot be correlated across
 * companies from the pseudonym alone, and truncated because a full digest only
 * makes the value longer, not safer.
 */
export function subjectPseudonym(companyId: string, userId: string): string {
  const digest = createHash('sha256').update(`${companyId}:${userId}`).digest('hex');
  return `anon:${digest.slice(0, 16)}`;
}

/** Redaction for an invited email address, stable per address so the pending
 *  unique index on (company_id, email) cannot collide after redaction. */
export function redactedEmail(email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return `redacted+${digest.slice(0, 16)}@invalid`;
}

// ---------------------------------------------------------------------------
// Field-level PII classification inventory
// ---------------------------------------------------------------------------
//
// `PERSONAL_DATA_RULES` answers "where is a user id stored?" — the question
// erasure needs. Privacy handling also needs "where is sensitive data stored
// even when no user id is on the row?" — an email address, an MFA secret, a
// meeting transcript, an encrypted provider secret. This inventory classifies
// those fields by sensitivity so a new credential or contact column cannot
// land unclassified.
//
// `privacy-inventory.test.ts` re-derives the sensitive columns from the schema
// sources by name pattern and fails when one is missing here, so this list is
// correct more than once.

export type PiiSensitivity =
  /** A column holding a user id that ties a row to a person. */
  | 'identity'
  /** An email address or other direct contact handle. */
  | 'contact'
  /** A secret, token, API key material, or MFA secret. */
  | 'credential'
  /** Free-text content that may hold personal data: prompts, transcripts. */
  | 'confidential'
  /** Cost and billing data. Sensitive business data, not personal data per se. */
  | 'financial'
  /** A jsonb blob that may carry arbitrary personal data. */
  | 'metadata';

/** How a sensitive field is protected, at rest or on subject erasure. */
export type PiiProtection =
  /** Irreversible digest stored (e.g. API key hashes). */
  | 'hashed'
  /** Encrypted value stored (e.g. secrets.value_encrypted). */
  | 'encrypted-at-rest'
  /** Replaced with a stable redaction when the subject is erased. */
  | 'redacted-on-erasure'
  /** Removed when the subject's row is deleted or nulled. */
  | 'erased-with-subject'
  /** Company work product; retention governed by company policy. */
  | 'company-owned'
  /** Test fixture only; never production data. */
  | 'test-fixture';

export type PiiFieldClassification = {
  table: string;
  column: string;
  sensitivity: PiiSensitivity;
  protection: PiiProtection;
  why: string;
};

/**
 * Identity columns are derived from `PERSONAL_DATA_RULES` so the two lists can
 * never drift: every user-id column is an `identity` field, and its protection
 * follows its erasure strategy.
 */
function identityClassifications(): PiiFieldClassification[] {
  return PERSONAL_DATA_RULES.map((rule) => ({
    table: rule.table,
    column: rule.column,
    sensitivity: 'identity' as const,
    protection: rule.strategy === 'pseudonymise' ? 'redacted-on-erasure' : 'erased-with-subject',
    why: rule.why,
  }));
}

/**
 * Every sensitive field in the schema that is NOT a user id, with its
 * sensitivity and how it is protected.
 */
const NON_IDENTITY_CLASSIFICATIONS: PiiFieldClassification[] = [
  // --- Contact -------------------------------------------------------------
  {
    table: 'company_invitations',
    column: 'email',
    sensitivity: 'contact',
    protection: 'redacted-on-erasure',
    why: 'The only real contact detail this database stores. Replaced with a stable non-routable redaction on erasure so the pending unique index cannot collide.',
  },
  {
    table: 'test_users',
    column: 'email',
    sensitivity: 'contact',
    protection: 'test-fixture',
    why: 'Local-trusted test harness fixture only. Never present in production data.',
  },
  // --- Credentials ---------------------------------------------------------
  {
    table: 'user_mfa_factors',
    column: 'secret',
    sensitivity: 'credential',
    protection: 'erased-with-subject',
    why: 'Base32 TOTP secret. The factor row is deleted on erasure, destroying the secret with it.',
  },
  {
    table: 'webhooks',
    column: 'secret',
    sensitivity: 'credential',
    protection: 'company-owned',
    why: 'Webhook signing secret, company-scoped not subject-scoped. Rotated by the company owner; never exported or logged.',
  },
  {
    table: 'agent_api_keys',
    column: 'key_hash',
    sensitivity: 'credential',
    protection: 'hashed',
    why: 'SHA-256 hash of the raw API key. Only the hash is stored; the raw key is returned once on creation and never recoverable.',
  },
  {
    table: 'agent_api_keys',
    column: 'key_prefix',
    sensitivity: 'credential',
    protection: 'hashed',
    why: 'First 10 characters of the raw key, stored for display only. Not sufficient to authenticate.',
  },
  {
    table: 'secrets',
    column: 'value_encrypted',
    sensitivity: 'credential',
    protection: 'encrypted-at-rest',
    why: 'Provider secret stored encrypted at rest. Company-scoped; never exported or logged.',
  },
  {
    table: 'agents',
    column: 'api_key_encrypted',
    sensitivity: 'credential',
    protection: 'encrypted-at-rest',
    why: 'Per-agent provider API key stored encrypted at rest. Company-scoped; the raw key is never recoverable or logged.',
  },
  {
    table: 'integrations',
    column: 'credentials_encrypted',
    sensitivity: 'credential',
    protection: 'encrypted-at-rest',
    why: 'Third-party integration credentials stored encrypted at rest. Company-scoped; never exported or logged.',
  },
  {
    table: 'mcp_servers',
    column: 'env',
    sensitivity: 'credential',
    protection: 'company-owned',
    why: 'JSONB map of environment variables passed to an MCP server process. Commonly holds API keys, tokens, and other provider credentials; company-scoped, never exported or logged.',
  },
  // --- Confidential content: agent prompts and instructions ----------------
  {
    table: 'agents',
    column: 'system_prompt',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Agent system prompt text authored by the company. May reference people or sensitive instructions; confidential.',
  },
  {
    table: 'agents',
    column: 'instructions',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Agent instruction text authored by the company. May reference people or sensitive directives; confidential.',
  },
  // --- Confidential content: transcripts and prompts -----------------------
  {
    table: 'meetings',
    column: 'transcript',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Pasted or transcribed meeting text. May reference named individuals; treated as confidential company content.',
  },
  {
    table: 'agent_runtime_sessions',
    column: 'transcript',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Agent execution transcript. May contain prompts and outputs that reference people; confidential company content.',
  },
  {
    table: 'routines',
    column: 'prompt',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Routine prompt text authored by the company. May reference people or sensitive instructions; confidential.',
  },
  // --- Confidential content: free-text columns -----------------------------
  {
    table: 'approval_comments',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Free-text approval comment. May reference named individuals or sensitive decisions; confidential company content.',
  },
  {
    table: 'prompt_templates',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Prompt template body. May reference people or contain sensitive instructions; confidential company content.',
  },
  {
    table: 'prompt_versions',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Historical prompt template version body. Same sensitivity as the template itself; confidential company content.',
  },
  {
    table: 'company_skills',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Skill definition content. May embed sensitive instructions or reference people; confidential company content.',
  },
  {
    table: 'task_thread_items',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Free-text thread message. May reference named individuals or contain personal data; confidential company content.',
  },
  {
    table: 'agent_files',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Inline file content stored by an agent. May contain personal data or sensitive material; confidential company content.',
  },
  {
    table: 'messages',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Inter-agent message body. May reference named individuals or contain personal data; confidential company content.',
  },
  {
    table: 'agent_memories',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Agent memory entry. Observations and preferences may reference people; confidential company content.',
  },
  {
    table: 'knowledge_documents',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Knowledge base document body. May contain personal data copied from external sources; confidential company content.',
  },
  {
    table: 'knowledge_chunks',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Embedded knowledge chunk text. Inherited sensitivity from the parent document; confidential company content.',
  },
  {
    table: 'agent_executions',
    column: 'log',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'JSONB structured execution log for an agent run. May capture prompts, tool inputs/outputs, and intermediate reasoning that reference people; confidential company content.',
  },
  {
    table: 'mcp_tool_calls',
    column: 'arguments',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'JSONB arguments passed to an MCP tool invocation. May carry personal data or sensitive parameters extracted from user content; confidential company content.',
  },
  {
    table: 'mcp_tool_calls',
    column: 'result',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'JSONB result returned from an MCP tool invocation. May contain personal data or sensitive tool output; confidential company content.',
  },
  {
    table: 'artifacts',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'encrypted-at-rest',
    why: 'Structured artifact content (documents, sheets, boards). Encrypted at rest; may contain personal data; confidential company content.',
  },
  {
    table: 'artifact_revisions',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'encrypted-at-rest',
    why: 'Historical artifact revision content. Encrypted at rest like the parent artifact; may contain personal data; confidential.',
  },
  {
    table: 'artifact_templates',
    column: 'content',
    sensitivity: 'confidential',
    protection: 'company-owned',
    why: 'Template snapshot of artifact content. Reusable company asset that may contain personal data; confidential.',
  },
  // --- Metadata: JSONB blobs that may carry arbitrary personal data ---------
  {
    table: 'agents',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on an agent. Could carry personal data injected by users; treated as metadata-tier sensitive.',
  },
  {
    table: 'company_skills',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on a skill. Could carry personal data; treated as metadata-tier sensitive.',
  },
  {
    table: 'project_outcomes',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on a project outcome. Could carry personal data; treated as metadata-tier sensitive.',
  },
  {
    table: 'activity_log',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on an audit row. Could carry personal data about the actor or entity; metadata-tier sensitive.',
  },
  {
    table: 'execution_environments',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on an execution environment. Could carry personal data; metadata-tier sensitive.',
  },
  {
    table: 'workspace_lifecycle_events',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on a lifecycle event. Could carry personal data about the actor; metadata-tier sensitive.',
  },
  {
    table: 'messages',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on a message. Could carry personal data; metadata-tier sensitive.',
  },
  {
    table: 'meetings',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on a meeting. Could carry personal data about attendees; metadata-tier sensitive.',
  },
  {
    table: 'knowledge_documents',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on a knowledge document. Could carry personal data; metadata-tier sensitive.',
  },
  {
    table: 'knowledge_chunks',
    column: 'metadata',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB metadata on a knowledge chunk. Inherited sensitivity from the parent document; metadata-tier sensitive.',
  },
  // --- Metadata: config blobs that may carry credentials or personal data ---
  {
    table: 'agents',
    column: 'config',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB agent config. Could carry credentials or personal data; metadata-tier sensitive, never exported or logged.',
  },
  {
    table: 'agents',
    column: 'adapter_config',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB adapter config. Could carry credentials or personal data; metadata-tier sensitive, never exported or logged.',
  },
  {
    table: 'agent_runtime_sessions',
    column: 'adapter_config',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Arbitrary JSONB adapter config for a runtime session. Could carry credentials; metadata-tier sensitive.',
  },
  {
    table: 'integrations',
    column: 'config',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Integration config stored as text JSON. Could carry credentials or personal data; metadata-tier sensitive.',
  },
  {
    table: 'company_templates',
    column: 'config',
    sensitivity: 'metadata',
    protection: 'company-owned',
    why: 'Template config JSONB. Could carry sensitive configuration patterns; metadata-tier sensitive.',
  },
  // --- Financial -----------------------------------------------------------
  {
    table: 'cost_events',
    column: 'cost_cents',
    sensitivity: 'financial',
    protection: 'company-owned',
    why: 'Per-run token cost in cents. Sensitive business data, company-scoped; not personal data but retained per the financial retention policy.',
  },
  {
    table: 'budget_alerts',
    column: 'threshold_percent',
    sensitivity: 'financial',
    protection: 'company-owned',
    why: 'Budget alert threshold. Sensitive business configuration, company-scoped; retained per the financial retention policy.',
  },
];

/**
 * The full field-level PII classification inventory: identity columns derived
 * from `PERSONAL_DATA_RULES` plus every non-identity sensitive field.
 */
export const PII_FIELD_CLASSIFICATIONS: PiiFieldClassification[] = [
  ...identityClassifications(),
  ...NON_IDENTITY_CLASSIFICATIONS,
];

function scopeCondition(rule: PersonalDataRule, companyId: string) {
  switch (rule.scope.kind) {
    case 'direct':
      return sql`and t.company_id = ${companyId}`;
    case 'parent': {
      const parentKey = rule.scope.parentKey ?? 'id';
      return sql`and exists (
        select 1 from ${sql.identifier(rule.scope.parentTable)} p
        where p.${sql.identifier(parentKey)} = t.${sql.identifier(rule.scope.foreignKey)}
          and p.company_id = ${companyId}
      )`;
    }
    case 'global':
      // Authentication artifacts are per person, not per company. An erasure is
      // still authorised through a company, so this is called only after
      // membership has been verified.
      return sql``;
  }
}

export type ExportedTable = {
  table: string;
  column: string;
  rows: Record<string, unknown>[];
};

export type SubjectExport = {
  subject: string;
  companyId: string;
  generatedAt: string;
  tables: ExportedTable[];
  totalRows: number;
};

export async function exportSubjectData(
  db: DbInstance,
  companyId: string,
  userId: string,
): Promise<SubjectExport> {
  const tables: ExportedTable[] = [];
  let totalRows = 0;

  for (const rule of PERSONAL_DATA_RULES) {
    if (!rule.exportable) {
      continue;
    }
    const rows = (await db.drizzle.execute(sql`
      select t.* from ${sql.identifier(rule.table)} t
      where t.${sql.identifier(rule.column)} = ${userId}
      ${scopeCondition(rule, companyId)}
      limit 5000
    `)) as unknown as Record<string, unknown>[];

    if (rows.length > 0) {
      tables.push({ table: rule.table, column: rule.column, rows });
      totalRows += rows.length;
    }
  }

  return {
    subject: userId,
    companyId,
    generatedAt: new Date().toISOString(),
    tables,
    totalRows,
  };
}

export type ErasureAction = {
  table: string;
  column: string;
  strategy: ErasureStrategy;
  rowsAffected: number;
};

/** Outcome of the best-effort Clerk identity deletion step. */
export type ClerkDeletionResult = {
  /** Whether a Clerk API call was attempted. False when unconfigured. */
  attempted: boolean;
  /** Whether the Clerk user was actually deleted. */
  deleted: boolean;
  /** Human-readable explanation of the outcome or the manual fallback. */
  reason: string;
};

export type ErasureReport = {
  companyId: string;
  pseudonym: string;
  erasedAt: string;
  actions: ErasureAction[];
  rowsAffected: number;
  remainingReferences: number;
  /** Outcome of the integrated Clerk identity deletion step. */
  clerkDeletion: ClerkDeletionResult;
};

/**
 * Best-effort deletion of the subject's identity in Clerk.
 *
 * Identity lives in Clerk; this database only stores the Clerk user id. Erasure
 * here severs the link between a person and their activity, but the request is
 * not complete until the identity is also deleted in Clerk. This helper
 * performs that deletion automatically when `CLERK_SECRET_KEY` is configured.
 * When it is not (local development, test environments), it is a safe no-op and
 * the operator must perform the deletion manually — see
 * `docs/security/data-handling.md` for the manual procedure.
 *
 * Never throws: a Clerk failure does not roll back the database erasure, which
 * is already committed and cannot be undone. The failure is reported so the
 * operator can complete the deletion manually.
 */
export async function deleteClerkUser(userId: string): Promise<ClerkDeletionResult> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return {
      attempted: false,
      deleted: false,
      reason:
        'CLERK_SECRET_KEY not configured — delete the user manually in the Clerk dashboard (see docs/security/data-handling.md).',
    };
  }

  try {
    const client = createClerkClient({
      secretKey,
      publishableKey:
        process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    });
    await client.users.deleteUser(userId);
    return { attempted: true, deleted: true, reason: 'User deleted in Clerk.' };
  } catch (err) {
    return {
      attempted: true,
      deleted: false,
      reason: `Clerk deletion failed; complete manually: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Remove the subject's link to this company.
 *
 * Runs in one transaction: a half-erased subject is worse than an unerased one,
 * because it leaves references that no longer resolve to a member.
 */
export async function eraseSubjectData(
  db: DbInstance,
  companyId: string,
  userId: string,
  options: { email?: string } = {},
): Promise<ErasureReport> {
  const pseudonym = subjectPseudonym(companyId, userId);
  const actions: ErasureAction[] = [];

  await db.drizzle.transaction(async (tx) => {
    // Redact the invited address before the acceptance link is nulled, since
    // that link is the only way to find which invitation belongs to this person.
    const acceptedInvites = (await tx.execute(sql`
      select id, email from company_invitations
      where accepted_by_user_id = ${userId} and company_id = ${companyId}
    `)) as unknown as { id: string; email: string }[];

    const emails = new Set(acceptedInvites.map((row) => row.email));
    if (options.email?.trim()) {
      emails.add(options.email.trim());
    }

    let redactedInvites = 0;
    for (const email of emails) {
      const result = (await tx.execute(sql`
        update company_invitations
        set email = ${redactedEmail(email)}
        where company_id = ${companyId} and lower(email) = ${email.toLowerCase()}
      `)) as unknown as { count?: number };
      redactedInvites += Number(result?.count ?? 0);
    }
    if (redactedInvites > 0) {
      actions.push({
        table: 'company_invitations',
        column: 'email',
        strategy: 'pseudonymise',
        rowsAffected: redactedInvites,
      });
    }

    for (const rule of PERSONAL_DATA_RULES) {
      const scope = scopeCondition(rule, companyId);
      const target = sql.identifier(rule.table);
      const column = sql.identifier(rule.column);

      let statement;
      if (rule.strategy === 'delete') {
        statement = sql`delete from ${target} t where t.${column} = ${userId} ${scope}`;
      } else if (rule.strategy === 'null') {
        statement = sql`update ${target} t set ${column} = null where t.${column} = ${userId} ${scope}`;
      } else {
        statement = sql`update ${target} t set ${column} = ${pseudonym} where t.${column} = ${userId} ${scope}`;
      }

      const result = (await tx.execute(statement)) as unknown as { count?: number };
      const rowsAffected = Number(result?.count ?? 0);
      if (rowsAffected > 0) {
        actions.push({
          table: rule.table,
          column: rule.column,
          strategy: rule.strategy,
          rowsAffected,
        });
      }
    }
  });

  // Prove the erasure rather than assume it: re-read every rule and count what
  // still points at the subject.
  let remainingReferences = 0;
  for (const rule of PERSONAL_DATA_RULES) {
    const rows = (await db.drizzle.execute(sql`
      select count(*)::int as count from ${sql.identifier(rule.table)} t
      where t.${sql.identifier(rule.column)} = ${userId}
      ${scopeCondition(rule, companyId)}
    `)) as unknown as { count: number }[];
    remainingReferences += Number(rows[0]?.count ?? 0);
  }

  return {
    companyId,
    pseudonym,
    erasedAt: new Date().toISOString(),
    actions,
    rowsAffected: actions.reduce((sum, action) => sum + action.rowsAffected, 0),
    remainingReferences,
    clerkDeletion: await deleteClerkUser(userId),
  };
}
