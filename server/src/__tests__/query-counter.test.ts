import { describe, expect, it } from 'vitest';
import { createTestDb, QueryCounter } from '../test-utils.js';

describe('query counter', () => {
  it('counts queries after migrations and fails an over-budget assertion', async () => {
    const queries = new QueryCounter();
    const db = await createTestDb(queries);
    queries.reset();

    await db.drizzle.select().from(db.schema.companies);

    queries.assertAtMost(1);
    expect(() => queries.assertAtMost(0)).toThrow('Expected at most 0 database queries');
  });
});
