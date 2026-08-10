import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

const DOC_CONTENT = { format: 'markdown' as const, body: '# Hello' };
const SHEET_CONTENT = {
  columns: [{ id: 'c1', key: 'name' }],
  rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
};
const BOARD_CONTENT = {
  columns: [{ id: 'col1', title: 'To Do' }, { id: 'col2', title: 'Done' }],
  cards: [{ id: 'card1', columnId: 'col1', title: 'Task A', order: 0 }],
};
const SLIDE_CONTENT = {
  slides: [{ id: 's1', layout: 'title', blocks: [{ type: 'heading', content: { text: 'Welcome' } }] }],
};
const TIMELINE_CONTENT = {
  tasks: [{ id: 't1', title: 'Kickoff', start: '2026-01-01', end: '2026-01-02', progress: 0 }],
};

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

describe('Workspace templates API — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let folderId: string;
  let childFolderId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Template Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other Template Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Source Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    // Create a folder + child folder in the project.
    const folder = await request(app)
      .post(`/api/companies/${companyId}/folders`)
      .send({ name: 'Research', projectId })
      .expect(201);
    folderId = folder.body.data.id;

    const childFolder = await request(app)
      .post(`/api/companies/${companyId}/folders`)
      .send({ name: 'Notes', projectId, parentId: folderId })
      .expect(201);
    childFolderId = childFolder.body.data.id;
  });

  /** Create a document artifact in the project (optionally in a folder). */
  function createDoc(overrides: {
    companyId?: string;
    projectId?: string | null;
    folderId?: string | null;
    title?: string;
    content?: Record<string, unknown>;
  } = {}) {
    const body: Record<string, unknown> = {
      type: 'document',
      title: overrides.title ?? '__mtest__ Template Doc',
      content: overrides.content ?? DOC_CONTENT,
    };
    if (overrides.projectId === undefined) body.projectId = projectId;
    else if (overrides.projectId !== null) body.projectId = overrides.projectId;
    if (overrides.folderId !== undefined) body.folderId = overrides.folderId;
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send(body);
  }

  /** Create an artifact of any type in the project. */
  function createArtifact(
    type: string,
    content: Record<string, unknown>,
    overrides: { companyId?: string; projectId?: string | null; folderId?: string | null; title?: string } = {},
  ) {
    const body: Record<string, unknown> = { type, title: overrides.title ?? `__mtest__ ${type}`, content };
    if (overrides.projectId === undefined) body.projectId = projectId;
    else if (overrides.projectId !== null) body.projectId = overrides.projectId;
    if (overrides.folderId !== undefined) body.folderId = overrides.folderId;
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send(body);
  }

  /** Save a project as a project template. */
  function saveProjectTemplate(overrides: {
    companyId?: string;
    projectId?: string;
    name?: string;
    description?: string;
  } = {}) {
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/project-templates`)
      .send({
        projectId: overrides.projectId ?? projectId,
        name: overrides.name ?? '__mtest__ Project Template',
        description: overrides.description,
      });
  }

  /** Save an artifact as an artifact template. */
  function saveArtifactTemplate(artifactId: string, overrides: {
    companyId?: string;
    name?: string;
    description?: string;
  } = {}) {
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifact-templates`)
      .send({
        artifactId,
        name: overrides.name ?? '__mtest__ Artifact Template',
        description: overrides.description,
      });
  }

  // =========================================================================
  // VAL-TEMPLATE-001: Save a project as a reusable project template
  // =========================================================================
  describe('VAL-TEMPLATE-001: save project as template', () => {
    it('captures artifacts, settings, and folder structure scoped to the company', async () => {
      await createDoc({ title: '__mtest__ Doc A', content: DOC_CONTENT }).expect(201);
      await createArtifact('sheet', SHEET_CONTENT, { title: '__mtest__ Sheet A' }).expect(201);

      const res = await saveProjectTemplate({ name: '__mtest__ Saved Proj' }).expect(201);
      const tpl = res.body.data;
      expect(tpl.id).toBeDefined();
      expect(tpl.companyId).toBe(companyId);
      expect(tpl.name).toBe('__mtest__ Saved Proj');
      expect(tpl.projectId).toBe(projectId);
      expect(tpl.artifactCount).toBe(2);
      expect(tpl.folderCount).toBe(2); // Research + Notes
      // Snapshot contains settings + folders + artifacts
      const snapshot = tpl.snapshot;
      expect(snapshot.settings.name).toBe('Source Proj');
      expect(snapshot.folders.length).toBe(2);
      expect(snapshot.artifacts.length).toBe(2);
      // Artifacts captured with type + content
      const types = snapshot.artifacts.map((a: any) => a.type).sort();
      expect(types).toEqual(['document', 'sheet']);
      expect(snapshot.artifacts[0].content).toBeDefined();
    });

    it('rejects saving a project from another company', async () => {
      // Project belongs to companyId; try saving via otherCompanyId.
      const res = await saveProjectTemplate({
        companyId: otherCompanyId,
        name: '__mtest__ Cross',
      }).expect(404);
      expect(res.body.code).toBe('PROJECT_INVALID');
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-002: Create a new project from a project template
  // =========================================================================
  describe('VAL-TEMPLATE-002: create project from template', () => {
    it('clones artifacts with fresh ids and applies settings', async () => {
      const docRes = await createDoc({ title: '__mtest__ Orig Doc', content: DOC_CONTENT }).expect(201);
      const originalDocId = docRes.body.data.id;

      const tpl = (await saveProjectTemplate({ name: '__mtest__ Clone Src' }).expect(201)).body.data;

      const createRes = await request(app)
        .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
        .send({ name: '__mtest__ Cloned Proj' })
        .expect(201);
      const result = createRes.body.data;
      const newProject = result.project;
      const clonedArtifacts = result.artifacts;

      expect(newProject.id).toBeDefined();
      expect(newProject.id).not.toBe(projectId);
      expect(newProject.companyId).toBe(companyId);
      expect(newProject.name).toBe('__mtest__ Cloned Proj');

      // Cloned artifacts have fresh ids and matching types/content.
      expect(clonedArtifacts.length).toBe(1);
      const cloned = clonedArtifacts[0];
      expect(cloned.id).not.toBe(originalDocId);
      expect(cloned.type).toBe('document');
      expect(cloned.title).toBe('__mtest__ Orig Doc');
      expect(cloned.content).toEqual(DOC_CONTENT);
      expect(cloned.version).toBe(1);
      expect(cloned.projectId).toBe(newProject.id);
      // Created by the creating user (local_trusted dev user).
      expect(cloned.createdByUserId).not.toBeNull();
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-003: Template gallery lists available templates
  // =========================================================================
  describe('VAL-TEMPLATE-003: template gallery lists templates', () => {
    it('lists project templates for the company', async () => {
      await saveProjectTemplate({ name: '__mtest__ Gallery A' }).expect(201);
      await saveProjectTemplate({ name: '__mtest__ Gallery B' }).expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/project-templates`)
        .expect(200);
      const names = res.body.data.map((t: any) => t.name);
      expect(names).toContain('__mtest__ Gallery A');
      expect(names).toContain('__mtest__ Gallery B');
    });

    it('lists artifact templates with type summary', async () => {
      const doc = (await createDoc().expect(201)).body.data;
      await saveArtifactTemplate(doc.id, { name: '__mtest__ Art Tpl A' }).expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifact-templates`)
        .expect(200);
      expect(res.body.data.length).toBe(1);
      const tpl = res.body.data[0];
      expect(tpl.name).toBe('__mtest__ Art Tpl A');
      expect(tpl.type).toBe('document');
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-004: Editing the original project does not mutate its template
  // =========================================================================
  describe('VAL-TEMPLATE-004: original project edits do not mutate template', () => {
    it('template snapshot is unchanged after adding an artifact to the original project', async () => {
      await createDoc({ title: '__mtest__ First Doc' }).expect(201);
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Indep' }).expect(201)).body.data;
      const originalSnapshot = JSON.parse(JSON.stringify(tpl.snapshot));

      // Add a new artifact to the original project.
      await createDoc({ title: '__mtest__ Second Doc' }).expect(201);

      const refetched = await request(app)
        .get(`/api/companies/${companyId}/project-templates/${tpl.id}`)
        .expect(200);
      // Snapshot is byte-equivalent (excluding non-meaningful timestamps which aren't in snapshot).
      expect(refetched.body.data.snapshot).toEqual(originalSnapshot);
      expect(refetched.body.data.artifactCount).toBe(1);
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-005: Save an artifact as an artifact-type template
  // =========================================================================
  describe('VAL-TEMPLATE-005: save artifact as template', () => {
    it('captures the artifact type and content scoped to the company', async () => {
      const doc = (await createDoc({ content: { format: 'markdown', body: '# Template body' } }).expect(201)).body.data;

      const res = await saveArtifactTemplate(doc.id, { name: '__mtest__ Doc Template' }).expect(201);
      const tpl = res.body.data;
      expect(tpl.id).toBeDefined();
      expect(tpl.companyId).toBe(companyId);
      expect(tpl.type).toBe('document');
      expect(tpl.content).toEqual({ format: 'markdown', body: '# Template body' });
      expect(tpl.artifactId).toBe(doc.id);
    });

    it('rejects saving an artifact from another company', async () => {
      const otherDoc = (await createDoc({ companyId: otherCompanyId, projectId: null, content: DOC_CONTENT }).expect(201)).body.data;
      const res = await saveArtifactTemplate(otherDoc.id, { companyId: companyId }).expect(404);
      expect(res.body.code).toBe('ARTIFACT_NOT_FOUND');
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-006: Create a new artifact from an artifact template
  // =========================================================================
  describe('VAL-TEMPLATE-006: create artifact from template', () => {
    it('clones content with a fresh id and correct scoping', async () => {
      const doc = (await createDoc({ content: { format: 'markdown', body: '# Clone me' } }).expect(201)).body.data;
      const tpl = (await saveArtifactTemplate(doc.id, { name: '__mtest__ Clone Src' }).expect(201)).body.data;

      const res = await request(app)
        .post(`/api/companies/${companyId}/artifact-templates/${tpl.id}/create-artifact`)
        .send({ projectId, title: '__mtest__ Cloned Doc' })
        .expect(201);
      const cloned = res.body.data;
      expect(cloned.id).not.toBe(doc.id);
      expect(cloned.type).toBe('document');
      expect(cloned.title).toBe('__mtest__ Cloned Doc');
      expect(cloned.content).toEqual({ format: 'markdown', body: '# Clone me' });
      expect(cloned.version).toBe(1);
      expect(cloned.projectId).toBe(projectId);
      expect(cloned.companyId).toBe(companyId);
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-007: Editing the original artifact does not mutate its template
  // =========================================================================
  describe('VAL-TEMPLATE-007: original artifact edits do not mutate template', () => {
    it('template content is unchanged after editing the original artifact', async () => {
      const doc = (await createDoc({ content: DOC_CONTENT }).expect(201)).body.data;
      const tpl = (await saveArtifactTemplate(doc.id, { name: '__mtest__ Art Indep' }).expect(201)).body.data;
      const originalContent = JSON.parse(JSON.stringify(tpl.content));

      // Edit the original artifact (version bump).
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ content: { format: 'markdown', body: '# Changed' }, version: 1 })
        .expect(200);

      const refetched = await request(app)
        .get(`/api/companies/${companyId}/artifact-templates/${tpl.id}`)
        .expect(200);
      expect(refetched.body.data.content).toEqual(originalContent);
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-008: Project template clones include folder structure
  // =========================================================================
  describe('VAL-TEMPLATE-008: clones include folder structure', () => {
    it('reproduces folder hierarchy and places cloned artifacts in equivalent folders', async () => {
      // Place a doc in the child folder (Notes, under Research).
      await createDoc({ folderId: childFolderId, title: '__mtest__ Filed Doc' }).expect(201);

      const tpl = (await saveProjectTemplate({ name: '__mtest__ Folder Clone' }).expect(201)).body.data;

      const res = await request(app)
        .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
        .send({ name: '__mtest__ Cloned With Folders' })
        .expect(201);
      const result = res.body.data;
      const newProjectId = result.project.id;

      // Folder tree matches: 2 folders, parent-child preserved.
      const folders = result.folders;
      expect(folders.length).toBe(2);
      const clonedChild = folders.find((f: any) => f.name === 'Notes');
      const clonedParent = folders.find((f: any) => f.name === 'Research');
      expect(clonedChild).toBeDefined();
      expect(clonedParent).toBeDefined();
      expect(clonedChild.parentId).toBe(clonedParent.id);
      expect(clonedParent.parentId).toBeNull();
      expect(clonedChild.projectId).toBe(newProjectId);
      expect(clonedParent.projectId).toBe(newProjectId);
      // Folder ids are fresh.
      expect(clonedChild.id).not.toBe(childFolderId);
      expect(clonedParent.id).not.toBe(folderId);

      // The cloned artifact is in the equivalent cloned child folder.
      const clonedArtifacts = result.artifacts;
      expect(clonedArtifacts.length).toBe(1);
      expect(clonedArtifacts[0].folderId).toBe(clonedChild.id);
      expect(clonedArtifacts[0].projectId).toBe(newProjectId);
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-009: Template list is company-scoped
  // =========================================================================
  describe('VAL-TEMPLATE-009: template list is company-scoped', () => {
    it('project template list returns only company-A templates; cross-company detail rejected', async () => {
      const tplA = (await saveProjectTemplate({ name: '__mtest__ Co A Tpl' }).expect(201)).body.data;
      // Save a template in company B.
      const otherProject = (await request(app)
        .post(`/api/companies/${otherCompanyId}/projects`)
        .send({ name: 'Other Proj' })
        .expect(201)).body.data;
      const tplB = (await saveProjectTemplate({
        companyId: otherCompanyId,
        projectId: otherProject.id,
        name: '__mtest__ Co B Tpl',
      }).expect(201)).body.data;

      const listA = await request(app)
        .get(`/api/companies/${companyId}/project-templates`)
        .expect(200);
      const idsA = listA.body.data.map((t: any) => t.id);
      expect(idsA).toContain(tplA.id);
      expect(idsA).not.toContain(tplB.id);

      // Cross-company detail rejected.
      await request(app)
        .get(`/api/companies/${companyId}/project-templates/${tplB.id}`)
        .expect(404);
    });

    it('artifact template list is company-scoped', async () => {
      const docA = (await createDoc().expect(201)).body.data;
      const tplA = (await saveArtifactTemplate(docA.id, { name: '__mtest__ Art Co A' }).expect(201)).body.data;

      const otherDoc = (await createDoc({ companyId: otherCompanyId, projectId: null }).expect(201)).body.data;
      const tplB = (await saveArtifactTemplate(otherDoc.id, { companyId: otherCompanyId, name: '__mtest__ Art Co B' }).expect(201)).body.data;

      const listA = await request(app)
        .get(`/api/companies/${companyId}/artifact-templates`)
        .expect(200);
      const idsA = listA.body.data.map((t: any) => t.id);
      expect(idsA).toContain(tplA.id);
      expect(idsA).not.toContain(tplB.id);

      await request(app)
        .get(`/api/companies/${companyId}/artifact-templates/${tplB.id}`)
        .expect(404);
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-010: Creating a project from a template is idempotent under retry
  // =========================================================================
  describe('VAL-TEMPLATE-010: idempotent create-from-template', () => {
    it('retry with the same idempotency key returns the same project, no duplicates', async () => {
      await createDoc({ title: '__mtest__ Idem Doc' }).expect(201);
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Idem Src' }).expect(201)).body.data;

      const key = 'retry-key-123';
      const first = await request(app)
        .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
        .send({ name: '__mtest__ Idem Proj', idempotencyKey: key })
        .expect(201);
      const firstProjectId = first.body.data.project.id;
      const firstArtifactCount = first.body.data.artifacts.length;

      const second = await request(app)
        .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
        .send({ name: '__mtest__ Idem Proj DUPE', idempotencyKey: key })
        .expect(201);
      expect(second.body.data.project.id).toBe(firstProjectId);
      expect(second.body.data.artifacts.length).toBe(firstArtifactCount);

      // A different key creates a new project.
      const third = await request(app)
        .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
        .send({ name: '__mtest__ Idem Proj 2', idempotencyKey: 'different-key' })
        .expect(201);
      expect(third.body.data.project.id).not.toBe(firstProjectId);
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-012: Template captures current artifact versions, not future revisions
  // =========================================================================
  describe('VAL-TEMPLATE-012: captures current versions not future revisions', () => {
    it('project template captures save-time content, not post-save edits', async () => {
      const doc = (await createDoc({ content: { format: 'markdown', body: 'v1 content' } }).expect(201)).body.data;
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Snapshot Tpl' }).expect(201)).body.data;
      const capturedContent = JSON.parse(JSON.stringify(tpl.snapshot.artifacts[0].content));

      // Edit the original artifact.
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ content: { format: 'markdown', body: 'v2 content' }, version: 1 })
        .expect(200);

      const refetched = await request(app)
        .get(`/api/companies/${companyId}/project-templates/${tpl.id}`)
        .expect(200);
      expect(refetched.body.data.snapshot.artifacts[0].content).toEqual(capturedContent);
      expect(refetched.body.data.snapshot.artifacts[0].content.body).toBe('v1 content');
    });

    it('artifact template captures save-time content, not post-save edits', async () => {
      const doc = (await createDoc({ content: { format: 'markdown', body: 'original' } }).expect(201)).body.data;
      const tpl = (await saveArtifactTemplate(doc.id, { name: '__mtest__ Snap Art' }).expect(201)).body.data;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
        .send({ content: { format: 'markdown', body: 'changed' }, version: 1 })
        .expect(200);

      const refetched = await request(app)
        .get(`/api/companies/${companyId}/artifact-templates/${tpl.id}`)
        .expect(200);
      expect(refetched.body.data.content).toEqual({ format: 'markdown', body: 'original' });
    });
  });

  // =========================================================================
  // VAL-TEMPLATE-013: Deleting a template does not affect projects created from it
  // =========================================================================
  describe('VAL-TEMPLATE-013: template deletion does not affect clones', () => {
    it('deleting a project template does not degrade the cloned project', async () => {
      await createDoc({ title: '__mtest__ Del Src Doc' }).expect(201);
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Del Tpl' }).expect(201)).body.data;

      const created = await request(app)
        .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
        .send({ name: '__mtest__ Cloned Before Del' })
        .expect(201);
      const clonedProjectId = created.body.data.project.id;
      const clonedArtifactId = created.body.data.artifacts[0].id;

      // Delete the template.
      await request(app)
        .delete(`/api/companies/${companyId}/project-templates/${tpl.id}`)
        .expect(204);

      // The cloned project + artifact remain intact and editable.
      const projectRes = await request(app)
        .get(`/api/companies/${companyId}/projects/${clonedProjectId}`)
        .expect(200);
      expect(projectRes.body.data.id).toBe(clonedProjectId);

      const artifactRes = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${clonedArtifactId}`)
        .expect(200);
      expect(artifactRes.body.data.id).toBe(clonedArtifactId);
      expect(artifactRes.body.data.status).toBe('active');

      // Edit the cloned artifact (still works).
      const edited = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${clonedArtifactId}`)
        .send({ content: { format: 'markdown', body: '# Edited after template delete' }, version: 1 })
        .expect(200);
      expect(edited.body.data.version).toBe(2);
    });

    it('deleting an artifact template does not degrade the cloned artifact', async () => {
      const doc = (await createDoc({ content: DOC_CONTENT }).expect(201)).body.data;
      const tpl = (await saveArtifactTemplate(doc.id, { name: '__mtest__ Del Art Tpl' }).expect(201)).body.data;

      const cloned = await request(app)
        .post(`/api/companies/${companyId}/artifact-templates/${tpl.id}/create-artifact`)
        .send({ projectId, title: '__mtest__ Cloned From Del' })
        .expect(201);
      const clonedId = cloned.body.data.id;

      await request(app)
        .delete(`/api/companies/${companyId}/artifact-templates/${tpl.id}`)
        .expect(204);

      const refetched = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${clonedId}`)
        .expect(200);
      expect(refetched.body.data.id).toBe(clonedId);
      expect(refetched.body.data.content).toEqual(DOC_CONTENT);
    });
  });

  // =========================================================================
  // VAL-CROSS-013: Templates spanning artifacts — all shipped types clone
  // =========================================================================
  describe('VAL-CROSS-013: project from template clones all shipped artifact types', () => {
    it('clones one of each shipped artifact type (document, sheet, board, slide_deck, timeline)', async () => {
      // Create one of each shipped (enabled) artifact type in the project.
      await createArtifact('document', DOC_CONTENT, { title: '__mtest__ Tpl Doc' }).expect(201);
      await createArtifact('sheet', SHEET_CONTENT, { title: '__mtest__ Tpl Sheet' }).expect(201);
      await createArtifact('board', BOARD_CONTENT, { title: '__mtest__ Tpl Board' }).expect(201);
      await createArtifact('slide_deck', SLIDE_CONTENT, { title: '__mtest__ Tpl Slides' }).expect(201);
      await createArtifact('timeline', TIMELINE_CONTENT, { title: '__mtest__ Tpl Timeline' }).expect(201);

      const tpl = (await saveProjectTemplate({ name: '__mtest__ All Types' }).expect(201)).body.data;
      expect(tpl.artifactCount).toBe(5);

      const res = await request(app)
        .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
        .send({ name: '__mtest__ Cloned All Types' })
        .expect(201);
      const newProjectId = res.body.data.project.id;
      const clonedArtifacts = res.body.data.artifacts;

      // The new project's artifacts: one per template artifact, each cloned.
      expect(clonedArtifacts.length).toBe(5);
      const clonedTypes = clonedArtifacts.map((a: any) => a.type).sort();
      expect(clonedTypes).toEqual(['board', 'document', 'sheet', 'slide_deck', 'timeline']);

      // Each cloned artifact has fresh ids, version=1, createdByUserId set.
      for (const a of clonedArtifacts) {
        expect(a.version).toBe(1);
        expect(a.createdByUserId).not.toBeNull();
        expect(a.projectId).toBe(newProjectId);
        expect(a.companyId).toBe(companyId);
      }

      // Verify via the project-scoped artifact list endpoint.
      const listRes = await request(app)
        .get(`/api/companies/${companyId}/projects/${newProjectId}/artifacts`)
        .expect(200);
      expect(listRes.body.data.length).toBe(5);
      const listTypes = listRes.body.data.map((a: any) => a.type).sort();
      expect(listTypes).toEqual(['board', 'document', 'sheet', 'slide_deck', 'timeline']);
    });
  });

  // =========================================================================
  // Realtime events
  // =========================================================================
  describe('realtime events', () => {
    it('emits project_template.created on save', async () => {
      const events = await captureEvents(async () => {
        await saveProjectTemplate({ name: '__mtest__ Ev Tpl' }).expect(201);
      });
      const created = events.filter((e) => e.type === 'project_template.created');
      expect(created.length).toBe(1);
      expect(created[0].companyId).toBe(companyId);
    });

    it('emits artifact_template.created on save', async () => {
      const doc = (await createDoc().expect(201)).body.data;
      const events = await captureEvents(async () => {
        await saveArtifactTemplate(doc.id, { name: '__mtest__ Ev Art Tpl' }).expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact_template.created');
      expect(created.length).toBe(1);
      expect(created[0].companyId).toBe(companyId);
    });

    it('emits artifact.created for each cloned artifact on create-from-template', async () => {
      await createDoc({ title: '__mtest__ Ev Clone' }).expect(201);
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Ev Clone Src' }).expect(201)).body.data;

      const events = await captureEvents(async () => {
        await request(app)
          .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
          .send({ name: '__mtest__ Ev Clone Proj' })
          .expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact.created');
      expect(created.length).toBe(1);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('rejects create-from-template for a template in another company', async () => {
      const otherProject = (await request(app)
        .post(`/api/companies/${otherCompanyId}/projects`)
        .send({ name: 'Other Proj' })
        .expect(201)).body.data;
      const otherTpl = (await saveProjectTemplate({
        companyId: otherCompanyId,
        projectId: otherProject.id,
        name: '__mtest__ Other Co Tpl',
      }).expect(201)).body.data;

      await request(app)
        .post(`/api/companies/${companyId}/project-templates/${otherTpl.id}/create-project`)
        .send({ name: 'should fail' })
        .expect(404);
    });

    it('deleting the source project does not delete the template', async () => {
      await createDoc().expect(201);
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Src Del' }).expect(201)).body.data;

      // Hard-delete the source project row (the DELETE route archives; we
      // need a real row deletion to test the ON DELETE SET NULL behavior).
      await db.drizzle.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

      const refetched = await request(app)
        .get(`/api/companies/${companyId}/project-templates/${tpl.id}`)
        .expect(200);
      expect(refetched.body.data.id).toBe(tpl.id);
      // projectId is now null (SET NULL on delete).
      expect(refetched.body.data.projectId).toBeNull();
      // Snapshot is still intact.
      expect(refetched.body.data.snapshot.artifacts.length).toBe(1);
    });

    it('create-artifact-from-template respects project scope', async () => {
      const doc = (await createDoc({ content: DOC_CONTENT }).expect(201)).body.data;
      const tpl = (await saveArtifactTemplate(doc.id, { name: '__mtest__ Scope' }).expect(201)).body.data;

      // Create at company level (no project).
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifact-templates/${tpl.id}/create-artifact`)
        .send({ projectId: null, title: '__mtest__ Company-level clone' })
        .expect(201);
      expect(res.body.data.projectId).toBeNull();
      expect(res.body.data.companyId).toBe(companyId);
    });

    it('artifact template list filters by type', async () => {
      const doc = (await createDoc().expect(201)).body.data;
      const sheet = (await createArtifact('sheet', SHEET_CONTENT).expect(201)).body.data;
      await saveArtifactTemplate(doc.id, { name: '__mtest__ Doc Tpl' }).expect(201);
      await saveArtifactTemplate(sheet.id, { name: '__mtest__ Sheet Tpl' }).expect(201);

      const filtered = await request(app)
        .get(`/api/companies/${companyId}/artifact-templates?type=document`)
        .expect(200);
      expect(filtered.body.data.length).toBe(1);
      expect(filtered.body.data[0].type).toBe('document');
    });
  });

  // =========================================================================
  // Tech-debt fixes: concurrent idempotency, project.created event, archived
  // artifacts in snapshot
  // =========================================================================
  describe('tech-debt: concurrent idempotency retry returns existing project (200)', () => {
    it('concurrent requests with the same idempotency key do not 500', async () => {
      await createDoc({ title: '__mtest__ Concurrent Doc' }).expect(201);
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Concurrent Src' }).expect(201)).body.data;
      const key = 'concurrent-key-456';

      // Fire two concurrent create-project requests with the same key.
      // The unique constraint on project_template_clones will fire for one
      // of them. Both should return 201 with the same project (no 500).
      const [r1, r2] = await Promise.all([
        request(app)
          .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
          .send({ name: '__mtest__ Concurrent P1', idempotencyKey: key }),
        request(app)
          .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
          .send({ name: '__mtest__ Concurrent P2', idempotencyKey: key }),
      ]);

      // Both should succeed (201) — no 500 from the unique violation.
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      // Both return the same project.
      expect(r1.body.data.project.id).toBe(r2.body.data.project.id);
    });
  });

  describe('tech-debt: createProjectFromTemplate emits project.created event', () => {
    it('project.created realtime event is emitted when cloning from template', async () => {
      await createDoc({ title: '__mtest__ Event Src' }).expect(201);
      const tpl = (await saveProjectTemplate({ name: '__mtest__ Event Tpl' }).expect(201)).body.data;

      const events = await captureEvents(async () => {
        await request(app)
          .post(`/api/companies/${companyId}/project-templates/${tpl.id}/create-project`)
          .send({ name: '__mtest__ Event Proj' })
          .expect(201);
      });

      const projectCreated = events.filter((e) => e.type === 'project.created');
      expect(projectCreated.length).toBe(1);
      expect(projectCreated[0].payload.project).toBeDefined();
    });
  });

  describe('tech-debt: snapshot includes archived artifacts', () => {
    it('project template snapshot captures archived artifacts, not just active', async () => {
      const activeDoc = (await createDoc({ title: '__mtest__ Active' }).expect(201)).body.data;
      const archDoc = (await createDoc({ title: '__mtest__ To Archive' }).expect(201)).body.data;

      // Archive one artifact.
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${archDoc.id}/archive`)
        .expect(200);

      const tpl = (await saveProjectTemplate({ name: '__mtest__ Archived Tpl' }).expect(201)).body.data;

      // Snapshot should include both the active and archived artifact.
      expect(tpl.snapshot.artifacts.length).toBe(2);
      const titles = tpl.snapshot.artifacts.map((a: any) => a.title).sort();
      expect(titles).toContain('__mtest__ Active');
      expect(titles).toContain('__mtest__ To Archive');
    });
  });
});
