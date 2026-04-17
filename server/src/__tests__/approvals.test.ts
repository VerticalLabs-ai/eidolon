import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Approvals API', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: 'Approvals Test Corp' });
    companyId = res.body.data.id;
  });

  const url = (...parts: string[]) =>
    ['/api/companies', companyId, 'approvals', ...parts]
      .filter(Boolean)
      .join('/');

  describe('POST /approvals', () => {
    it('creates a pending approval with defaults', async () => {
      const res = await request(app)
        .post(url())
        .send({ title: 'Raise marketing budget to $5k/mo' })
        .expect(201);

      expect(res.body.data.title).toBe('Raise marketing budget to $5k/mo');
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.kind).toBe('custom');
      expect(res.body.data.priority).toBe('medium');
      expect(res.body.data.resolvedAt).toBeNull();
    });

    it('accepts a full payload with kind, priority, description, and structured payload', async () => {
      const res = await request(app)
        .post(url())
        .send({
          kind: 'budget_change',
          title: 'Expand CTO budget',
          description: 'Adding capacity for Q2',
          priority: 'high',
          payload: { agentId: 'abc', fromCents: 10000, toCents: 25000 },
        })
        .expect(201);

      expect(res.body.data.kind).toBe('budget_change');
      expect(res.body.data.priority).toBe('high');
      expect(res.body.data.payload).toMatchObject({
        agentId: 'abc',
        fromCents: 10000,
        toCents: 25000,
      });
    });

    it('rejects an empty title', async () => {
      await request(app).post(url()).send({ title: '' }).expect(400);
    });

    it('rejects an unknown kind', async () => {
      await request(app)
        .post(url())
        .send({ title: 'test', kind: 'launch_the_nukes' })
        .expect(400);
    });
  });

  describe('GET /approvals', () => {
    it('lists approvals for a company, newest first', async () => {
      await request(app).post(url()).send({ title: 'First' }).expect(201);
      await request(app).post(url()).send({ title: 'Second' }).expect(201);

      const res = await request(app).get(url()).expect(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].title).toBe('Second');
    });

    it('filters by status', async () => {
      const a = await request(app).post(url()).send({ title: 'a' });
      await request(app).post(url()).send({ title: 'b' });

      await request(app)
        .post(url(a.body.data.id, 'decide'))
        .send({ decision: 'approved' })
        .expect(200);

      const pending = await request(app)
        .get(`${url()}?status=pending`)
        .expect(200);
      expect(pending.body.data).toHaveLength(1);
      expect(pending.body.data[0].title).toBe('b');

      const approved = await request(app)
        .get(`${url()}?status=approved`)
        .expect(200);
      expect(approved.body.data).toHaveLength(1);
      expect(approved.body.data[0].title).toBe('a');
    });
  });

  describe('GET /approvals/:id', () => {
    it('returns the approval with its comments', async () => {
      const created = await request(app).post(url()).send({ title: 'Detail test' });
      const id = created.body.data.id;

      await request(app)
        .post(url(id, 'comments'))
        .send({ content: 'Looks reasonable' })
        .expect(201);

      const res = await request(app).get(url(id)).expect(200);
      expect(res.body.data.approval.title).toBe('Detail test');
      expect(res.body.data.comments).toHaveLength(1);
      expect(res.body.data.comments[0].content).toBe('Looks reasonable');
    });

    it('404s for an unknown approval', async () => {
      await request(app)
        .get(url('00000000-0000-0000-0000-000000000000'))
        .expect(404);
    });
  });

  describe('POST /approvals/:id/decide', () => {
    it('transitions pending to approved', async () => {
      const created = await request(app).post(url()).send({ title: 'x' });
      const id = created.body.data.id;

      const res = await request(app)
        .post(url(id, 'decide'))
        .send({ decision: 'approved', resolutionNote: 'ok' })
        .expect(200);

      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.resolutionNote).toBe('ok');
      expect(res.body.data.resolvedAt).not.toBeNull();
    });

    it('transitions pending to rejected', async () => {
      const created = await request(app).post(url()).send({ title: 'y' });
      const id = created.body.data.id;

      const res = await request(app)
        .post(url(id, 'decide'))
        .send({ decision: 'rejected' })
        .expect(200);

      expect(res.body.data.status).toBe('rejected');
    });

    it('409s when attempting to decide an already-resolved approval', async () => {
      const created = await request(app).post(url()).send({ title: 'z' });
      const id = created.body.data.id;
      await request(app)
        .post(url(id, 'decide'))
        .send({ decision: 'approved' })
        .expect(200);

      const res = await request(app)
        .post(url(id, 'decide'))
        .send({ decision: 'rejected' })
        .expect(409);
      expect(res.body.code).toBe('APPROVAL_NOT_PENDING');
    });

    it('rejects an invalid decision value', async () => {
      const created = await request(app).post(url()).send({ title: 'q' });
      await request(app)
        .post(url(created.body.data.id, 'decide'))
        .send({ decision: 'maybe' })
        .expect(400);
    });
  });

  describe('POST /approvals/:id/cancel', () => {
    it('cancels a pending approval', async () => {
      const created = await request(app).post(url()).send({ title: 'c' });
      const id = created.body.data.id;

      const res = await request(app)
        .post(url(id, 'cancel'))
        .send({ resolutionNote: 'no longer needed' })
        .expect(200);

      expect(res.body.data.status).toBe('cancelled');
      expect(res.body.data.resolutionNote).toBe('no longer needed');
    });

    it('409s when cancelling an already-resolved approval', async () => {
      const created = await request(app).post(url()).send({ title: 'c2' });
      const id = created.body.data.id;
      await request(app)
        .post(url(id, 'decide'))
        .send({ decision: 'approved' })
        .expect(200);

      await request(app).post(url(id, 'cancel')).send({}).expect(409);
    });
  });
});
