import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { DbInstance } from '../types.js';
import { activityRecordFromEvent } from '../routes/activity.js';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Activity API', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Activity Test Corp' })
      .expect(201);
    companyId = company.body.data.id;
  });

  it('classifies project events with useful durable context', () => {
    const createdAt = '2026-07-31T18:00:00.000Z';
    const record = activityRecordFromEvent({
      type: 'project.updated',
      companyId,
      payload: {
        project: { id: 'project-1', name: 'Runtime reliability' },
        changes: ['name', 'status'],
      },
      timestamp: createdAt,
    });

    expect(record).toEqual(expect.objectContaining({
      companyId,
      actorType: 'system',
      actorId: 'system',
      action: 'project.updated',
      entityType: 'project',
      entityId: 'project-1',
      description: 'Project updated: Runtime reliability',
      createdAt: new Date(createdAt),
    }));
  });

  it('returns persisted project and authoritative task history with bounded pagination', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const otherProjectId = '22222222-2222-4222-8222-222222222222';
    await db.drizzle.insert(db.schema.activityLog).values([
      {
        companyId,
        actorType: 'system',
        actorId: 'system',
        action: 'project.created',
        entityType: 'unknown',
        entityId: companyId,
        description: 'Legacy project event',
        metadata: { project: { id: projectId, name: 'Lifecycle' } },
        createdAt: new Date('2026-07-31T18:00:00.000Z'),
      },
      {
        companyId,
        actorType: 'system',
        actorId: 'system',
        action: 'task.created',
        entityType: 'task',
        entityId: 'task-1',
        description: 'Task created: Verify persistence',
        metadata: { task: { id: 'task-1', projectId, title: 'Verify persistence' } },
        createdAt: new Date('2026-07-31T18:02:00.000Z'),
      },
      {
        companyId,
        actorType: 'system',
        actorId: 'system',
        action: 'project.updated',
        entityType: 'project',
        entityId: projectId,
        description: 'Project updated: Lifecycle',
        metadata: { project: { id: projectId }, changes: ['status'] },
        createdAt: new Date('2026-07-31T18:03:00.000Z'),
      },
      {
        companyId,
        actorType: 'system',
        actorId: 'system',
        action: 'project.updated',
        entityType: 'project',
        entityId: otherProjectId,
        description: 'Other project',
        metadata: { project: { id: otherProjectId } },
        createdAt: new Date('2026-07-31T18:04:00.000Z'),
      },
      {
        companyId,
        actorType: 'system',
        actorId: 'system',
        action: 'goal.updated',
        entityType: 'goal',
        entityId: 'goal-1',
        description: 'Unassociated goal',
        metadata: { goal: { id: 'goal-1' } },
        createdAt: new Date('2026-07-31T18:05:00.000Z'),
      },
    ]);

    const firstPage = await request(app)
      .get(`/api/companies/${companyId}/activity`)
      .query({ projectId, limit: 2, offset: 0 })
      .expect(200);

    expect(firstPage.body.meta).toEqual({ total: 3, limit: 2, offset: 0 });
    expect(firstPage.body.data.map((entry: { action: string }) => entry.action))
      .toEqual(['project.updated', 'task.created']);

    const reloadedApp = createTestApp(db);
    const secondPage = await request(reloadedApp)
      .get(`/api/companies/${companyId}/activity`)
      .query({ projectId, limit: 2, offset: 2 })
      .expect(200);
    expect(secondPage.body.data).toEqual([
      expect.objectContaining({ action: 'project.created', description: 'Legacy project event' }),
    ]);
  });

  it('rejects invalid project filters and out-of-bounds limits', async () => {
    await request(app)
      .get(`/api/companies/${companyId}/activity`)
      .query({ projectId: 'not-a-project' })
      .expect(400);
    await request(app)
      .get(`/api/companies/${companyId}/activity`)
      .query({ limit: 201 })
      .expect(400);
  });
});
