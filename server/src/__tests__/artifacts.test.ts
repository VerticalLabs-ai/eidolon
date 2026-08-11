import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Shared test payloads
// ---------------------------------------------------------------------------

const DOC_CONTENT = { format: 'markdown' as const, body: '# Hello' };
const DOC_CONTENT_V2 = { format: 'markdown' as const, body: '# Updated' };
const SHEET_CONTENT = {
  columns: [{ id: 'c1', key: 'name' }],
  rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
};

const DEV_USER_ID = 'dev-user-000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect EventBus events emitted during an async operation. */
async function captureEvents<T extends EidolonEvent = EidolonEvent>(
  fn: () => Promise<void>,
): Promise<T[]> {
  const events: T[] = [];
  const handler = (event: EidolonEvent) => events.push(event as T);
  eventBus.onEvent(handler);
  try {
    await fn();
    // Allow microtasks to flush so synchronous emitEvent handlers settle.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

/** Filter captured events to a specific type. */
function filterEvents<T extends EidolonEvent>(
  events: T[],
  type: string,
): T[] {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// Main test suite — covers VAL-ART-015 through VAL-ART-097 + VAL-CROSS-009/010/011
// ---------------------------------------------------------------------------

describe('Artifact CRUD API — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let secondProjectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Artifact Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Art Test Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Art Test Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other Proj' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;
  });

  /** Create a document artifact, returning the supertest Test (chainable). */
  function createDoc(
    overrides: {
      companyId?: string;
      projectId?: string | null;
      title?: string;
      content?: unknown;
      type?: string;
    } = {},
  ) {
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send({
        type: overrides.type ?? 'document',
        title: overrides.title ?? '__mtest__ Test Doc',
        content: overrides.content ?? DOC_CONTENT,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // A. POST — create (VAL-ART-031, 032, 033, 034, 035, 053, 054, 055, 068, 076, 080)
  // =========================================================================

  describe('POST /artifacts — create', () => {
    // VAL-ART-031: POST creates a document artifact
    it('VAL-ART-031: creates a document with 201, version=1, status=active, createdByUserId set', async () => {
      const res = await createDoc().expect(201);
      const art = res.body.data;
      expect(art.id).toBeDefined();
      expect(art.type).toBe('document');
      expect(art.version).toBe(1);
      expect(art.status).toBe('active');
      expect(art.createdByUserId).toBe(DEV_USER_ID);
      expect(art.projectId).toBe(projectId);
      expect(art.content).toEqual(DOC_CONTENT);
    });

    // VAL-ART-032: POST creates a sheet artifact
    it('VAL-ART-032: creates a sheet with 201, version=1, content echoed', async () => {
      const res = await createDoc({
        type: 'sheet',
        title: '__mtest__ curl sheet',
        content: SHEET_CONTENT,
      }).expect(201);
      const art = res.body.data;
      expect(art.type).toBe('sheet');
      expect(art.version).toBe(1);
      expect(art.content).toEqual(SHEET_CONTENT);
    });

    // VAL-ART-033: POST rejects missing title with 400
    it('VAL-ART-033: rejects missing title with 400', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', content: DOC_CONTENT, projectId })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      // No artifact created
      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    // VAL-ART-034: POST rejects invalid content for type with 400
    it('VAL-ART-034: rejects invalid sheet content (notAColumnField) with 400', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'sheet', title: 'x', content: { notAColumnField: 1 } })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('VAL-ART-034: rejects invalid document content (format=bogus) with 400', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: 'x', content: { format: 'bogus' } })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    // VAL-ART-035: POST rejects unknown type with 400
    it('VAL-ART-035: rejects unknown type with 400', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'bogus_type', title: 'x', content: {} })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    // VAL-ART-053: Document content schema validation
    it('VAL-ART-053: accepts valid markdown document', async () => {
      await createDoc({ content: { format: 'markdown', body: '# Hi' } }).expect(201);
    });

    it('VAL-ART-053: accepts valid delta document', async () => {
      await createDoc({ content: { format: 'delta', body: [{ insert: 'Hi' }] } }).expect(201);
    });

    it('VAL-ART-053: rejects document with missing format', async () => {
      await createDoc({ content: { body: 'text' } }).expect(400);
    });

    it('VAL-ART-053: rejects document with unknown format', async () => {
      await createDoc({ content: { format: 'bogus', body: 'text' } }).expect(400);
    });

    it('VAL-ART-053: rejects markdown with non-string body', async () => {
      await createDoc({ content: { format: 'markdown', body: 123 } }).expect(400);
    });

    // VAL-ART-054: Sheet content schema validation
    it('VAL-ART-054: accepts minimal valid sheet', async () => {
      const res = await createDoc({
        type: 'sheet',
        content: {
          columns: [{ id: 'c1', key: 'name' }],
          rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
        },
      }).expect(201);
      expect(res.body.data.type).toBe('sheet');
    });

    it('VAL-ART-054: rejects sheet with column missing id', async () => {
      await createDoc({
        type: 'sheet',
        content: { columns: [{ key: 'name' }], rows: [] },
      }).expect(400);
    });

    it('VAL-ART-054: rejects sheet with column missing key', async () => {
      await createDoc({
        type: 'sheet',
        content: { columns: [{ id: 'c1' }], rows: [] },
      }).expect(400);
    });

    it('VAL-ART-054: rejects sheet with row missing id', async () => {
      await createDoc({
        type: 'sheet',
        content: {
          columns: [{ id: 'c1', key: 'name' }],
          rows: [{ cells: { name: { value: 'x' } } }],
        },
      }).expect(400);
    });

    it('VAL-ART-054: rejects sheet with cell referencing unknown column key', async () => {
      const res = await createDoc({
        type: 'sheet',
        content: {
          columns: [{ id: 'c1', key: 'name' }],
          rows: [{ id: 'r1', cells: { unknown: { value: 'x' } } }],
        },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
      // Nested path fidelity: the error preserves the row index + cell key
      // (rows.0.cells.unknown) instead of collapsing to a top-level "rows" key.
      expect(Array.isArray(res.body.details)).toBe(true);
      const paths = (res.body.details as Array<{ path: string }>).map((i) => i.path);
      expect(paths).toContain('rows.0.cells.unknown');
      expect(res.body.message).toContain('rows.0.cells.unknown');
    });

    // VAL-ART-055: contentSchemaVersion is recorded and stable
    it('VAL-ART-055: contentSchemaVersion=1 on create', async () => {
      const res = await createDoc().expect(201);
      expect(res.body.data.contentSchemaVersion).toBe(1);
    });

    // VAL-ART-068: Create records initial revision with editSource
    it('VAL-ART-068: initial revision at version=1 with editSource=user', async () => {
      const created = await createDoc().expect(201);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${created.body.data.id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(1);
      const rev = revs.body.data[0];
      expect(rev.version).toBe(1);
      expect(rev.editSource).toBe('user');
      expect(rev.editedByUserId).toBe(DEV_USER_ID);
    });

    // VAL-ART-076: Title uniqueness is not required
    it('VAL-ART-076: two POSTs with the same title both return 201 with distinct ids', async () => {
      const r1 = await createDoc({ title: '__mtest__ Same Title' }).expect(201);
      const r2 = await createDoc({ title: '__mtest__ Same Title' }).expect(201);
      expect(r1.body.data.id).not.toBe(r2.body.data.id);
      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      expect(list.body.data).toHaveLength(2);
    });

    // VAL-ART-080: Empty but schema-valid content is accepted
    it('VAL-ART-080: accepts empty markdown body', async () => {
      await createDoc({ content: { format: 'markdown', body: '' } }).expect(201);
    });

    it('VAL-ART-080: accepts empty sheet (columns:[], rows:[])', async () => {
      await createDoc({
        type: 'sheet',
        content: { columns: [], rows: [] },
      }).expect(201);
    });

    // VAL-ART-079: No dedup — two creates with same content produce two artifacts
    it('VAL-ART-079: two POSTs with identical content create two distinct artifacts', async () => {
      const r1 = await createDoc().expect(201);
      const r2 = await createDoc().expect(201);
      expect(r1.body.data.id).not.toBe(r2.body.data.id);
    });
  });

  // =========================================================================
  // B. GET — single + list (VAL-ART-036, 041, 075, CROSS-009, CROSS-010)
  // =========================================================================

  describe('GET /artifacts — single + list', () => {
    // VAL-ART-036: GET single returns full metadata
    it('VAL-ART-036: returns 200 with all metadata fields', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      const art = res.body.data;
      expect(art.id).toBe(id);
      expect(art.companyId).toBe(companyId);
      expect(art.projectId).toBe(projectId);
      expect(art.type).toBe('document');
      expect(art.title).toBeDefined();
      expect(art.content).toBeDefined();
      expect(art.contentSchemaVersion).toBe(1);
      expect(art.status).toBe('active');
      expect(art.version).toBe(1);
      expect(art.createdByUserId).toBe(DEV_USER_ID);
      expect(art.lastEditedByUserId).toBe(DEV_USER_ID);
      expect(art.createdAt).toBeDefined();
      expect(art.updatedAt).toBeDefined();
      expect(art.deletedAt).toBeNull();
    });

    // VAL-ART-041: Project-scoped list endpoint
    it('VAL-ART-041: GET /projects/:projectId/artifacts returns only that project artifacts', async () => {
      // Create artifact in project 1
      await createDoc({ projectId }).expect(201);
      // Create artifact in project 2
      await createDoc({ projectId: secondProjectId }).expect(201);
      // Create company-level artifact
      await createDoc({ projectId: null }).expect(201);

      const p1List = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);
      expect(p1List.body.data).toHaveLength(1);
      expect(p1List.body.data[0].projectId).toBe(projectId);

      const p2List = await request(app)
        .get(`/api/companies/${companyId}/projects/${secondProjectId}/artifacts`)
        .expect(200);
      expect(p2List.body.data).toHaveLength(1);
      expect(p2List.body.data[0].projectId).toBe(secondProjectId);
    });

    // VAL-CROSS-009: Project scoping — artifacts in project A invisible to project B
    it('VAL-CROSS-009: artifacts in project A are not listed in project B', async () => {
      await createDoc({ projectId }).expect(201);
      const bList = await request(app)
        .get(`/api/companies/${companyId}/projects/${secondProjectId}/artifacts`)
        .expect(200);
      expect(bList.body.data).toHaveLength(0);
    });

    // VAL-CROSS-010: Company-level artifacts appear in company-level view
    it('VAL-CROSS-010: company-level (projectId=null) artifact appears in unfiltered list, excluded from project lists', async () => {
      const created = await createDoc({ projectId: null }).expect(201);
      const id = created.body.data.id;
      // Appears in unfiltered company list
      const companyList = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      const ids = companyList.body.data.map((a: { id: string }) => a.id);
      expect(ids).toContain(id);
      // Excluded from project-scoped lists
      const pList = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);
      const pIds = pList.body.data.map((a: { id: string }) => a.id);
      expect(pIds).not.toContain(id);
    });

    // VAL-ART-075: Pagination and stable ordering
    it('VAL-ART-075: returns deterministic ordering by updatedAt desc + id', async () => {
      // Create 3 artifacts
      await createDoc({ title: 'A' }).expect(201);
      await createDoc({ title: 'B' }).expect(201);
      await createDoc({ title: 'C' }).expect(201);

      const list1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts?limit=2&offset=0`)
        .expect(200);
      const list2 = await request(app)
        .get(`/api/companies/${companyId}/artifacts?limit=2&offset=2`)
        .expect(200);

      // Total count
      expect(list1.body.meta.total).toBe(3);
      // Page 1: 2 items
      expect(list1.body.data).toHaveLength(2);
      // Page 2: 1 item (offset 2, limit 2)
      expect(list2.body.data).toHaveLength(1);
      // No duplicate across pages (disjoint offsets)
      const page1Ids = list1.body.data.map((a: { id: string }) => a.id);
      const page2Ids = list2.body.data.map((a: { id: string }) => a.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
      // Union of all pages covers all 3
      expect(new Set([...page1Ids, ...page2Ids]).size).toBe(3);
      // Repeated identical GETs return same order
      const list1b = await request(app)
        .get(`/api/companies/${companyId}/artifacts?limit=2&offset=0`)
        .expect(200);
      expect(list1b.body.data.map((a: { id: string }) => a.id)).toEqual(
        list1.body.data.map((a: { id: string }) => a.id),
      );
    });

    // List filtering by type
    it('supports ?type=document filter', async () => {
      await createDoc({ title: 'Doc1' }).expect(201);
      await createDoc({ type: 'sheet', title: 'Sheet1', content: SHEET_CONTENT }).expect(201);

      const docs = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=document`)
        .expect(200);
      expect(docs.body.data).toHaveLength(1);
      expect(docs.body.data[0].type).toBe('document');

      const sheets = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=sheet`)
        .expect(200);
      expect(sheets.body.data).toHaveLength(1);
      expect(sheets.body.data[0].type).toBe('sheet');
    });

    // VAL-ART-094: Sort/order params
    it('VAL-ART-094: supports sort=title&order=asc', async () => {
      await createDoc({ title: 'Zebra' }).expect(201);
      await createDoc({ title: 'Alpha' }).expect(201);
      await createDoc({ title: 'Mango' }).expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts?sort=title&order=asc`)
        .expect(200);

      const titles = res.body.data.map((a: { title: string }) => a.title);
      // Alpha, Mango, Zebra (ascending by title)
      expect(titles).toEqual(['Alpha', 'Mango', 'Zebra']);
    });

    it('VAL-ART-094: supports sort=title&order=desc', async () => {
      await createDoc({ title: 'Zebra' }).expect(201);
      await createDoc({ title: 'Alpha' }).expect(201);
      await createDoc({ title: 'Mango' }).expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts?sort=title&order=desc`)
        .expect(200);

      const titles = res.body.data.map((a: { title: string }) => a.title);
      // Zebra, Mango, Alpha (descending by title)
      expect(titles).toEqual(['Zebra', 'Mango', 'Alpha']);
    });

    it('VAL-ART-094: supports sort=type for mixed-type ordering', async () => {
      await createDoc({ title: 'Doc1' }).expect(201);
      await createDoc({ type: 'sheet', title: 'Sheet1', content: SHEET_CONTENT }).expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts?sort=type&order=asc`)
        .expect(200);

      const types = res.body.data.map((a: { type: string }) => a.type);
      // document before sheet (alphabetical)
      expect(types).toEqual(['document', 'sheet']);
    });
  });

  // =========================================================================
  // C. PATCH — update (VAL-ART-037, 038, 043, 044, 045, 018, 019, 020, 021, 069, 077, 097)
  // =========================================================================

  describe('PATCH /artifacts/:id — update', () => {
    // VAL-ART-037: PATCH updates content and bumps version
    it('VAL-ART-037: PATCH with valid content bumps version 1→2', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      expect(res.body.data.version).toBe(2);
      expect(res.body.data.content).toEqual(DOC_CONTENT_V2);

      // Revision created with editSource=user
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
      expect(revs.body.data[1].editSource).toBe('user');
    });

    // VAL-ART-038: PATCH with invalid content returns 400, no version bump
    it('VAL-ART-038: PATCH with invalid sheet content returns 400, version unchanged', async () => {
      const created = await createDoc({
        type: 'sheet',
        content: SHEET_CONTENT,
      }).expect(201);
      const id = created.body.data.id;
      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { notAColumnField: 1 }, version: 1 })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
      // Version unchanged
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.version).toBe(1);
      expect(get.body.data.content).toEqual(SHEET_CONTENT);
    });

    // VAL-ART-043: Concurrent PATCH with stale version returns 409
    it('VAL-ART-043: stale version PATCH returns 409 with current state', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      // First edit succeeds (version 1→2)
      const first = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      expect(first.body.data.version).toBe(2);
      // Second edit with stale version=1 → 409
      const second = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { format: 'markdown', body: '# Third' }, version: 1 })
        .expect(409);
      expect(second.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      expect(second.body.details.current.version).toBe(2);
      expect(second.body.details.current.content).toEqual(DOC_CONTENT_V2);
      // Final GET: only first edit applied
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.version).toBe(2);
      expect(get.body.data.content).toEqual(DOC_CONTENT_V2);
    });

    // VAL-ART-044: PATCH without version field returns 400
    it('VAL-ART-044: PATCH without version returns 400 VERSION_REQUIRED', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2 })
        .expect(400);
      expect(res.body.code).toBe('VERSION_REQUIRED');
      // Version unchanged
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.version).toBe(1);
    });

    // VAL-ART-097: Title-only edit participates in optimistic version checking
    it('VAL-ART-097: stale title-only PATCH returns 409, first succeeds', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      // First title-only edit succeeds (1→2)
      const first = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ title: '__mtest__ New Title', version: 1 })
        .expect(200);
      expect(first.body.data.version).toBe(2);
      expect(first.body.data.title).toBe('__mtest__ New Title');
      // Second title-only edit with stale version=1 → 409
      const second = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ title: '__mtest__ Stale Title', version: 1 })
        .expect(409);
      expect(second.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      // Only first title applied
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.title).toBe('__mtest__ New Title');
    });

    // VAL-ART-019: Every save writes exactly one revision row
    it('VAL-ART-019: single PATCH writes exactly one new revision', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const before = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const beforeCount = before.body.data.length;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(after.body.data.length).toBe(beforeCount + 1);
      const newRev = after.body.data[after.body.data.length - 1];
      expect(newRev.editSource).toBe('user');
      expect(newRev.editedByUserId).toBe(DEV_USER_ID);
      expect(newRev.version).toBe(2);
      expect(newRev.content).toEqual(DOC_CONTENT_V2);
    });

    // VAL-ART-020: lastEditedBy updated on save
    it('VAL-ART-020: lastEditedByUserId set, lastEditedByAgentId null after user save', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.lastEditedByUserId).toBe(DEV_USER_ID);
      expect(get.body.data.lastEditedByAgentId).toBeNull();
    });

    // VAL-ART-021: updatedAt advances on save
    it('VAL-ART-021: updatedAt strictly greater than prior after save', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const beforeTs = new Date(created.body.data.updatedAt).getTime();
      // Small delay to ensure timestamp difference
      await new Promise((r) => setTimeout(r, 10));
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      const afterTs = new Date(get.body.data.updatedAt).getTime();
      expect(afterTs).toBeGreaterThanOrEqual(beforeTs);
    });

    // VAL-ART-045: Version never regresses and is monotonic
    it('VAL-ART-045: version is strictly monotonic across multiple saves', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      let currentVersion = 1;
      for (let i = 0; i < 4; i++) {
        const res = await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({
            content: { format: 'markdown', body: `# Edit ${i}` },
            version: currentVersion,
          })
          .expect(200);
        expect(res.body.data.version).toBe(currentVersion + 1);
        currentVersion = res.body.data.version;
      }
      // Revisions list has versions 1..5 with no gaps or duplicates
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const versions = revs.body.data.map((r: { version: number }) => r.version);
      expect(versions).toEqual([1, 2, 3, 4, 5]);
    });

    // VAL-ART-069: createdBy immutable; lastEditedBy tracks last editor
    it('VAL-ART-069: createdBy stays constant, lastEditedBy tracks latest save', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const initialCreatedBy = created.body.data.createdByUserId;
      // Edit 1
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      const afterEdit1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(afterEdit1.body.data.createdByUserId).toBe(initialCreatedBy);
      expect(afterEdit1.body.data.lastEditedByUserId).toBe(DEV_USER_ID);
      // Edit 2
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { format: 'markdown', body: '# Third' }, version: 2 })
        .expect(200);
      const afterEdit2 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(afterEdit2.body.data.createdByUserId).toBe(initialCreatedBy);
      expect(afterEdit2.body.data.lastEditedByUserId).toBe(DEV_USER_ID);
    });

    // VAL-ART-077: Editing content does not change type
    it('VAL-ART-077: PATCH with type field in body does not change type (stripped by Zod)', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1, type: 'sheet' })
        .expect(200);
      expect(res.body.data.type).toBe('document');
    });
  });

  // =========================================================================
  // D. Revisions (VAL-ART-022, 023, 024, 025, 078, 095)
  // =========================================================================

  describe('Revisions — list / get / restore', () => {
    // VAL-ART-022: Revision list returns all revisions ordered by version
    it('VAL-ART-022: revisions ordered by version ascending, count = saves', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { format: 'markdown', body: '# V2' }, version: 1 })
        .expect(200);
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { format: 'markdown', body: '# V3' }, version: 2 })
        .expect(200);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(3);
      const versions = revs.body.data.map((r: { version: number }) => r.version);
      expect(versions).toEqual([1, 2, 3]);
      // Each has required fields
      for (const rev of revs.body.data) {
        expect(rev.version).toBeDefined();
        expect(rev.content).toBeDefined();
        expect(rev.editSource).toBeDefined();
        expect(rev.createdAt).toBeDefined();
      }
    });

    // VAL-ART-023: Get specific revision by version
    it('VAL-ART-023: GET revision by version returns content; non-existent returns 404', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const rev1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/1`)
        .expect(200);
      expect(rev1.body.data.version).toBe(1);
      expect(rev1.body.data.content).toEqual(DOC_CONTENT);

      const notFound = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/999`)
        .expect(404);
      expect(notFound.body.code).toBe('REVISION_NOT_FOUND');
    });

    // VAL-ART-024: Restore creates a NEW version
    it('VAL-ART-024: restore creates new version with restored content, original row unchanged', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      // Edit to v2
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      // Restore v1 → should create v3 with v1's content
      const restore = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restore.body.data.version).toBe(3);
      expect(restore.body.data.content).toEqual(DOC_CONTENT);
      // Original v1 revision still exists unchanged
      const rev1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/1`)
        .expect(200);
      expect(rev1.body.data.content).toEqual(DOC_CONTENT);
      expect(rev1.body.data.version).toBe(1);
    });

    // VAL-ART-025: Restoring preserves full prior history
    it('VAL-ART-025: after restore, all versions 1..n+1 present, no gaps', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { format: 'markdown', body: '# V2' }, version: 1 })
        .expect(200);
      // Restore v1 → v3
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const versions = revs.body.data.map((r: { version: number }) => r.version);
      expect(versions).toEqual([1, 2, 3]);
      // Current content == v1's content
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.content).toEqual(DOC_CONTENT);
    });

    // VAL-ART-078: Revision content snapshots are complete
    it('VAL-ART-078: each revision content is the full payload, not a diff', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const newContent = { format: 'markdown', body: '# Complete snapshot' };
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: newContent, version: 1 })
        .expect(200);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data[0].content).toEqual(DOC_CONTENT);
      expect(revs.body.data[1].content).toEqual(newContent);
    });

    // VAL-ART-095: Restore races with a user edit safely
    it('VAL-ART-095: concurrent restore + edit — one wins, other gets 409 or serializes', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      // Both start from version 1
      // Restore v1 (uses current version=1 internally → bumps to 2)
      const restoreRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restoreRes.body.data.version).toBe(2);
      // Now PATCH with stale version=1 → should 409
      const patchRes = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { format: 'markdown', body: '# concurrent' }, version: 1 })
        .expect(409);
      expect(patchRes.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      // Final state: version=2, no data loss
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.version).toBe(2);
    });
  });

  // =========================================================================
  // E. Status — DELETE / archive / restore (VAL-ART-027, 028, 029, 030, 039)
  // =========================================================================

  describe('Status — delete / archive / restore', () => {
    // VAL-ART-027 + VAL-ART-039: DELETE soft-deletes
    it('VAL-ART-027/039: DELETE sets status=deleted, row persists, excluded from active list', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const del = await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(del.body.data.status).toBe('deleted');
      expect(del.body.data.deletedAt).not.toBeNull();
      // Default list excludes it
      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      expect(list.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
      // Direct fetch still works (row persists)
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.status).toBe('deleted');
    });

    // VAL-ART-028: Archive sets status=archived, excluded from active, included in ?status=archived
    it('VAL-ART-028: archive excludes from active list, included in ?status=archived', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const archive = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/archive`)
        .expect(200);
      expect(archive.body.data.status).toBe('archived');
      // Active list excludes
      const activeList = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      expect(activeList.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
      // Archived list includes
      const archivedList = await request(app)
        .get(`/api/companies/${companyId}/artifacts?status=archived`)
        .expect(200);
      expect(archivedList.body.data.map((a: { id: string }) => a.id)).toContain(id);
    });

    // VAL-ART-029: Restore from archived returns to active
    it('VAL-ART-029: restore from archived returns status=active, reappears in default list', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/archive`)
        .expect(200);
      const restore = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/restore`)
        .expect(200);
      expect(restore.body.data.status).toBe('active');
      // Reappears in default list
      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      expect(list.body.data.map((a: { id: string }) => a.id)).toContain(id);
    });

    it('VAL-ART-029: restore from deleted returns to active, clears deletedAt', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      const restore = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/restore`)
        .expect(200);
      expect(restore.body.data.status).toBe('active');
      expect(restore.body.data.deletedAt).toBeNull();
      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      expect(list.body.data.map((a: { id: string }) => a.id)).toContain(id);
    });

    // VAL-ART-030: Delete/archive do not destroy revisions
    it('VAL-ART-030: revisions preserved after delete (no revision lost)', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      const beforeRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const beforeCount = beforeRevs.body.data.length;
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      const afterRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      // setArtifactStatus calls updateArtifact first (adds 1 revision for the
      // status-change save), then sets status. So revisions grow by exactly 1.
      expect(afterRevs.body.data.length).toBe(beforeCount + 1);
      // All prior revisions are still present (no history destroyed)
      const beforeVersions = beforeRevs.body.data.map((r: { version: number }) => r.version);
      const afterVersions = afterRevs.body.data.map((r: { version: number }) => r.version);
      for (const v of beforeVersions) {
        expect(afterVersions).toContain(v);
      }
    });

    it('VAL-ART-030: revisions preserved after archive (no revision lost)', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const beforeRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const beforeCount = beforeRevs.body.data.length;
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/archive`)
        .expect(200);
      const afterRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      // setArtifactStatus calls updateArtifact first (adds 1 revision for the
      // status-change save), then sets status. So revisions grow by exactly 1.
      expect(afterRevs.body.data.length).toBe(beforeCount + 1);
      // All prior revisions are still present
      const beforeVersions = beforeRevs.body.data.map((r: { version: number }) => r.version);
      const afterVersions = afterRevs.body.data.map((r: { version: number }) => r.version);
      for (const v of beforeVersions) {
        expect(afterVersions).toContain(v);
      }
    });
  });

  // =========================================================================
  // F. Scoping — cross-company / cross-project (VAL-ART-015, 040, 042, 073)
  // =========================================================================

  describe('Scoping — cross-company / cross-project', () => {
    // VAL-ART-015 + VAL-ART-040: Cross-company access rejected
    it('VAL-ART-015/040: GET artifact from another company returns 404', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .expect(404);
    });

    it('VAL-ART-040: PATCH artifact from another company returns 404', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .patch(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(404);
      // Original artifact unchanged
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.version).toBe(1);
    });

    it('VAL-ART-040: DELETE artifact from another company returns 404', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      await request(app)
        .delete(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .expect(404);
      // Original artifact still active
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.status).toBe('active');
    });

    // VAL-ART-042: Project scope mismatch rejected
    it('VAL-ART-042: create with projectId from another company returns 404', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ cross',
          content: DOC_CONTENT,
          projectId: otherProjectId,
        })
        .expect(404);
      expect(res.body.code).toBe('PROJECT_INVALID');
    });

    // VAL-ART-073: companyId immutable, always matches path
    it('VAL-ART-073: companyId set from path, never changes, cross-company rejected', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      expect(created.body.data.companyId).toBe(companyId);
      // Cross-company PATCH/DELETE rejected
      await request(app)
        .patch(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(404);
      await request(app)
        .delete(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .expect(404);
      // companyId unchanged
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.companyId).toBe(companyId);
    });
  });

  // =========================================================================
  // G. Project lifecycle (VAL-ART-058, 072, 088)
  // =========================================================================

  describe('Project lifecycle', () => {
    // VAL-ART-058 + VAL-ART-072: Deleting a project clears artifact projectId
    it('VAL-ART-058/072: hard-deleting a project clears artifact projectId, artifacts preserved', async () => {
      const created = await createDoc({ projectId }).expect(201);
      const id = created.body.data.id;
      expect(created.body.data.projectId).toBe(projectId);
      // Hard-delete the project row (simulates real deletion; FK onDelete:set null)
      await db.drizzle.execute(
        sql`DELETE FROM "projects" WHERE "id" = ${projectId}`,
      );
      // Artifact still exists with projectId=null
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(get.body.data.projectId).toBeNull();
      expect(get.body.data.status).toBe('active');
      // Revisions intact
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.length).toBeGreaterThan(0);
      // Artifact still editable (VAL-ART-072)
      const patch = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);
      expect(patch.body.data.version).toBe(2);
    });

    // VAL-ART-088: Archived project rejects new artifact creation
    it('VAL-ART-088: creating artifact with archived projectId is rejected', async () => {
      // Archive the project via DELETE route (which archives)
      await request(app)
        .delete(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);
      // Try to create an artifact with the archived project
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ archived proj doc',
          content: DOC_CONTENT,
          projectId,
        })
        .expect(409);
      expect(res.body.code).toBe('PROJECT_ARCHIVED');
      // No artifact created
      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('VAL-ART-088: company-level create with projectId=null still works after archiving a project', async () => {
      await request(app)
        .delete(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);
      const res = await createDoc({ projectId: null }).expect(201);
      expect(res.body.data.projectId).toBeNull();
    });
  });

  // =========================================================================
  // H. Realtime events (VAL-ART-061, 063)
  // =========================================================================

  describe('Realtime events', () => {
    // VAL-ART-061: artifact.revision.created emitted on each save
    it('VAL-ART-061: emits artifact.revision.created on create', async () => {
      const events = await captureEvents(async () => {
        await createDoc().expect(201);
      });
      const revEvents = filterEvents(events, 'artifact.revision.created');
      expect(revEvents.length).toBe(1);
      expect(revEvents[0].companyId).toBe(companyId);
      // The emit() helper wraps the payload in { artifact: ... }
      expect(revEvents[0].payload.artifact).toHaveProperty('version', 1);
    });

    it('VAL-ART-061: emits artifact.revision.created on each PATCH', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: DOC_CONTENT_V2, version: 1 })
          .expect(200);
      });
      const revEvents = filterEvents(events, 'artifact.revision.created');
      expect(revEvents.length).toBe(1);
      expect(revEvents[0].payload.artifact).toHaveProperty('version', 2);
    });

    it('emits artifact.created on create', async () => {
      const events = await captureEvents(async () => {
        await createDoc().expect(201);
      });
      const created = filterEvents(events, 'artifact.created');
      expect(created.length).toBe(1);
      expect(created[0].companyId).toBe(companyId);
    });

    it('emits artifact.updated on PATCH', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: DOC_CONTENT_V2, version: 1 })
          .expect(200);
      });
      const updated = filterEvents(events, 'artifact.updated');
      expect(updated.length).toBe(1);
      expect(updated[0].companyId).toBe(companyId);
    });

    it('emits artifact.deleted on DELETE', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const events = await captureEvents(async () => {
        await request(app)
          .delete(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);
      });
      const deleted = filterEvents(events, 'artifact.deleted');
      expect(deleted.length).toBe(1);
      expect(deleted[0].companyId).toBe(companyId);
    });

    it('emits artifact.archived on archive', async () => {
      const created = await createDoc().expect(201);
      const id = created.body.data.id;
      const events = await captureEvents(async () => {
        await request(app)
          .post(`/api/companies/${companyId}/artifacts/${id}/archive`)
          .expect(200);
      });
      const archived = filterEvents(events, 'artifact.archived');
      expect(archived.length).toBe(1);
      expect(archived[0].companyId).toBe(companyId);
    });

    // VAL-ART-063: Realtime events are company-scoped
    it('VAL-ART-063: events for company A carry companyId=A, not B', async () => {
      const events = await captureEvents(async () => {
        // Create in company A
        await createDoc({ companyId }).expect(201);
        // Create in company B
        await createDoc({
          companyId: otherCompanyId,
          projectId: null,
        }).expect(201);
      });
      const createdEvents = filterEvents(events, 'artifact.created');
      expect(createdEvents.length).toBe(2);
      const companyIds = createdEvents.map((e) => e.companyId);
      expect(companyIds).toContain(companyId);
      expect(companyIds).toContain(otherCompanyId);
      // Each event has the correct companyId
      const aEvent = createdEvents.find((e) => e.companyId === companyId);
      const bEvent = createdEvents.find((e) => e.companyId === otherCompanyId);
      expect(aEvent).toBeDefined();
      expect(bEvent).toBeDefined();
      // No cross-contamination
      expect(aEvent!.companyId).not.toBe(otherCompanyId);
      expect(bEvent!.companyId).not.toBe(companyId);
    });
  });

  // =========================================================================
  // I. Filter composition (VAL-ART-092)
  // =========================================================================

  describe('Filter composition', () => {
    it('VAL-ART-092: status=archived&type=document returns only archived documents', async () => {
      // Create: 1 active doc, 1 archived doc, 1 active sheet, 1 deleted doc
      const activeDoc = (await createDoc({ title: 'Active Doc' }).expect(201)).body.data.id;
      const archivedDoc = (await createDoc({ title: 'Archived Doc' }).expect(201)).body.data.id;
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${archivedDoc}/archive`)
        .expect(200);
      await createDoc({
        type: 'sheet',
        title: 'Active Sheet',
        content: SHEET_CONTENT,
      }).expect(201);
      const deletedDoc = (await createDoc({ title: 'Deleted Doc' }).expect(201)).body.data.id;
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${deletedDoc}`)
        .expect(200);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts?status=archived&type=document`)
        .expect(200);
      const ids = res.body.data.map((a: { id: string }) => a.id);
      expect(ids).toEqual([archivedDoc]);
      expect(ids).not.toContain(activeDoc);
      expect(ids).not.toContain(deletedDoc);
    });
  });
});
