import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSONAL_DATA_RULES } from '../services/privacy.js';

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
