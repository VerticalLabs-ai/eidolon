import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAL_DATA_RULES, PII_FIELD_CLASSIFICATIONS } from '../services/privacy.js';

/**
 * The privacy inventory is a hand-written list, and a hand-written list of every
 * place a user id is stored is correct exactly once. This re-derives the list
 * from the schema sources so adding a table with a user column fails here until
 * someone decides what erasure should do with it.
 */

const SCHEMA_DIR = path.resolve(import.meta.dirname, '../../../packages/db/src/schema');

const USER_COLUMNS = [
  'user_id',
  'created_by_user_id',
  'author_user_id',
  'actor_id',
  'invited_by_user_id',
  'accepted_by_user_id',
  'granted_by_user_id',
  'assignee_user_id',
  'owner_user_id',
];

/**
 * Columns that reference a user but are deliberately out of scope, with the
 * reason. Anything not listed here and not in the inventory fails the test.
 */
const EXCLUDED: Record<string, string> = {
  // Fixture table used only by the test harness; never holds real subjects.
  'test_users.user_id': 'Test fixture table, not production data.',
};

function schemaTables(): { table: string; column: string }[] {
  const found: { table: string; column: string }[] = [];

  for (const file of readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    const tableMatches = [...source.matchAll(/export const \w+ = pgTable\(\s*'(\w+)'/g)];

    for (const [index, match] of tableMatches.entries()) {
      const table = match[1];
      const start = match.index + match[0].length;
      const end = tableMatches[index + 1]?.index ?? source.length;
      const body = source.slice(start, end);

      for (const column of USER_COLUMNS) {
        if (new RegExp(`text\\('${column}'\\)`).test(body)) {
          found.push({ table, column });
        }
      }
    }
  }

  return found;
}

describe('privacy data inventory', () => {
  it('covers every schema column that references a user', () => {
    const declared = new Set(PERSONAL_DATA_RULES.map((rule) => `${rule.table}.${rule.column}`));
    const discovered = schemaTables().map(({ table, column }) => `${table}.${column}`);

    // The scan itself must keep working: if a refactor breaks the regex, an
    // empty result would make this test vacuously pass.
    expect(discovered.length).toBeGreaterThan(15);

    const uncovered = discovered.filter((key) => !declared.has(key) && !(key in EXCLUDED));
    expect(uncovered).toEqual([]);
  });

  it('declares no rule for a column that no longer exists', () => {
    const discovered = new Set(schemaTables().map(({ table, column }) => `${table}.${column}`));

    const stale = PERSONAL_DATA_RULES.map((rule) => `${rule.table}.${rule.column}`).filter(
      (key) => !discovered.has(key),
    );
    expect(stale).toEqual([]);
  });

  it('never exports authentication material', () => {
    const authTables = ['user_mfa_factors', 'step_up_sessions', 'local_trusted_sessions'];
    for (const table of authTables) {
      const rules = PERSONAL_DATA_RULES.filter((rule) => rule.table === table);
      expect(rules.length, `${table} must have a rule`).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.exportable, `${table} must not be exportable`).toBe(false);
        expect(rule.strategy).toBe('delete');
      }
    }
  });

  it('never deletes an audit row', () => {
    const auditRules = PERSONAL_DATA_RULES.filter((rule) => rule.table === 'activity_log');
    expect(auditRules).toHaveLength(1);
    expect(auditRules[0].strategy).toBe('pseudonymise');
  });

  it('gives every rule a stated reason', () => {
    for (const rule of PERSONAL_DATA_RULES) {
      expect(rule.why.length, `${rule.table}.${rule.column} needs a reason`).toBeGreaterThan(20);
    }
  });
});

/**
 * Field-level PII classification.
 *
 * The inventory above only tracks columns that hold a *user id*. Real PII
 * handling has to go further: an email address, an MFA secret, a meeting
 * transcript, or an encrypted provider secret are all sensitive even when no
 * user id is on the row. This suite re-derives the sensitive columns from the
 * schema sources by name pattern and verifies each one carries a sensitivity
 * classification in `PII_FIELD_CLASSIFICATIONS`, so adding a new credential or
 * contact column fails here until someone decides how it is protected.
 */

/** Column-name patterns that mark a field as inherently sensitive, mapped to
 *  the sensitivity category the inventory must assign. `column` is the literal
 *  physical column name the pattern matches. */
