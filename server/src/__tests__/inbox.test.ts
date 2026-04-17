import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Inbox unified feed', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: ReturnType<typeof createTestDb>;
  let companyId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = createTestApp(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: 'Inbox Corp' });
    companyId = res.body.data.id;
  });

  const url = (query = '') =>
    `/api/companies/${companyId}/inbox${query}`;

  it('returns an empty feed when nothing is pending', async () => {
    const res = await request(app).get(url()).expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toEqual({
      pendingApprovals: 0,
      pendingCollaborations: 0,
      total: 0,
    });
  });

  it('surfaces pending approvals with kind "approval" and correct link', async () => {
    const approval = await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({ title: 'Raise marketing budget', priority: 'high' })
      .expect(201);

    const res = await request(app).get(url()).expect(200);
    expect(res.body.meta.pendingApprovals).toBe(1);
    expect(res.body.data).toHaveLength(1);

    const [item] = res.body.data;
    expect(item.kind).toBe('approval');
    expect(item.title).toBe('Raise marketing budget');
    expect(item.priority).toBe('high');
    expect(item.status).toBe('pending');
    expect(item.id).toBe(`approval:${approval.body.data.id}`);
    expect(item.link).toContain(`/approvals?focus=${approval.body.data.id}`);
  });

  it('hides resolved approvals from the feed', async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({ title: 'Pending' });
    const other = await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({ title: 'Resolve me' });

    await request(app)
      .post(`/api/companies/${companyId}/approvals/${other.body.data.id}/decide`)
      .send({ decision: 'approved' })
      .expect(200);

    const res = await request(app).get(url()).expect(200);
    const approvalItems = res.body.data.filter(
      (i: { kind: string }) => i.kind === 'approval',
    );
    expect(approvalItems).toHaveLength(1);
    expect(approvalItems[0].id).toBe(`approval:${created.body.data.id}`);
  });

  it('sorts merged items by createdAt desc (newest first)', async () => {
    const first = await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({ title: 'First' });
    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({ title: 'Second' });

    const res = await request(app).get(url()).expect(200);
    expect(res.body.data[0].id).toBe(`approval:${second.body.data.id}`);
    expect(res.body.data[1].id).toBe(`approval:${first.body.data.id}`);
  });

  it('respects the limit query param', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post(`/api/companies/${companyId}/approvals`)
        .send({ title: `A${i}` });
    }

    const res = await request(app).get(url('?limit=2')).expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.pendingApprovals).toBe(5);
  });
});
