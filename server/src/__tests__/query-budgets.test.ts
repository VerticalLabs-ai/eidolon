import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  assertQueryCountIndependentOfRows,
  createTestApp,
  createTestDb,
  QueryCounter,
} from '../test-utils.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// N+1 regression guards for the list-returning read flows.
//
// Each guard measures the same request twice with a different number of rows in
// the returned collection and requires the query count to be identical. A
// per-row query — the shape EID-154 had to fix by hand — makes the second
// measurement larger and fails the test.
//
// These guards deliberately do not assert an absolute number: an absolute
// budget has to be widened every time an unrelated query moves, and a budget
// that gets widened stops protecting anything.
// ---------------------------------------------------------------------------

describe('database query budgets', () => {
  // `createTestDb` binds a query logger only on the first call in a file and
  // returns the cached instance afterwards, so the counter has to outlive
  // `beforeEach` or later tests would silently measure nothing.
  const queries = new QueryCounter();
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb(queries);
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ query budget', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
  });

  it('lists tasks without a per-task query', async () => {
    const seedTasks = async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await request(app)
          .post(`/api/companies/${companyId}/tasks`)
          .send({ title: `Task ${index}` })
          .expect(201);
      }
    };

    await seedTasks(2);

    await assertQueryCountIndependentOfRows({
      queries,
      label: 'GET /api/companies/:companyId/tasks',
      read: async () => {
        const res = await request(app).get(`/api/companies/${companyId}/tasks`).expect(200);
        expect(res.body.data.length).toBeGreaterThan(0);
      },
      seed: () => seedTasks(6),
    });
  });

  it('lists artifacts without a per-artifact access query', async () => {
    const seedArtifacts = async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await request(app)
          .post(`/api/companies/${companyId}/artifacts`)
          .send({
            title: `Doc ${index}`,
            type: 'document',
            content: { format: 'markdown', body: `# Doc ${index}` },
          })
          .expect(201);
      }
    };

    await seedArtifacts(2);

    await assertQueryCountIndependentOfRows({
      queries,
      label: 'GET /api/companies/:companyId/artifacts',
      read: async () => {
        const res = await request(app).get(`/api/companies/${companyId}/artifacts`).expect(200);
        expect(res.body.data.length).toBeGreaterThan(0);
      },
      seed: () => seedArtifacts(6),
    });
  });

  it('builds the unified inbox feed without a per-item query', async () => {
    const seedApprovals = async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await request(app)
          .post(`/api/companies/${companyId}/approvals`)
          .send({ title: `Approval ${index}`, priority: 'medium' })
          .expect(201);
      }
    };

    await seedApprovals(2);

    await assertQueryCountIndependentOfRows({
      queries,
      label: 'GET /api/companies/:companyId/inbox',
      read: async () => {
        const res = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
        expect(res.body.data.length).toBeGreaterThan(0);
      },
      seed: () => seedApprovals(6),
    });
  });

  it('composes the project home summary without a per-task query', async () => {
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Budget project' })
      .expect(201);
    const projectId = project.body.data.id;

    const seedProjectTasks = async (count: number) => {
      for (let index = 0; index < count; index += 1) {
        await request(app)
          .post(`/api/companies/${companyId}/tasks`)
          .send({ title: `Project task ${index}`, projectId })
          .expect(201);
      }
    };

    await seedProjectTasks(2);

    await assertQueryCountIndependentOfRows({
      queries,
      label: 'GET /api/companies/:companyId/projects/:projectId/home',
      read: async () => {
        const res = await request(app)
          .get(`/api/companies/${companyId}/projects/${projectId}/home`)
          .expect(200);
        expect(res.body.data).toBeTruthy();
      },
      seed: () => seedProjectTasks(6),
    });
  });

  it('fails loudly when a read issues one query per row', async () => {
    const rows: number[] = [1, 2];

    await expect(
      assertQueryCountIndependentOfRows({
        queries,
        label: 'synthetic per-row read',
        read: async () => {
          for (const _row of rows) {
            await db.drizzle.select().from(db.schema.companies);
          }
        },
        seed: async () => {
          rows.push(3, 4);
        },
      }),
    ).rejects.toThrow(/query count grew from 2 to 4/);
  });
});
