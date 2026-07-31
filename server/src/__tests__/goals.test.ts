import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Goals API', () => {
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let ownerAgentId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Goal Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const owner = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Goal Owner', role: 'ceo' })
      .expect(201);
    ownerAgentId = owner.body.data.id;
  });

  it('creates nested goals and persists operator updates', async () => {
    const root = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({
        title: 'Ship the operator workflow',
        description: 'Make goal management durable.',
        level: 'company',
        status: 'active',
        ownerAgentId,
        progress: 20,
      })
      .expect(201);

    const child = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({
        title: 'Verify progress updates',
        level: 'team',
        status: 'draft',
        parentId: root.body.data.id,
        ownerAgentId,
        progress: 0,
      })
      .expect(201);

    const updated = await request(app)
      .patch(`/api/companies/${companyId}/goals/${child.body.data.id}`)
      .send({ title: 'Verify durable progress updates', status: 'active', progress: 65 })
      .expect(200);

    expect(updated.body.data).toEqual(expect.objectContaining({
      parentId: root.body.data.id,
      ownerAgentId,
      status: 'active',
      progress: 65,
    }));

    const list = await request(app)
      .get(`/api/companies/${companyId}/goals`)
      .expect(200);
    expect(list.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: root.body.data.id, parentId: null }),
      expect.objectContaining({ id: child.body.data.id, progress: 65 }),
    ]));
  });

  it('rejects parents outside the company', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Invalid parent', parentId: randomUUID() })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe('Choose a parent goal from this company.');
      });
  });

  it('rejects self-parent and descendant cycles', async () => {
    const root = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Root goal' })
      .expect(201);
    const child = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Child goal', level: 'department', parentId: root.body.data.id })
      .expect(201);

    await request(app)
      .patch(`/api/companies/${companyId}/goals/${root.body.data.id}`)
      .send({ parentId: root.body.data.id })
      .expect(400);

    await request(app)
      .patch(`/api/companies/${companyId}/goals/${root.body.data.id}`)
      .send({ parentId: child.body.data.id })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('descendants');
      });
  });

  it('rejects owners outside the company', async () => {
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Goal Corp' })
      .expect(201);
    const otherOwner = await request(app)
      .post(`/api/companies/${otherCompany.body.data.id}/agents`)
      .send({ name: 'Other Owner', role: 'ceo' })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Wrong owner', ownerAgentId: otherOwner.body.data.id })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe('Choose an owner from this company.');
      });
  });

  it('rejects blank titles on create and update', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: '   ' })
      .expect(400);

    const goal = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Valid goal' })
      .expect(201);

    await request(app)
      .patch(`/api/companies/${companyId}/goals/${goal.body.data.id}`)
      .send({ title: '  ' })
      .expect(400);
  });

  it('enforces levels from parent to child while allowing skipped levels', async () => {
    const root = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Company goal', level: 'company' })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Invalid peer', level: 'company', parentId: root.body.data.id })
      .expect(400);

    const team = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Skipped-level team goal', level: 'team', parentId: root.body.data.id })
      .expect(201);

    const individual = await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Individual goal', level: 'individual', parentId: team.body.data.id })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/goals`)
      .send({ title: 'Too deep', level: 'individual', parentId: individual.body.data.id })
      .expect(400);

    await request(app)
      .patch(`/api/companies/${companyId}/goals/${team.body.data.id}`)
      .send({ level: 'individual' })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe('A parent goal must use a level above each child.');
      });
  });
});