const SENSITIVE_COLUMN_PATTERNS: { column: string; sensitivity: string }[] = [
  { column: 'email', sensitivity: 'contact' },
  { column: 'secret', sensitivity: 'credential' },
  { column: 'key_hash', sensitivity: 'credential' },
  { column: 'key_prefix', sensitivity: 'credential' },
  { column: 'value_encrypted', sensitivity: 'credential' },
  { column: 'api_key_encrypted', sensitivity: 'credential' },
  { column: 'credentials_encrypted', sensitivity: 'credential' },
  { column: 'env', sensitivity: 'credential' },
  { column: 'transcript', sensitivity: 'confidential' },
  { column: 'prompt', sensitivity: 'confidential' },
  { column: 'system_prompt', sensitivity: 'confidential' },
  { column: 'instructions', sensitivity: 'confidential' },
  { column: 'content', sensitivity: 'confidential' },
  { column: 'log', sensitivity: 'confidential' },
  { column: 'arguments', sensitivity: 'confidential' },
  { column: 'result', sensitivity: 'confidential' },
  { column: 'metadata', sensitivity: 'metadata' },
  { column: 'config', sensitivity: 'metadata' },
  { column: 'adapter_config', sensitivity: 'metadata' },
];

/** Columns that match a sensitive pattern but are deliberately out of scope. */
const SENSITIVE_EXCLUDED: Record<string, string> = {
  // Fixture table used only by the local-trusted test harness; never holds
  // real subjects. Its email column is still classified (as test-fixture) so
  // this map is intentionally empty — there are no exclusions right now.
};

