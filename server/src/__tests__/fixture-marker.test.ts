import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createTestDb, createTestApp } from '../test-utils.js';

/**
 * Fixture marker convention tests.
 *
 * Verifies that POST /api/companies with settings.testFixture=true stores
 * the marker as boolean true (not string), that the marker is queryable
 * via JSONB containment, that unmarked companies don't get the marker,
 * and that __mtest__ name prefixes are preserved.
 */
describe('Fixture marker convention', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  // VAL-MARK-001: Company creation stores the fixture marker
  it('POST /api/companies with settings.testFixture=true stores boolean true', async () => {
    const res = await request(app)
      .post('/api/companies')
      .send({
        name: '__mtest__ marker-test',
        settings: { testFixture: true },
      })
      .expect(201);

    expect(res.body.data).toBeDefined();
    expect(res.body.data.settings).toBeDefined();
    expect(res.body.data.settings.testFixture).toBe(true);
    // Ensure it's boolean true, not string "true"
    expect(typeof res.body.data.settings.testFixture).toBe('boolean');
  });

  // VAL-MARK-002: Fixture marker persists and is queryable via JSONB containment
  it('marker is queryable via settings @> \'{"testFixture": true}\'', async () => {
    // Create a marked fixture
    const fixtureRes = await request(app)
      .post('/api/companies')
      .send({
        name: '__mtest__ queryable-test',
        settings: { testFixture: true },
      })
      .expect(201);
    const fixtureId = fixtureRes.body.data.id;

    // Create an unmarked control company
    const controlRes = await request(app)
      .post('/api/companies')
      .send({ name: 'Control Company' })
      .expect(201);
    const controlId = controlRes.body.data.id;

    // Query using JSONB containment
    const rows = await db.drizzle
      .select()
      .from(db.schema.companies)
      .where(sql`${db.schema.companies.settings} @> '{"testFixture": true}'`);

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(fixtureId);
    expect(rows.map((r) => r.id)).not.toContain(controlId);
  });

  // VAL-MARK-003: Unmarked company creation does not set the fixture marker
  it('unmarked company does not have testFixture=true in settings', async () => {
    // Create without testFixture
    const res = await request(app)
      .post('/api/companies')
      .send({
        name: 'Regular Company',
        settings: { theme: 'dark' },
      })
      .expect(201);

    expect(res.body.data.settings).toBeDefined();
    expect(res.body.data.settings.testFixture).toBeUndefined();

    // Verify via JSONB containment query — should not be found
    const rows = await db.drizzle
      .select()
      .from(db.schema.companies)
      .where(sql`${db.schema.companies.settings} @> '{"testFixture": true}'`);

    expect(rows.length).toBe(0);

    // Also verify the company exists in a general query
    const allRows = await db.drizzle.select().from(db.schema.companies);
    expect(allRows.length).toBe(1);
    expect(allRows[0].id).toBe(res.body.data.id);
  });

  // VAL-MARK-004: Mtest-prefixed company name is preserved
  it('__mtest__ name prefix is preserved without normalization', async () => {
    const fullName = '__mtest__ descriptive-fixture-name';
    const res = await request(app)
      .post('/api/companies')
      .send({
        name: fullName,
        settings: { testFixture: true },
      })
      .expect(201);

    // Verify in the create response
    expect(res.body.data.name).toBe(fullName);

    // Verify via GET /api/companies/:id
    const getRes = await request(app)
      .get(`/api/companies/${res.body.data.id}`)
      .expect(200);

    expect(getRes.body.data.name).toBe(fullName);
    // The __mtest__ prefix is intact
    expect(getRes.body.data.name.startsWith('__mtest__')).toBe(true);

    // Verify via GET /api/companies (list)
    const listRes = await request(app).get('/api/companies').expect(200);
    const found = listRes.body.data.find((c: { name: string }) => c.name === fullName);
    expect(found).toBeDefined();
    expect(found.name).toBe(fullName);
  });

  // Extra: testFixture marker with string "true" is NOT matched by boolean query
  it('settings.testFixture as string "true" is not matched by boolean containment', async () => {
    // Create with string "true" instead of boolean true
    const res = await request(app)
      .post('/api/companies')
      .send({
        name: '__mtest__ string-marker',
        settings: { testFixture: 'true' },
      })
      .expect(201);

    // The API stores whatever was passed (Zod allows unknown values)
    expect(res.body.data.settings.testFixture).toBe('true');

    // JSONB containment for boolean true should NOT match string "true"
    const rows = await db.drizzle
      .select()
      .from(db.schema.companies)
      .where(sql`${db.schema.companies.settings} @> '{"testFixture": true}'`);

    expect(rows.length).toBe(0);
  });

  // Extra: company with empty settings does not match fixture query
  it('company with empty settings does not match fixture query', async () => {
    await request(app)
      .post('/api/companies')
      .send({ name: 'Empty Settings Corp' })
      .expect(201);

    const rows = await db.drizzle
      .select()
      .from(db.schema.companies)
      .where(sql`${db.schema.companies.settings} @> '{"testFixture": true}'`);

    expect(rows.length).toBe(0);
  });
});
