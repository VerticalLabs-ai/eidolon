import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from '../services/artifact-tools.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Slide deck artifact payloads
// ---------------------------------------------------------------------------

const SLIDE_CONTENT = {
  slides: [
    {
      id: 'slide_1',
      layout: 'title',
      blocks: [{ type: 'heading', content: { text: 'Deck Title' } }],
    },
    {
      id: 'slide_2',
      layout: 'content',
      blocks: [
        { type: 'text', content: { text: 'Bullet point one' } },
        { type: 'text', content: { text: 'Bullet point two' } },
      ],
    },
  ],
};

/** Deck with a third slide inserted and slide 2 layout changed. */
const SLIDE_CONTENT_V2 = {
  slides: [
    {
      id: 'slide_1',
      layout: 'title',
      blocks: [{ type: 'heading', content: { text: 'Updated Title' } }],
    },
    {
      id: 'slide_2',
      layout: 'split',
      blocks: [
        { type: 'text', content: { text: 'Left' } },
        { type: 'image', content: { url: 'https://example.com/x.png' } },
      ],
    },
    {
      id: 'slide_3',
      layout: 'content',
      blocks: [{ type: 'text', content: { text: 'New slide' } }],
    },
  ],
};

/** Collect EventBus events emitted during an async operation. */
async function captureEvents(fn: () => Promise<void>): Promise<EidolonEvent[]> {
  const events: EidolonEvent[] = [];
  const handler = (event: EidolonEvent) => events.push(event);
  eventBus.onEvent(handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Suite — VAL-SLIDE-001, 006..011 (API side) + VAL-SLIDE-012 (event emission)
// ---------------------------------------------------------------------------

describe('Slide deck artifact API — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let secondProjectId: string;
  let otherProjectId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Slides Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Slides Other Corp', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Slides Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Slides Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Slides Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Slides Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  /** Create a slide_deck artifact, returning the chainable supertest Test. */
  function createDeck(
    overrides: {
      companyId?: string;
      projectId?: string | null;
      title?: string;
      content?: unknown;
    } = {},
  ) {
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send({
        type: 'slide_deck',
        title: overrides.title ?? '__mtest__ Slides',
        content: overrides.content ?? SLIDE_CONTENT,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-SLIDE-001: create a slide deck artifact
  // =========================================================================

  describe('VAL-SLIDE-001: create a slide deck artifact', () => {
    it('creates a deck at version 1 scoped to the project', async () => {
      const res = await createDeck().expect(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.type).toBe('slide_deck');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.projectId).toBe(projectId);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.content).toEqual(SLIDE_CONTENT);
    });

    it('lists the deck only in its own project', async () => {
      const created = await createDeck().expect(201);

      const inProject = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${projectId}`)
        .expect(200);
      expect(inProject.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);

      const inOtherProject = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${secondProjectId}`)
        .expect(200);
      expect(inOtherProject.body.data).toHaveLength(0);
    });

    it('accepts an empty deck (no slides)', async () => {
      const res = await createDeck({ content: { slides: [] } }).expect(201);
      expect(res.body.data.content).toEqual({ slides: [] });
    });
  });

  // =========================================================================
  // VAL-SLIDE-003..005: slide mutations round-trip through the API
  // =========================================================================

  describe('VAL-SLIDE-003..005: slide mutations round-trip', () => {
    it('VAL-SLIDE-003: adds a slide and preserves stable ids and order', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      const next = {
        slides: [
          ...SLIDE_CONTENT.slides,
          { id: 'slide_3', layout: 'content', blocks: [{ type: 'text', content: { text: 'New' } }] },
        ],
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      expect(patched.body.data.content.slides.map((s: { id: string }) => s.id)).toEqual([
        'slide_1',
        'slide_2',
        'slide_3',
      ]);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.slides.map((s: { id: string }) => s.id)).toEqual([
        'slide_1',
        'slide_2',
        'slide_3',
      ]);
    });

    it('VAL-SLIDE-003: reorders slides and preserves the new order after reopen', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      const reordered = {
        slides: [SLIDE_CONTENT.slides[1], SLIDE_CONTENT.slides[0]],
      };
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: reordered, version: 1 })
        .expect(200);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.slides.map((s: { id: string }) => s.id)).toEqual([
        'slide_2',
        'slide_1',
      ]);
    });

    it('VAL-SLIDE-004: edits per-slide layout and blocks independently', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      // Change only slide_2's layout and blocks; slide_1 stays the same.
      const next = {
        slides: [
          SLIDE_CONTENT.slides[0],
          {
            id: 'slide_2',
            layout: 'split',
            blocks: [{ type: 'image', content: { url: 'https://example.com/p.png' } }],
          },
        ],
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      const slides = patched.body.data.content.slides;
      // slide_1 unchanged
      expect(slides[0].layout).toBe('title');
      expect(slides[0].blocks).toEqual(SLIDE_CONTENT.slides[0].blocks);
      // slide_2 changed
      expect(slides[1].layout).toBe('split');
      expect(slides[1].blocks[0].type).toBe('image');
    });

    it('VAL-SLIDE-004: changing one slide does not change another slide', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      const next = {
        slides: [
          {
            id: 'slide_1',
            layout: 'blank',
            blocks: [{ type: 'text', content: { text: 'changed' } }],
          },
          SLIDE_CONTENT.slides[1], // unchanged
        ],
      };
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      // slide_2 still has its original layout + blocks
      expect(reopened.body.data.content.slides[1].layout).toBe('content');
      expect(reopened.body.data.content.slides[1].blocks).toEqual(SLIDE_CONTENT.slides[1].blocks);
    });

    it('VAL-SLIDE-005: deletes a slide and remaining slides are preserved', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      const next = {
        slides: SLIDE_CONTENT.slides.filter((s) => s.id !== 'slide_1'),
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);
      expect(patched.body.data.content.slides.map((s: { id: string }) => s.id)).toEqual(['slide_2']);
    });
  });

  // =========================================================================
  // VAL-SLIDE-006: validate slide deck content shape
  // =========================================================================

  describe('VAL-SLIDE-006: validate slide deck content shape', () => {
    const invalidPayloads: Array<[string, unknown]> = [
      ['missing slides', { notSlides: [] }],
      ['slides not an array', { slides: {} }],
      ['slide missing id', { slides: [{ layout: 'title', blocks: [] }] }],
      ['slide with empty id', { slides: [{ id: '', layout: 'title', blocks: [] }] }],
      ['slide missing layout', { slides: [{ id: 's1', blocks: [] }] }],
      ['slide with empty layout', { slides: [{ id: 's1', layout: '', blocks: [] }] }],
      ['slide missing blocks', { slides: [{ id: 's1', layout: 'title' }] }],
      ['blocks not an array', { slides: [{ id: 's1', layout: 'title', blocks: 'nope' }] }],
      ['block missing type', { slides: [{ id: 's1', layout: 'title', blocks: [{ content: { text: 'x' } }] }] }],
      ['block with empty type', { slides: [{ id: 's1', layout: 'title', blocks: [{ type: '', content: {} }] }] }],
      ['block missing content', { slides: [{ id: 's1', layout: 'title', blocks: [{ type: 'text' }] }] }],
      [
        'duplicate slide ids',
        {
          slides: [
            { id: 's1', layout: 'title', blocks: [] },
            { id: 's1', layout: 'content', blocks: [] },
          ],
        },
      ],
      ['document content under the slide_deck type', { format: 'markdown', body: '# nope' }],
    ];

    for (const [label, content] of invalidPayloads) {
      it(`rejects ${label} with 400`, async () => {
        const res = await createDeck({ content }).expect(400);
        expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
      });
    }

    it('does not silently drop slides or blocks on a valid save', async () => {
      const created = await createDeck().expect(201);
      expect(created.body.data.content.slides).toHaveLength(SLIDE_CONTENT.slides.length);
      expect(created.body.data.content).toEqual(SLIDE_CONTENT);
    });

    it('rejects an update with invalid content and leaves content/version/revisions untouched', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;
      const before = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: { slides: [{ id: 's1', layout: '', blocks: [] }] },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(SLIDE_CONTENT);

      const afterRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(afterRevs.body.data).toHaveLength(before.body.data.length);
    });
  });

  // =========================================================================
  // VAL-SLIDE-007: version every deck edit
  // =========================================================================

  describe('VAL-SLIDE-007: version every deck edit', () => {
    it('increments version once per save and appends exactly one revision with editSource=user', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      const initialRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(initialRevs.body.data).toHaveLength(1);
      expect(initialRevs.body.data[0].version).toBe(1);
      expect(initialRevs.body.data[0].editSource).toBe('user');
      expect(initialRevs.body.data[0].content).toEqual(SLIDE_CONTENT);

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: SLIDE_CONTENT_V2, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
      expect(revs.body.data[1].version).toBe(2);
      expect(revs.body.data[1].editSource).toBe('user');
      expect(revs.body.data[1].content).toEqual(SLIDE_CONTENT_V2);
    });

    it('does not increment version or add a revision on a failed validation', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: { slides: [{ id: 's1', layout: 'title', blocks: [{ type: 'text' }] }] },
          version: 1,
        })
        .expect(400);

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(1);
    });

    it('does not increment version or add a revision on a stale optimistic version', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: SLIDE_CONTENT_V2, version: 1 })
        .expect(200);

      const stale = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: SLIDE_CONTENT, version: 1 })
        .expect(409);
      expect(stale.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      expect(stale.body.details.current.version).toBe(2);

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(2);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
    });
  });

  // =========================================================================
  // VAL-SLIDE-008: slide CRUD + restore follow the artifact contract
  // =========================================================================

  describe('VAL-SLIDE-008: slide CRUD and restore follow the artifact contract', () => {
    it('supports get, list, update, archive, and soft-delete', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${companyId}/artifacts/${id}`).expect(200);

      const listed = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=slide_deck`)
        .expect(200);
      expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(id);

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ title: '__mtest__ Slides renamed', version: 1 })
        .expect(200);

      const archived = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/archive`)
        .expect(200);
      expect(archived.body.data.status).toBe('archived');

      await request(app).post(`/api/companies/${companyId}/artifacts/${id}/restore`).expect(200);

      const deleted = await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(deleted.body.data.status).toBe('deleted');
      expect(deleted.body.data.deletedAt).toBeTruthy();
    });

    it('restores a revision as a new append-only version', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: SLIDE_CONTENT_V2, version: 1 })
        .expect(200);

      const restored = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restored.body.data.version).toBe(3);
      expect(restored.body.data.content).toEqual(SLIDE_CONTENT);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3]);
      expect(revs.body.data[0].content).toEqual(SLIDE_CONTENT);
      expect(revs.body.data[1].content).toEqual(SLIDE_CONTENT_V2);
    });

    it('retrieves a single deck revision by version', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;
      const rev = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/1`)
        .expect(200);
      expect(rev.body.data.version).toBe(1);
      expect(rev.body.data.content).toEqual(SLIDE_CONTENT);
    });
  });

  // =========================================================================
  // VAL-SLIDE-009 / VAL-SLIDE-010: agent authoring + agent revision source
  // =========================================================================

  describe('VAL-SLIDE-009/010: agent authoring', () => {
    it('VAL-SLIDE-009: an agent tool call creates a project-scoped deck attributed to the agent', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        { type: 'slide_deck', title: '__mtest__ Agent Deck', content: SLIDE_CONTENT, projectId },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      const artifactId = result.data?.artifactId as string;
      expect(artifactId).toBeTruthy();

      const created = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);
      expect(created.body.data.type).toBe('slide_deck');
      expect(created.body.data.version).toBe(1);
      expect(created.body.data.projectId).toBe(projectId);
      expect(created.body.data.createdByAgentId).toBe(agentId);
      expect(created.body.data.createdByUserId).toBeNull();
      // Multiple slides, each with a layout and at least one block.
      expect(created.body.data.content.slides.length).toBeGreaterThanOrEqual(2);
      for (const slide of created.body.data.content.slides as Array<{
        id: string;
        layout: string;
        blocks: Array<{ type: string }>;
      }>) {
        expect(slide.layout.length).toBeGreaterThan(0);
        expect(slide.blocks.length).toBeGreaterThanOrEqual(1);
      }

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
      expect(revs.body.data[0].editedByAgentId).toBe(agentId);
    });

    it('VAL-SLIDE-009: the agent tool rejects a deck with duplicate slide ids', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'slide_deck',
          title: '__mtest__ Bad Agent Deck',
          content: {
            slides: [
              { id: 's1', layout: 'title', blocks: [] },
              { id: 's1', layout: 'content', blocks: [] },
            ],
          },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });

    it('VAL-SLIDE-010: an agent update bumps the version and records editSource=agent', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.update',
        { artifactId: id, version: 1, content: SLIDE_CONTENT_V2, message: 'agent edited the deck' },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      expect(result.data?.version).toBe(2);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const agentRev = revs.body.data[1];
      expect(agentRev.version).toBe(2);
      expect(agentRev.editSource).toBe('agent');
      expect(agentRev.editedByAgentId).toBe(agentId);
      expect(agentRev.editedByUserId).toBeNull();
      expect(agentRev.content).toEqual(SLIDE_CONTENT_V2);
    });

    it('VAL-SLIDE-010: an agent-authored deck via the X-Eidolon-Agent-Id header records agent source', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'slide_deck', title: '__mtest__ Header Deck', content: SLIDE_CONTENT, projectId })
        .expect(201);
      expect(res.body.data.createdByAgentId).toBe(agentId);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
    });
  });

  // =========================================================================
  // VAL-SLIDE-011: project + company isolation
  // =========================================================================

  describe('VAL-SLIDE-011: slide project and company isolation', () => {
    it('does not return a deck from another company', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);

      const otherList = await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts?type=slide_deck`)
        .expect(200);
      expect(otherList.body.data).toHaveLength(0);
    });

    it('does not allow update, delete, or archive of a deck through another company', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .send({ content: SLIDE_CONTENT_V2, version: 1 })
        .expect(404);
      await request(app).delete(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);
      await request(app).post(`/api/companies/${otherCompanyId}/artifacts/${id}/archive`).expect(404);

      const untouched = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(untouched.body.data.version).toBe(1);
      expect(untouched.body.data.status).toBe('active');
    });

    it('cannot create a deck scoped to a project in another company', async () => {
      await createDeck({ projectId: otherProjectId }).expect(404);
    });

    it('a project-scoped list returns only that project decks', async () => {
      const inProject = await createDeck({ title: '__mtest__ Deck P1' }).expect(201);
      const inSecond = await createDeck({
        title: '__mtest__ Deck P2',
        projectId: secondProjectId,
      }).expect(201);
      const unscoped = await createDeck({ title: '__mtest__ Deck none', projectId: null }).expect(201);

      const p1 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);
      const p1Ids = p1.body.data.map((a: { id: string }) => a.id);
      expect(p1Ids).toContain(inProject.body.data.id);
      expect(p1Ids).not.toContain(inSecond.body.data.id);
      expect(p1Ids).not.toContain(unscoped.body.data.id);
    });
  });

  // =========================================================================
  // VAL-SLIDE-012: realtime events for deck create/update
  // =========================================================================

  describe('VAL-SLIDE-012: slide deck realtime events', () => {
    it('emits artifact.created + artifact.revision.created on deck create', async () => {
      const events = await captureEvents(async () => {
        await createDeck().expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact.created');
      expect(created).toHaveLength(1);
      expect(created[0].companyId).toBe(companyId);
      expect(
        (created[0].payload as { artifact: { type: string } }).artifact.type,
      ).toBe('slide_deck');
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.updated on deck update and none on a rejected update', async () => {
      const created = await createDeck().expect(201);
      const id = created.body.data.id;

      const okEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: SLIDE_CONTENT_V2, version: 1 })
          .expect(200);
      });
      expect(okEvents.filter((e) => e.type === 'artifact.updated')).toHaveLength(1);

      const badEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({
            content: { slides: [{ id: 's1', layout: '', blocks: [] }] },
            version: 2,
          })
          .expect(400);
      });
      expect(badEvents.filter((e) => e.type.startsWith('artifact.'))).toHaveLength(0);
    });
  });
});