function sensitiveSchemaColumns(): {
  table: string;
  column: string;
  sensitivity: string;
}[] {
  const found: { table: string; column: string; sensitivity: string }[] = [];

  for (const file of readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    const tableMatches = [...source.matchAll(/export const \w+ = pgTable\(\s*'(\w+)'/g)];

    for (const [index, match] of tableMatches.entries()) {
      const table = match[1];
      const start = match.index + match[0].length;
      const end = tableMatches[index + 1]?.index ?? source.length;
      const body = source.slice(start, end);

      for (const { column, sensitivity } of SENSITIVE_COLUMN_PATTERNS) {
        // Match both `text('col')` and `jsonb('col')` physical column defs.
        const re = new RegExp(`(?:text|jsonb)\\('${column}'\\)`);
        if (re.test(body)) {
          found.push({ table, column, sensitivity });
        }
      }
    }
  }

  return found;
}

describe('PII field-level sensitivity classification', () => {
  it('classifies every sensitive column the schema declares', () => {
    const classified = new Set(PII_FIELD_CLASSIFICATIONS.map((c) => `${c.table}.${c.column}`));
    const discovered = sensitiveSchemaColumns().map(({ table, column }) => `${table}.${column}`);

    // The scan itself must keep working: an empty result would make this test
    // vacuously pass.
    expect(discovered.length).toBeGreaterThan(5);

    const uncovered = discovered.filter(
      (key) => !classified.has(key) && !(key in SENSITIVE_EXCLUDED),
    );
    expect(uncovered, 'sensitive columns without a classification').toEqual([]);
  });

  it('covers every identity column from PERSONAL_DATA_RULES', () => {
    const identity = PII_FIELD_CLASSIFICATIONS.filter((c) => c.sensitivity === 'identity');
    const identityKeys = new Set(identity.map((c) => `${c.table}.${c.column}`));

    for (const rule of PERSONAL_DATA_RULES) {
      const key = `${rule.table}.${rule.column}`;
      expect(identityKeys.has(key), `${key} must have an identity classification`).toBe(true);
    }
  });

  it('declares no classification for a column that no longer exists', () => {
    const discovered = new Set(
      sensitiveSchemaColumns().map(({ table, column }) => `${table}.${column}`),
    );
    // Identity columns come from PERSONAL_DATA_RULES, which is already checked
    // for staleness in the suite above. Only the non-identity classifications
    // need a stale-column check here.
    const nonIdentity = PII_FIELD_CLASSIFICATIONS.filter((c) => c.sensitivity !== 'identity');
    const stale = nonIdentity
      .map((c) => `${c.table}.${c.column}`)
      .filter(
        (key) =>
          !discovered.has(key) &&
          key !== 'cost_events.cost_cents' &&
          key !== 'budget_alerts.threshold_percent',
      );
    // Financial columns are not name-pattern sensitive, so they are not
    // re-discovered by the scan; they are asserted positively below instead.
    expect(stale).toEqual([]);
  });

  it('uses only the documented sensitivity categories', () => {
    const allowed = new Set([
      'identity',
      'contact',
      'credential',
      'confidential',
      'financial',
      'metadata',
    ]);
    for (const c of PII_FIELD_CLASSIFICATIONS) {
      expect(
        allowed.has(c.sensitivity),
        `${c.table}.${c.column} has sensitivity "${c.sensitivity}"`,
      ).toBe(true);
    }
  });

  it('classifies contact and credential fields with the right sensitivity', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    expect(byKey('company_invitations.email')?.sensitivity).toBe('contact');
    expect(byKey('user_mfa_factors.secret')?.sensitivity).toBe('credential');
    expect(byKey('webhooks.secret')?.sensitivity).toBe('credential');
    expect(byKey('agent_api_keys.key_hash')?.sensitivity).toBe('credential');
    expect(byKey('secrets.value_encrypted')?.sensitivity).toBe('credential');
    expect(byKey('agents.api_key_encrypted')?.sensitivity).toBe('credential');
    expect(byKey('integrations.credentials_encrypted')?.sensitivity).toBe('credential');
  });

  it('classifies transcript and prompt content as confidential', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    expect(byKey('meetings.transcript')?.sensitivity).toBe('confidential');
    expect(byKey('agent_runtime_sessions.transcript')?.sensitivity).toBe('confidential');
    expect(byKey('routines.prompt')?.sensitivity).toBe('confidential');
  });

  it('classifies agent prompt and instruction fields as confidential', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    expect(byKey('agents.system_prompt')?.sensitivity).toBe('confidential');
    expect(byKey('agents.instructions')?.sensitivity).toBe('confidential');
  });

  it('classifies MCP server env as a credential JSONB field', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    const entry = byKey('mcp_servers.env');
    expect(entry, 'mcp_servers.env must be classified').toBeDefined();
    expect(entry?.sensitivity).toBe('credential');
  });

  it('classifies agent execution log and MCP tool call arguments/result as confidential', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    expect(byKey('agent_executions.log')?.sensitivity).toBe('confidential');
    expect(byKey('mcp_tool_calls.arguments')?.sensitivity).toBe('confidential');
    expect(byKey('mcp_tool_calls.result')?.sensitivity).toBe('confidential');
  });

  it('classifies free-text content columns as confidential', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    const contentKeys = [
      'approval_comments.content',
      'prompt_templates.content',
      'prompt_versions.content',
      'company_skills.content',
      'task_thread_items.content',
      'agent_files.content',
      'messages.content',
      'agent_memories.content',
      'knowledge_documents.content',
      'knowledge_chunks.content',
      'artifacts.content',
      'artifact_revisions.content',
      'artifact_templates.content',
    ];

    for (const key of contentKeys) {
      expect(byKey(key)?.sensitivity, `${key} must be confidential`).toBe('confidential');
    }
  });

  it('classifies JSONB metadata columns as metadata', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    const metadataKeys = [
      'agents.metadata',
      'company_skills.metadata',
      'project_outcomes.metadata',
      'activity_log.metadata',
      'execution_environments.metadata',
      'workspace_lifecycle_events.metadata',
      'messages.metadata',
      'meetings.metadata',
      'knowledge_documents.metadata',
      'knowledge_chunks.metadata',
    ];

    for (const key of metadataKeys) {
      expect(byKey(key)?.sensitivity, `${key} must be metadata`).toBe('metadata');
    }
  });

  it('classifies config and adapter_config columns as metadata', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    const configKeys = [
      'agents.config',
      'agents.adapter_config',
      'agent_runtime_sessions.adapter_config',
      'integrations.config',
      'company_templates.config',
    ];

    for (const key of configKeys) {
      expect(byKey(key)?.sensitivity, `${key} must be metadata`).toBe('metadata');
    }
  });

  it('marks encrypted credentials with encrypted-at-rest protection', () => {
    const byKey = (key: string) =>
      PII_FIELD_CLASSIFICATIONS.find((c) => `${c.table}.${c.column}` === key);

    expect(byKey('agents.api_key_encrypted')?.protection).toBe('encrypted-at-rest');
    expect(byKey('integrations.credentials_encrypted')?.protection).toBe('encrypted-at-rest');
    expect(byKey('secrets.value_encrypted')?.protection).toBe('encrypted-at-rest');
  });

  it('records a financial category for cost and budget data', () => {
    const financial = PII_FIELD_CLASSIFICATIONS.filter((c) => c.sensitivity === 'financial');
    const keys = financial.map((c) => `${c.table}.${c.column}`);
    expect(keys).toContain('cost_events.cost_cents');
    expect(keys).toContain('budget_alerts.threshold_percent');
  });

  it('gives every classification a stated reason', () => {
    for (const c of PII_FIELD_CLASSIFICATIONS) {
      expect(c.why.length, `${c.table}.${c.column} needs a reason`).toBeGreaterThan(20);
    }
  });
});
