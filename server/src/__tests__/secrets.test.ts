import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, createTestApp } from '../test-utils.js';

describe('Secrets API', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: ReturnType<typeof createTestDb>;
  let companyId: string;

  beforeEach(async () => {
    db = createTestDb();
    app = createTestApp(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: 'Secrets Test Corp' });
    companyId = res.body.data.id;
  });

  const secretsUrl = () => `/api/companies/${companyId}/secrets`;
  const secretUrl = (id: string) => `${secretsUrl()}/${id}`;

  // ---------------------------------------------------------------------------
  // POST - create secret
  // ---------------------------------------------------------------------------

  describe('POST /api/companies/:companyId/secrets', () => {
    it('should create a secret and return it without the encrypted value', async () => {
      const res = await request(app)
        .post(secretsUrl())
        .send({
          name: 'OPENAI_API_KEY',
          value: 'sk-test-12345',
          provider: 'openai',
          description: 'OpenAI API key for agents',
          createdBy: 'admin',
        })
        .expect(201);

      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe('OPENAI_API_KEY');
      expect(res.body.data.provider).toBe('openai');
      expect(res.body.data.description).toBe('OpenAI API key for agents');
      expect(res.body.data.createdBy).toBe('admin');
      expect(res.body.data.companyId).toBe(companyId);
      expect(res.body.data.createdAt).toBeDefined();
      expect(res.body.data.updatedAt).toBeDefined();

      // The encrypted value should NOT be returned
      expect(res.body.data.value).toBeUndefined();
      expect(res.body.data.valueEncrypted).toBeUndefined();
    });

    it('should create a secret with default provider', async () => {
      const res = await request(app)
        .post(secretsUrl())
        .send({ name: 'MY_SECRET', value: 'secret-value' })
        .expect(201);

      expect(res.body.data.provider).toBe('local');
    });

    it('should store the value encrypted in the database', async () => {
      await request(app)
        .post(secretsUrl())
        .send({ name: 'ENCRYPTED_TEST', value: 'plaintext-value' })
        .expect(201);

      // Directly query the database to verify encryption
      const rows = db.drizzle
        .select()
        .from(db.schema.secrets)
        .all();

      expect(rows).toHaveLength(1);
      const row = rows[0] as any;
      expect(row.valueEncrypted).toBeDefined();
      // The stored value should NOT be the plaintext
      expect(row.valueEncrypted).not.toBe('plaintext-value');
      // AES-256-GCM format: iv:authTag:ciphertext (all base64)
      expect(row.valueEncrypted.split(':')).toHaveLength(3);
    });

    it('should reject missing name', async () => {
      await request(app)
        .post(secretsUrl())
        .send({ value: 'some-value' })
        .expect(400);
    });

    it('should reject missing value', async () => {
      await request(app)
        .post(secretsUrl())
        .send({ name: 'NO_VALUE' })
        .expect(400);
    });

    it('should reject empty name', async () => {
      await request(app)
        .post(secretsUrl())
        .send({ name: '', value: 'val' })
        .expect(400);
    });

    it('should reject empty value', async () => {
      await request(app)
        .post(secretsUrl())
        .send({ name: 'KEY', value: '' })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // GET - list secrets
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/secrets', () => {
    it('should return empty array when no secrets exist', async () => {
      const res = await request(app).get(secretsUrl()).expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('should list all secrets without exposing values', async () => {
      await request(app)
        .post(secretsUrl())
        .send({ name: 'KEY_A', value: 'val-a' });
      await request(app)
        .post(secretsUrl())
        .send({ name: 'KEY_B', value: 'val-b' });

      const res = await request(app).get(secretsUrl()).expect(200);

      expect(res.body.data).toHaveLength(2);

      for (const secret of res.body.data) {
        expect(secret.name).toBeDefined();
        expect(secret.id).toBeDefined();
        expect(secret.companyId).toBe(companyId);
        // Value fields should never appear in the list
        expect(secret.value).toBeUndefined();
        expect(secret.valueEncrypted).toBeUndefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH - update secret
  // ---------------------------------------------------------------------------

  describe('PATCH /api/companies/:companyId/secrets/:id', () => {
    it('should update a secret value', async () => {
      const created = await request(app)
        .post(secretsUrl())
        .send({ name: 'UPDATE_ME', value: 'old-value' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(secretUrl(id))
        .send({ value: 'new-value' })
        .expect(200);

      expect(res.body.data.id).toBe(id);
      expect(res.body.data.name).toBe('UPDATE_ME');
      // Value should not be returned
      expect(res.body.data.value).toBeUndefined();
      expect(res.body.data.valueEncrypted).toBeUndefined();
    });

    it('should update secret description', async () => {
      const created = await request(app)
        .post(secretsUrl())
        .send({ name: 'DESC_UPDATE', value: 'val', description: 'old desc' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(secretUrl(id))
        .send({ description: 'new desc' })
        .expect(200);

      expect(res.body.data.description).toBe('new desc');
    });

    it('should 404 for non-existent secret', async () => {
      await request(app)
        .patch(secretUrl('00000000-0000-0000-0000-000000000000'))
        .send({ value: 'new' })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE - delete secret
  // ---------------------------------------------------------------------------

  describe('DELETE /api/companies/:companyId/secrets/:id', () => {
    it('should delete a secret', async () => {
      const created = await request(app)
        .post(secretsUrl())
        .send({ name: 'DELETE_ME', value: 'bye' });
      const id = created.body.data.id;

      const res = await request(app).delete(secretUrl(id)).expect(200);

      expect(res.body.data.id).toBe(id);
      expect(res.body.data.deleted).toBe(true);
    });

    it('should no longer appear in the list after deletion', async () => {
      const created = await request(app)
        .post(secretsUrl())
        .send({ name: 'GONE', value: 'poof' });
      const id = created.body.data.id;

      await request(app).delete(secretUrl(id)).expect(200);

      const listRes = await request(app).get(secretsUrl()).expect(200);
      expect(listRes.body.data).toHaveLength(0);
    });

    it('should 404 for non-existent secret', async () => {
      await request(app)
        .delete(secretUrl('00000000-0000-0000-0000-000000000000'))
        .expect(404);
    });

    it('should 404 when deleting an already deleted secret', async () => {
      const created = await request(app)
        .post(secretsUrl())
        .send({ name: 'DOUBLE_DELETE', value: 'twice' });
      const id = created.body.data.id;

      await request(app).delete(secretUrl(id)).expect(200);
      await request(app).delete(secretUrl(id)).expect(404);
    });
  });
});
