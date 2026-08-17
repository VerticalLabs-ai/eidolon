import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbInstance } from '../types.js';

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

export type ErasureReport = {
  companyId: string;
  pseudonym: string;
  erasedAt: string;
  actions: ErasureAction[];
  rowsAffected: number;
  remainingReferences: number;
};

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
  };
}
