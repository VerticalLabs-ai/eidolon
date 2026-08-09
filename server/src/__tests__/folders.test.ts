import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

const DOC_CONTENT = { format: 'markdown' as const, body: '# Hello' };

async function captureEvents<T extends EidolonEvent = EidolonEvent>(
  fn: () => Promise<void>,
): Promise<T[]> {
  const events: T[] = [];
  const handler = (event: EidolonEvent) => events.push(event as T);
  eventBus.onEvent(handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

function filterEvents<T extends EidolonEvent>(events: T[], type: string): T[] {
  return events.filter((e) => e.type === type);
}

describe('Artifact folders API — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Folder Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other Folder Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Folder Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other Folder Proj' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;
  });

  /** Create a top-level project folder. */
  function createFolder(overrides: {
    companyId?: string;
    projectId?: string | null;
    parentId?: string | null;
    name?: string;
  } = {}) {
    const body: Record<string, unknown> = { name: overrides.name ?? '__mtest__ Folder 1' };
    if (overrides.projectId === undefined) body.projectId = projectId;
    else if (overrides.projectId !== null) body.projectId = overrides.projectId;
    else body.projectId = null;
    if (overrides.parentId !== undefined) body.parentId = overrides.parentId;
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/folders`)
      .send(body);
  }

  /** Create a document artifact in the project. */
  function createDoc(overrides: {
    companyId?: string;
    projectId?: string | null;
    folderId?: string | null;
    title?: string;
  } = {}) {
    const body: Record<string, unknown> = {
      type: 'document',
      title: overrides.title ?? '__mtest__ Folder Doc',
      content: DOC_CONTENT,
    };
    if (overrides.projectId === undefined) body.projectId = projectId;
    else body.projectId = overrides.projectId;
    if (overrides.folderId !== undefined) body.folderId = overrides.folderId;
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send(body);
  }

  // =========================================================================
  // VAL-FOLDER-001: Create a top-level folder in a project
  // =========================================================================
  describe('VAL-FOLDER-001: top-level folder create', () => {
    it('creates a top-level project folder with parentId=null, correct scoping', async () => {
      const res = await createFolder({ name: '__mtest__ Top' }).expect(201);
      const folder = res.body.data;
      expect(folder.id).toBeDefined();
      expect(folder.companyId).toBe(companyId);
      expect(folder.projectId).toBe(projectId);
      expect(folder.parentId).toBeNull();
      expect(folder.name).toBe('__mtest__ Top');
      // Appears in folder list
      const list = await request(app)
        .get(`/api/companies/${companyId}/folders?projectId=${projectId}`)
        .expect(200);
      const ids = list.body.data.map((f: { id: string }) => f.id);
      expect(ids).toContain(folder.id);
    });

    it('creates a company-level (projectId=null) folder', async () => {
      const res = await createFolder({ projectId: null, name: '__mtest__ CoTop' }).expect(201);
      expect(res.body.data.projectId).toBeNull();
      expect(res.body.data.parentId).toBeNull();
    });

    it('rejects empty name with 400', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/folders`)
        .send({ name: '   ', projectId })
        .expect(400);
    });

    it('rejects projectId from another company with 404', async () => {
      await createFolder({ projectId: otherProjectId }).expect(404);
    });
  });

  // =========================================================================
  // VAL-FOLDER-002: Create nested folders under a parent
  // =========================================================================
  describe('VAL-FOLDER-002: nested folders', () => {
    it('creates a child folder with parentId referencing an existing folder', async () => {
      const parent = (await createFolder({ name: '__mtest__ Parent' }).expect(201)).body.data;
      const child = (await createFolder({ name: '__mtest__ Child', parentId: parent.id }).expect(201)).body.data;
      expect(child.parentId).toBe(parent.id);
      expect(child.projectId).toBe(projectId);
      // Tree walk: parent → child
      const list = await request(app)
        .get(`/api/companies/${companyId}/folders?projectId=${projectId}`)
        .expect(200);
      const byId = new Map<string, any>(list.body.data.map((f: any) => [f.id as string, f]));
      expect(byId.get(child.id)?.parentId).toBe(parent.id);
    });

    it('allows a child with the same name as its parent (different bucket)', async () => {
      const parent = (await createFolder({ name: '__mtest__ Self' }).expect(201)).body.data;
      // A child may share the parent's name — uniqueness is within the same
      // parent bucket, not across the tree. Self-reference on CREATE is
      // impossible (the folder id does not exist yet); cycle prevention is
      // exercised on move (see VAL-FOLDER-016 tests).
      const child = (await createFolder({ name: '__mtest__ Self', parentId: parent.id }).expect(201)).body.data;
      expect(child.parentId).toBe(parent.id);
    });

    it('rejects child with mismatched project scope (company-level parent, project child)', async () => {
      const coParent = (await createFolder({ projectId: null, name: '__mtest__ CoParent' }).expect(201)).body.data;
      await createFolder({ projectId, parentId: coParent.id, name: '__mtest__ ProjChild' }).expect(400);
    });
  });

  // =========================================================================
  // VAL-FOLDER-004/005/006: Move artifact into/out of/between folders
  // =========================================================================
  describe('VAL-FOLDER-004/005/006: move artifacts', () => {
    it('VAL-FOLDER-004: PATCH {folderId} moves artifact into folder', async () => {
      const folder = (await createFolder({ name: '__mtest__ F1' }).expect(201)).body.data;
      const doc = (await createDoc().expect(201)).body.data;
      // Move into folder
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ folderId: folder.id })
        .expect(200);
      // folderId persisted
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .expect(200);
      expect(get.body.data.folderId).toBe(folder.id);
      // Folder-scoped list contains it
      const inFolder = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=${folder.id}`)
        .expect(200);
      expect(inFolder.body.data.map((a: { id: string }) => a.id)).toContain(doc.id);
    });

    it('VAL-FOLDER-005: PATCH {folderId:null} unfiles artifact', async () => {
      const folder = (await createFolder({ name: '__mtest__ F2' }).expect(201)).body.data;
      const doc = (await createDoc({ folderId: folder.id }).expect(201)).body.data;
      // Unfile
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ folderId: null })
        .expect(200);
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .expect(200);
      expect(get.body.data.folderId).toBeNull();
      // Unfiled list contains it
      const unfiled = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=null&projectId=${projectId}`)
        .expect(200);
      expect(unfiled.body.data.map((a: { id: string }) => a.id)).toContain(doc.id);
      // Folder-scoped list does NOT contain it
      const inFolder = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=${folder.id}`)
        .expect(200);
      expect(inFolder.body.data.map((a: { id: string }) => a.id)).not.toContain(doc.id);
    });

    it('VAL-FOLDER-006: move artifact between folders A → B (single residence)', async () => {
      const folderA = (await createFolder({ name: '__mtest__ A' }).expect(201)).body.data;
      const folderB = (await createFolder({ name: '__mtest__ B' }).expect(201)).body.data;
      const doc = (await createDoc({ folderId: folderA.id }).expect(201)).body.data;
      // Move A → B
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ folderId: folderB.id })
        .expect(200);
      // Only in B
      const inB = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=${folderB.id}`)
        .expect(200);
      const inA = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=${folderA.id}`)
        .expect(200);
      expect(inB.body.data.map((a: { id: string }) => a.id)).toContain(doc.id);
      expect(inA.body.data.map((a: { id: string }) => a.id)).not.toContain(doc.id);
    });

    it('rejects moving artifact into a folder of another company with 400', async () => {
      const otherFolder = (await createFolder({
        companyId: otherCompanyId,
        projectId: null,
        name: '__mtest__ OtherCo',
      }).expect(201)).body.data;
      const doc = (await createDoc({ projectId: null }).expect(201)).body.data;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ folderId: otherFolder.id })
        .expect(400);
      // folderId unchanged (null)
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .expect(200);
      expect(get.body.data.folderId).toBeNull();
    });

    it('rejects moving a project artifact into a company-level folder (scope mismatch)', async () => {
      const coFolder = (await createFolder({ projectId: null, name: '__mtest__ CoFolder' }).expect(201)).body.data;
      const doc = (await createDoc({ projectId }).expect(201)).body.data;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ folderId: coFolder.id })
        .expect(400);
    });
  });

  // =========================================================================
  // VAL-FOLDER-007: List artifacts filtered by folder (direct members only)
  // =========================================================================
  describe('VAL-FOLDER-007: folder-scoped list (direct members only)', () => {
    it('returns only direct members, excludes child-folder artifacts and unfiled', async () => {
      const parent = (await createFolder({ name: '__mtest__ Par' }).expect(201)).body.data;
      const child = (await createFolder({ name: '__mtest__ Chl', parentId: parent.id }).expect(201)).body.data;
      const inParent = (await createDoc({ folderId: parent.id, title: '__mtest__ InParent' }).expect(201)).body.data;
      const inChild = (await createDoc({ folderId: child.id, title: '__mtest__ InChild' }).expect(201)).body.data;
      const unfiled = (await createDoc({ title: '__mtest__ Unfiled' }).expect(201)).body.data;

      const parentList = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=${parent.id}`)
        .expect(200);
      const parentIds = parentList.body.data.map((a: { id: string }) => a.id);
      expect(parentIds).toContain(inParent.id);
      expect(parentIds).not.toContain(inChild.id); // descendant excluded
      expect(parentIds).not.toContain(unfiled.id); // unfiled excluded

      // Unfiltered list returns all
      const allList = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${projectId}`)
        .expect(200);
      const allIds = allList.body.data.map((a: { id: string }) => a.id);
      expect(allIds).toContain(inParent.id);
      expect(allIds).toContain(inChild.id);
      expect(allIds).toContain(unfiled.id);
    });
  });

  // =========================================================================
  // VAL-FOLDER-008: Rename a folder
  // =========================================================================
  describe('VAL-FOLDER-008: rename folder', () => {
    it('renames without disturbing parentId, children, or artifact folderId', async () => {
      const parent = (await createFolder({ name: '__mtest__ ParR' }).expect(201)).body.data;
      const child = (await createFolder({ name: '__mtest__ ChlR', parentId: parent.id }).expect(201)).body.data;
      const doc = (await createDoc({ folderId: parent.id, title: '__mtest__ RDoc' }).expect(201)).body.data;

      const renamed = await request(app)
        .patch(`/api/companies/${companyId}/folders/${parent.id}`)
        .send({ name: '__mtest__ ParRenamed' })
        .expect(200);
      expect(renamed.body.data.name).toBe('__mtest__ ParRenamed');
      expect(renamed.body.data.parentId).toBeNull();

      // Child still references parent
      const childGet = await request(app)
        .get(`/api/companies/${companyId}/folders/${child.id}`)
        .expect(200);
      expect(childGet.body.data.parentId).toBe(parent.id);
      // Artifact still in the renamed folder
      const docGet = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .expect(200);
      expect(docGet.body.data.folderId).toBe(parent.id);
      // Folder-scoped list still contains it
      const inFolder = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=${parent.id}`)
        .expect(200);
      expect(inFolder.body.data.map((a: { id: string }) => a.id)).toContain(doc.id);
    });
  });

  // =========================================================================
  // VAL-FOLDER-009/017: Delete a folder moves children to parent (no orphans)
  // =========================================================================
  describe('VAL-FOLDER-009/017: delete folder relocates children', () => {
    it('deletes a nested folder: children + artifacts relocate to grandparent', async () => {
      const grand = (await createFolder({ name: '__mtest__ Grand' }).expect(201)).body.data;
      const mid = (await createFolder({ name: '__mtest__ Mid', parentId: grand.id }).expect(201)).body.data;
      const leaf = (await createFolder({ name: '__mtest__ Leaf', parentId: mid.id }).expect(201)).body.data;
      const docInMid = (await createDoc({ folderId: mid.id, title: '__mtest__ MidDoc' }).expect(201)).body.data;
      const docInLeaf = (await createDoc({ folderId: leaf.id, title: '__mtest__ LeafDoc' }).expect(201)).body.data;

      // Delete mid → its children (leaf) and artifacts (docInMid) relocate to grand
      await request(app)
        .delete(`/api/companies/${companyId}/folders/${mid.id}`)
        .expect(204);

      // mid row gone
      await request(app)
        .get(`/api/companies/${companyId}/folders/${mid.id}`)
        .expect(404);
      // leaf now under grand
      const leafGet = await request(app)
        .get(`/api/companies/${companyId}/folders/${leaf.id}`)
        .expect(200);
      expect(leafGet.body.data.parentId).toBe(grand.id);
      // docInMid now under grand
      const midDocGet = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${docInMid.id}`)
        .expect(200);
      expect(midDocGet.body.data.folderId).toBe(grand.id);
      // docInLeaf still under leaf (subtree preserved)
      const leafDocGet = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${docInLeaf.id}`)
        .expect(200);
      expect(leafDocGet.body.data.folderId).toBe(leaf.id);
      // No artifacts soft-deleted as a side effect
      expect(midDocGet.body.data.status).toBe('active');
      expect(leafDocGet.body.data.status).toBe('active');
    });

    it('deletes a top-level folder: children + artifacts relocate to unfiled (null)', async () => {
      const top = (await createFolder({ name: '__mtest__ Top' }).expect(201)).body.data;
      const child = (await createFolder({ name: '__mtest__ TopChild', parentId: top.id }).expect(201)).body.data;
      const doc = (await createDoc({ folderId: top.id, title: '__mtest__ TopDoc' }).expect(201)).body.data;

      await request(app)
        .delete(`/api/companies/${companyId}/folders/${top.id}`)
        .expect(204);

      // child now top-level (parentId null)
      const childGet = await request(app)
        .get(`/api/companies/${companyId}/folders/${child.id}`)
        .expect(200);
      expect(childGet.body.data.parentId).toBeNull();
      // doc now unfiled
      const docGet = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .expect(200);
      expect(docGet.body.data.folderId).toBeNull();
    });

    it('VAL-FOLDER-017: no dangling parentId/folderId references after delete', async () => {
      const top = (await createFolder({ name: '__mtest__ OrphanTop' }).expect(201)).body.data;
      const child = (await createFolder({ name: '__mtest__ OrphanChild', parentId: top.id }).expect(201)).body.data;
      const doc = (await createDoc({ folderId: top.id, title: '__mtest__ OrphanDoc' }).expect(201)).body.data;

      await request(app)
        .delete(`/api/companies/${companyId}/folders/${top.id}`)
        .expect(204);

      // Referential integrity: no folder.parentId or artifact.folderId points to top.id
      const danglingFolders = await db.drizzle.execute(
        sql`SELECT id FROM "artifact_folders" WHERE "parent_id" = ${top.id}`,
      );
      expect((danglingFolders as any).length ?? 0).toBe(0);
      const danglingArtifacts = await db.drizzle.execute(
        sql`SELECT id FROM "artifacts" WHERE "folder_id" = ${top.id}`,
      );
      expect((danglingArtifacts as any).length ?? 0).toBe(0);
    });
  });

  // =========================================================================
  // VAL-FOLDER-011: Artifacts retain folderId across content edits
  // =========================================================================
  describe('VAL-FOLDER-011: folderId preserved across content edits', () => {
    it('content PATCH preserves folderId and bumps version', async () => {
      const folder = (await createFolder({ name: '__mtest__ KeepF' }).expect(201)).body.data;
      const doc = (await createDoc({ folderId: folder.id }).expect(201)).body.data;
      const beforeFolderId = doc.folderId;
      // Content edit
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ content: { format: 'markdown', body: '# Edited' }, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.folderId).toBe(beforeFolderId);
      // Still in the folder-scoped list
      const inFolder = await request(app)
        .get(`/api/companies/${companyId}/artifacts?folderId=${folder.id}`)
        .expect(200);
      expect(inFolder.body.data.map((a: { id: string }) => a.id)).toContain(doc.id);
    });
  });

  // =========================================================================
  // VAL-FOLDER-012: Folder operations are company-scoped
  // =========================================================================
  describe('VAL-FOLDER-012: company-scoped operations', () => {
    it('rejects creating a folder with parentId from another company', async () => {
      const otherFolder = (await createFolder({
        companyId: otherCompanyId,
        projectId: null,
        name: '__mtest__ Other',
      }).expect(201)).body.data;
      await createFolder({
        projectId: null,
        parentId: otherFolder.id,
        name: '__mtest__ Cross',
      }).expect(404);
    });

    it('rejects rename/delete of a folder from another company (404)', async () => {
      const otherFolder = (await createFolder({
        companyId: otherCompanyId,
        projectId: null,
        name: '__mtest__ Other2',
      }).expect(201)).body.data;
      await request(app)
        .patch(`/api/companies/${companyId}/folders/${otherFolder.id}`)
        .send({ name: '__mtest__ Hijack' })
        .expect(404);
      await request(app)
        .delete(`/api/companies/${companyId}/folders/${otherFolder.id}`)
        .expect(404);
      // Original untouched
      const get = await request(app)
        .get(`/api/companies/${otherCompanyId}/folders/${otherFolder.id}`)
        .expect(200);
      expect(get.body.data.name).toBe('__mtest__ Other2');
    });

    it('rejects creating an artifact with folderId from another company', async () => {
      const otherFolder = (await createFolder({
        companyId: otherCompanyId,
        projectId: null,
        name: '__mtest__ Other3',
      }).expect(201)).body.data;
      await createDoc({ projectId: null, folderId: otherFolder.id }).expect(400);
    });
  });

  // =========================================================================
  // VAL-FOLDER-014: Folder name uniqueness within the same parent
  // =========================================================================
  describe('VAL-FOLDER-014: name uniqueness within same parent', () => {
    it('rejects duplicate name under the same parent (case-insensitive)', async () => {
      await createFolder({ name: '__mtest__ Unique' }).expect(201);
      // Exact duplicate
      await createFolder({ name: '__mtest__ Unique' }).expect(409);
      // Case-insensitive duplicate
      await createFolder({ name: '__mtest__ UNIQUE' }).expect(409);
    });

    it('allows the same name under a different parent', async () => {
      const parentA = (await createFolder({ name: '__mtest__ PA' }).expect(201)).body.data;
      const parentB = (await createFolder({ name: '__mtest__ PB' }).expect(201)).body.data;
      await createFolder({ name: '__mtest__ Same', parentId: parentA.id }).expect(201);
      await createFolder({ name: '__mtest__ Same', parentId: parentB.id }).expect(201);
    });

    it('enforces uniqueness for top-level (parentId null) within company/project', async () => {
      await createFolder({ projectId: null, name: '__mtest__ CoUnique' }).expect(201);
      await createFolder({ projectId: null, name: '__mtest__ CoUnique' }).expect(409);
    });

    it('allows the same name at company-level vs project-level (different project scope)', async () => {
      await createFolder({ projectId: null, name: '__mtest__ Scoped' }).expect(201);
      await createFolder({ projectId, name: '__mtest__ Scoped' }).expect(201);
    });
  });

  // =========================================================================
  // VAL-FOLDER-016: Moving a folder reparents its subtree
  // =========================================================================
  describe('VAL-FOLDER-016: move folder preserves subtree', () => {
    it('reparents a folder subtree: internal structure + artifact membership preserved', async () => {
      const newRoot = (await createFolder({ name: '__mtest__ NewRoot' }).expect(201)).body.data;
      const moved = (await createFolder({ name: '__mtest__ Moved', parentId: null as any }).expect(201)).body.data;
      // Actually create moved as top-level then give it a child
      const child = (await createFolder({ name: '__mtest__ MovedChild', parentId: moved.id }).expect(201)).body.data;
      const doc = (await createDoc({ folderId: moved.id, title: '__mtest__ MovedDoc' }).expect(201)).body.data;

      // Reparent moved → newRoot
      const result = await request(app)
        .patch(`/api/companies/${companyId}/folders/${moved.id}`)
        .send({ parentId: newRoot.id })
        .expect(200);
      expect(result.body.data.parentId).toBe(newRoot.id);

      // child still under moved
      const childGet = await request(app)
        .get(`/api/companies/${companyId}/folders/${child.id}`)
        .expect(200);
      expect(childGet.body.data.parentId).toBe(moved.id);
      // doc still under moved (folderId unchanged)
      const docGet = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .expect(200);
      expect(docGet.body.data.folderId).toBe(moved.id);
    });

    it('rejects moving a folder into its own descendant (cycle prevention)', async () => {
      const a = (await createFolder({ name: '__mtest__ CycA' }).expect(201)).body.data;
      const b = (await createFolder({ name: '__mtest__ CycB', parentId: a.id }).expect(201)).body.data;
      const c = (await createFolder({ name: '__mtest__ CycC', parentId: b.id }).expect(201)).body.data;
      // Move A into C (C is a descendant of A) → cycle
      await request(app)
        .patch(`/api/companies/${companyId}/folders/${a.id}`)
        .send({ parentId: c.id })
        .expect(400);
      // A still top-level
      const aGet = await request(app)
        .get(`/api/companies/${companyId}/folders/${a.id}`)
        .expect(200);
      expect(aGet.body.data.parentId).toBeNull();
    });

    it('rejects moving a folder into itself', async () => {
      const a = (await createFolder({ name: '__mtest__ SelfA' }).expect(201)).body.data;
      await request(app)
        .patch(`/api/companies/${companyId}/folders/${a.id}`)
        .send({ parentId: a.id })
        .expect(400);
    });

    it('can move a folder to top-level (parentId=null)', async () => {
      const parent = (await createFolder({ name: '__mtest__ UnpPar' }).expect(201)).body.data;
      const child = (await createFolder({ name: '__mtest__ UnpChl', parentId: parent.id }).expect(201)).body.data;
      const res = await request(app)
        .patch(`/api/companies/${companyId}/folders/${child.id}`)
        .send({ parentId: null })
        .expect(200);
      expect(res.body.data.parentId).toBeNull();
    });
  });

  // =========================================================================
  // Realtime folder events
  // =========================================================================
  describe('Realtime folder events', () => {
    it('emits folder.created on create', async () => {
      const events = await captureEvents(async () => {
        await createFolder({ name: '__mtest__ Ev' }).expect(201);
      });
      const created = filterEvents(events, 'folder.created');
      expect(created.length).toBe(1);
      expect(created[0].companyId).toBe(companyId);
    });

    it('emits folder.updated on rename', async () => {
      const folder = (await createFolder({ name: '__mtest__ EvR' }).expect(201)).body.data;
      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/folders/${folder.id}`)
          .send({ name: '__mtest__ EvR2' })
          .expect(200);
      });
      const updated = filterEvents(events, 'folder.updated');
      expect(updated.length).toBe(1);
    });

    it('emits folder.deleted on delete', async () => {
      const folder = (await createFolder({ name: '__mtest__ EvD' }).expect(201)).body.data;
      const events = await captureEvents(async () => {
        await request(app)
          .delete(`/api/companies/${companyId}/folders/${folder.id}`)
          .expect(204);
      });
      const deleted = filterEvents(events, 'folder.deleted');
      expect(deleted.length).toBe(1);
      expect(deleted[0].companyId).toBe(companyId);
    });

    it('emits artifact.updated on move (folderId change)', async () => {
      const folder = (await createFolder({ name: '__mtest__ EvM' }).expect(201)).body.data;
      const doc = (await createDoc().expect(201)).body.data;
      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
          .send({ folderId: folder.id })
          .expect(200);
      });
      const updated = filterEvents(events, 'artifact.updated');
      expect(updated.length).toBe(1);
    });
  });

  // =========================================================================
  // Create artifact with folderId at creation time
  // =========================================================================
  describe('create artifact with folderId', () => {
    it('creates an artifact directly in a folder', async () => {
      const folder = (await createFolder({ name: '__mtest__ Direct' }).expect(201)).body.data;
      const res = await createDoc({ folderId: folder.id }).expect(201);
      expect(res.body.data.folderId).toBe(folder.id);
    });
  });
});
