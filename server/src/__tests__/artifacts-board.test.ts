import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from '../services/artifact-tools.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Board artifact payloads
// ---------------------------------------------------------------------------

const BOARD_CONTENT = {
  columns: [
    { id: 'col_todo', title: 'Todo' },
    { id: 'col_doing', title: 'Doing' },
  ],
  cards: [
    { id: 'card_a', columnId: 'col_todo', title: 'Card A', order: 0 },
    { id: 'card_b', columnId: 'col_todo', title: 'Card B', order: 1 },
    { id: 'card_c', columnId: 'col_doing', title: 'Card C', order: 0 },
  ],
};

/** Board with a third column appended + the doing card moved into it. */
const BOARD_CONTENT_V2 = {
  columns: [
    { id: 'col_todo', title: 'Todo' },
    { id: 'col_doing', title: 'In Progress' },
    { id: 'col_done', title: 'Done' },
  ],
  cards: [
    { id: 'card_a', columnId: 'col_todo', title: 'Card A', order: 0 },
    { id: 'card_b', columnId: 'col_done', title: 'Card B', order: 0 },
    { id: 'card_c', columnId: 'col_doing', title: 'Card C', order: 0 },
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
// Suite — VAL-BOARD-001, 003..014 (API side) + VAL-BOARD-015 (event emission)
// ---------------------------------------------------------------------------

describe('Board artifact API — real-Postgres integration', () => {
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
      .send({ name: '__mtest__ Board Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Board Other Corp', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Board Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Board Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Board Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Board Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  /** Create a board artifact, returning the chainable supertest Test. */
  function createBoard(
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
        type: 'board',
        title: overrides.title ?? '__mtest__ Board',
        content: overrides.content ?? BOARD_CONTENT,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-BOARD-001: create a project board
  // =========================================================================

  describe('VAL-BOARD-001: create a project board', () => {
    it('creates a board at version 1 scoped to the project', async () => {
      const res = await createBoard().expect(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.type).toBe('board');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.projectId).toBe(projectId);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.content).toEqual(BOARD_CONTENT);
    });

    it('lists the board only in its own project', async () => {
      const created = await createBoard().expect(201);

      const inProject = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${projectId}`)
        .expect(200);
      expect(inProject.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);

      const inOtherProject = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${secondProjectId}`)
        .expect(200);
      expect(inOtherProject.body.data).toHaveLength(0);
    });

    it('accepts an empty board (no columns, no cards)', async () => {
      const res = await createBoard({ content: { columns: [], cards: [] } }).expect(201);
      expect(res.body.data.content).toEqual({ columns: [], cards: [] });
    });
  });

  // =========================================================================
  // VAL-BOARD-003..007: column/card mutations round-trip through the API
  // =========================================================================

  describe('VAL-BOARD-003..007: column and card mutations round-trip', () => {
    it('VAL-BOARD-003: adds a column and edits a column title with stable ids', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const next = {
        columns: [
          { id: 'col_todo', title: 'Backlog' },
          { id: 'col_doing', title: 'Doing' },
          { id: 'col_done', title: 'Done' },
        ],
        cards: BOARD_CONTENT.cards,
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      expect(patched.body.data.content.columns).toEqual(next.columns);

      // Reopening returns the same state (stable ids preserved).
      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.columns.map((c: { id: string }) => c.id)).toEqual([
        'col_todo',
        'col_doing',
        'col_done',
      ]);
      expect(reopened.body.data.content.columns[0].title).toBe('Backlog');
    });

    it('VAL-BOARD-004: preserves reordered column order', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const reordered = {
        columns: [
          { id: 'col_doing', title: 'Doing' },
          { id: 'col_todo', title: 'Todo' },
        ],
        cards: BOARD_CONTENT.cards,
      };
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: reordered, version: 1 })
        .expect(200);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.columns.map((c: { id: string }) => c.id)).toEqual([
        'col_doing',
        'col_todo',
      ]);
    });

    it('VAL-BOARD-005: adds a card with a payload and edits a card title', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const next = {
        columns: BOARD_CONTENT.columns,
        cards: [
          { id: 'card_a', columnId: 'col_todo', title: 'Card A renamed', order: 0 },
          ...BOARD_CONTENT.cards.slice(1),
          {
            id: 'card_new',
            columnId: 'col_doing',
            title: 'Brand new card',
            order: 1,
            payload: { description: 'notes', priority: 2 },
          },
        ],
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      const cards = patched.body.data.content.cards as Array<{
        id: string;
        title: string;
        columnId: string;
        payload?: Record<string, unknown>;
      }>;
      expect(cards.find((c) => c.id === 'card_a')?.title).toBe('Card A renamed');
      const added = cards.find((c) => c.id === 'card_new');
      expect(added?.columnId).toBe('col_doing');
      expect(added?.payload).toEqual({ description: 'notes', priority: 2 });
    });

    it('VAL-BOARD-006: moves a card between columns and reorders within a column', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: BOARD_CONTENT_V2, version: 1 })
        .expect(200);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      const cards = reopened.body.data.content.cards as Array<{
        id: string;
        columnId: string;
        order: number;
      }>;
      expect(cards.find((c) => c.id === 'card_b')?.columnId).toBe('col_done');
      // Cards within a column produce a deterministic visual order.
      const todo = cards.filter((c) => c.columnId === 'col_todo').sort((a, b) => a.order - b.order);
      expect(todo.map((c) => c.id)).toEqual(['card_a']);
    });

    it('VAL-BOARD-007: deletes a card', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const next = {
        columns: BOARD_CONTENT.columns,
        cards: BOARD_CONTENT.cards.filter((c) => c.id !== 'card_b'),
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);
      expect(patched.body.data.content.cards.map((c: { id: string }) => c.id)).toEqual([
        'card_a',
        'card_c',
      ]);
    });

    it('VAL-BOARD-007: deleting a column together with its cards is accepted', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const next = {
        columns: BOARD_CONTENT.columns.filter((c) => c.id !== 'col_todo'),
        cards: BOARD_CONTENT.cards.filter((c) => c.columnId !== 'col_todo'),
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);
      expect(patched.body.data.content.columns).toHaveLength(1);
      expect(patched.body.data.content.cards.map((c: { id: string }) => c.id)).toEqual(['card_c']);
    });

    it('VAL-BOARD-007: deleting a column but keeping its cards is rejected (no orphans)', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const orphaning = {
        columns: BOARD_CONTENT.columns.filter((c) => c.id !== 'col_todo'),
        cards: BOARD_CONTENT.cards,
      };
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: orphaning, version: 1 })
        .expect(400);

      const unchanged = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(unchanged.body.data.version).toBe(1);
      expect(unchanged.body.data.content).toEqual(BOARD_CONTENT);
    });
  });

  // =========================================================================
  // VAL-BOARD-008: reject invalid card column references
  // =========================================================================

  describe('VAL-BOARD-008: reject invalid card column references', () => {
    it('rejects a create whose card columnId is unknown', async () => {
      await createBoard({
        content: {
          columns: [{ id: 'col_todo', title: 'Todo' }],
          cards: [{ id: 'card_a', columnId: 'nope', title: 'Orphan', order: 0 }],
        },
      }).expect(400);

      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=board`)
        .expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    it('rejects an update with an unknown card columnId and leaves content/version/revisions untouched', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;
      const before = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            columns: BOARD_CONTENT.columns,
            cards: [...BOARD_CONTENT.cards, { id: 'card_x', columnId: 'ghost', title: 'X', order: 9 }],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(BOARD_CONTENT);

      const afterRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(afterRevs.body.data).toHaveLength(before.body.data.length);
    });
  });

  // =========================================================================
  // VAL-BOARD-009: validate board content shape
  // =========================================================================

  describe('VAL-BOARD-009: validate board content shape', () => {
    const invalidPayloads: Array<[string, unknown]> = [
      ['missing columns', { cards: [] }],
      ['missing cards', { columns: [] }],
      ['columns not an array', { columns: {}, cards: [] }],
      ['cards not an array', { columns: [], cards: 'nope' }],
      ['column missing id', { columns: [{ title: 'Todo' }], cards: [] }],
      ['column missing title', { columns: [{ id: 'col1' }], cards: [] }],
      ['column with empty id', { columns: [{ id: '', title: 'Todo' }], cards: [] }],
      [
        'duplicate column ids',
        { columns: [{ id: 'col1', title: 'A' }, { id: 'col1', title: 'B' }], cards: [] },
      ],
      [
        'card missing id',
        { columns: [{ id: 'col1', title: 'A' }], cards: [{ columnId: 'col1', title: 'C', order: 0 }] },
      ],
      [
        'card missing columnId',
        { columns: [{ id: 'col1', title: 'A' }], cards: [{ id: 'c1', title: 'C', order: 0 }] },
      ],
      [
        'card missing title',
        { columns: [{ id: 'col1', title: 'A' }], cards: [{ id: 'c1', columnId: 'col1', order: 0 }] },
      ],
      [
        'card missing order',
        { columns: [{ id: 'col1', title: 'A' }], cards: [{ id: 'c1', columnId: 'col1', title: 'C' }] },
      ],
      [
        'card order wrong type',
        {
          columns: [{ id: 'col1', title: 'A' }],
          cards: [{ id: 'c1', columnId: 'col1', title: 'C', order: 'first' }],
        },
      ],
      [
        'duplicate card ids',
        {
          columns: [{ id: 'col1', title: 'A' }],
          cards: [
            { id: 'c1', columnId: 'col1', title: 'C', order: 0 },
            { id: 'c1', columnId: 'col1', title: 'D', order: 1 },
          ],
        },
      ],
      ['document content under the board type', { format: 'markdown', body: '# nope' }],
    ];

    for (const [label, content] of invalidPayloads) {
      it(`rejects ${label} with 400`, async () => {
        const res = await createBoard({ content }).expect(400);
        expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
      });
    }

    it('does not silently drop columns or cards on a valid save', async () => {
      const created = await createBoard().expect(201);
      expect(created.body.data.content.columns).toHaveLength(BOARD_CONTENT.columns.length);
      expect(created.body.data.content.cards).toHaveLength(BOARD_CONTENT.cards.length);
      expect(created.body.data.content).toEqual(BOARD_CONTENT);
    });
  });

  // =========================================================================
  // VAL-BOARD-010: version every board edit
  // =========================================================================

  describe('VAL-BOARD-010: version every board edit', () => {
    it('increments version once per save and appends exactly one revision with editSource=user', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const initialRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(initialRevs.body.data).toHaveLength(1);
      expect(initialRevs.body.data[0].version).toBe(1);
      expect(initialRevs.body.data[0].editSource).toBe('user');
      expect(initialRevs.body.data[0].content).toEqual(BOARD_CONTENT);

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: BOARD_CONTENT_V2, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
      expect(revs.body.data[1].version).toBe(2);
      expect(revs.body.data[1].editSource).toBe('user');
      // Revisions carry the complete board snapshot, not a diff.
      expect(revs.body.data[1].content).toEqual(BOARD_CONTENT_V2);
    });

    it('does not increment version or add a revision on a failed validation', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { columns: [], cards: [{ id: 'x', columnId: 'gone', title: 'X', order: 0 }] }, version: 1 })
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
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: BOARD_CONTENT_V2, version: 1 })
        .expect(200);

      const stale = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: BOARD_CONTENT, version: 1 })
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
  // VAL-BOARD-011: board CRUD + restore follow the artifact contract
  // =========================================================================

  describe('VAL-BOARD-011: board CRUD and restore follow the artifact contract', () => {
    it('supports get, list, update, archive, and soft-delete', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${companyId}/artifacts/${id}`).expect(200);

      const listed = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=board`)
        .expect(200);
      expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(id);

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ title: '__mtest__ Board renamed', version: 1 })
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
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: BOARD_CONTENT_V2, version: 1 })
        .expect(200);

      const restored = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restored.body.data.version).toBe(3);
      expect(restored.body.data.content).toEqual(BOARD_CONTENT);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3]);
      // History is append-only: the earlier snapshots are untouched.
      expect(revs.body.data[0].content).toEqual(BOARD_CONTENT);
      expect(revs.body.data[1].content).toEqual(BOARD_CONTENT_V2);
    });

    it('retrieves a single board revision by version', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;
      const rev = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/1`)
        .expect(200);
      expect(rev.body.data.version).toBe(1);
      expect(rev.body.data.content).toEqual(BOARD_CONTENT);
    });
  });

  // =========================================================================
  // VAL-BOARD-012 / VAL-BOARD-013: agent authoring + agent revision source
  // =========================================================================

  describe('VAL-BOARD-012/013: agent authoring', () => {
    it('VAL-BOARD-012: an agent tool call creates a project-scoped board attributed to the agent', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        { type: 'board', title: '__mtest__ Agent Board', content: BOARD_CONTENT, projectId },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      const artifactId = result.data?.artifactId as string;
      expect(artifactId).toBeTruthy();

      const created = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);
      expect(created.body.data.type).toBe('board');
      expect(created.body.data.version).toBe(1);
      expect(created.body.data.projectId).toBe(projectId);
      expect(created.body.data.createdByAgentId).toBe(agentId);
      expect(created.body.data.createdByUserId).toBeNull();
      // At least two columns with cards assigned to them.
      expect(created.body.data.content.columns.length).toBeGreaterThanOrEqual(2);
      const columnIds = new Set(
        (created.body.data.content.columns as Array<{ id: string }>).map((c) => c.id),
      );
      for (const card of created.body.data.content.cards as Array<{ columnId: string }>) {
        expect(columnIds.has(card.columnId)).toBe(true);
      }

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
      expect(revs.body.data[0].editedByAgentId).toBe(agentId);
    });

    it('VAL-BOARD-012: the agent tool rejects a board with an orphan card', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'board',
          title: '__mtest__ Bad Agent Board',
          content: {
            columns: [{ id: 'col1', title: 'Todo' }],
            cards: [{ id: 'c1', columnId: 'ghost', title: 'X', order: 0 }],
          },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });

    it('VAL-BOARD-013: an agent update bumps the version and records editSource=agent', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.update',
        { artifactId: id, version: 1, content: BOARD_CONTENT_V2, message: 'agent reorganized the board' },
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
      expect(agentRev.content).toEqual(BOARD_CONTENT_V2);
    });

    it('VAL-BOARD-013: an agent-authored board via the X-Eidolon-Agent-Id header records agent source', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'board', title: '__mtest__ Header Board', content: BOARD_CONTENT, projectId })
        .expect(201);
      expect(res.body.data.createdByAgentId).toBe(agentId);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
    });
  });

  // =========================================================================
  // VAL-BOARD-014: project + company isolation
  // =========================================================================

  describe('VAL-BOARD-014: board project and company isolation', () => {
    it('does not return a board from another company', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);

      const otherList = await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts?type=board`)
        .expect(200);
      expect(otherList.body.data).toHaveLength(0);
    });

    it('does not allow update, delete, or archive of a board through another company', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .send({ content: BOARD_CONTENT_V2, version: 1 })
        .expect(404);
      await request(app).delete(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);
      await request(app).post(`/api/companies/${otherCompanyId}/artifacts/${id}/archive`).expect(404);

      const untouched = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(untouched.body.data.version).toBe(1);
      expect(untouched.body.data.status).toBe('active');
    });

    it('cannot create a board scoped to a project in another company', async () => {
      await createBoard({ projectId: otherProjectId }).expect(404);
    });

    it('a project-scoped list returns only that project boards', async () => {
      const inProject = await createBoard({ title: '__mtest__ Board P1' }).expect(201);
      const inSecond = await createBoard({
        title: '__mtest__ Board P2',
        projectId: secondProjectId,
      }).expect(201);
      const unscoped = await createBoard({ title: '__mtest__ Board none', projectId: null }).expect(201);

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
  // VAL-BOARD-015: realtime events for board create/update
  // =========================================================================

  describe('VAL-BOARD-015: board realtime events', () => {
    it('emits artifact.created + artifact.revision.created on board create', async () => {
      const events = await captureEvents(async () => {
        await createBoard().expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact.created');
      expect(created).toHaveLength(1);
      expect(created[0].companyId).toBe(companyId);
      expect(
        (created[0].payload as { artifact: { type: string } }).artifact.type,
      ).toBe('board');
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.updated on board update and none on a rejected update', async () => {
      const created = await createBoard().expect(201);
      const id = created.body.data.id;

      const okEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: BOARD_CONTENT_V2, version: 1 })
          .expect(200);
      });
      expect(okEvents.filter((e) => e.type === 'artifact.updated')).toHaveLength(1);

      const badEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({
            content: { columns: [], cards: [{ id: 'x', columnId: 'gone', title: 'X', order: 0 }] },
            version: 2,
          })
          .expect(400);
      });
      expect(badEvents.filter((e) => e.type.startsWith('artifact.'))).toHaveLength(0);
    });
  });

  // =========================================================================
  // VAL-CROSS-006: Doc + Sheet + Board coexist in one project
  // =========================================================================

  describe('VAL-CROSS-006: multi-artifact project', () => {
    it('lists a doc, a sheet, and a board together with their own types', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Multi Doc',
          content: { format: 'markdown', body: '# Multi' },
          projectId,
        })
        .expect(201);
      await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'sheet',
          title: '__mtest__ Multi Sheet',
          content: {
            columns: [{ id: 'c1', key: 'name' }],
            rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
          },
          projectId,
        })
        .expect(201);
      await createBoard({ title: '__mtest__ Multi Board' }).expect(201);

      const list = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${projectId}`)
        .expect(200);
      expect(list.body.data).toHaveLength(3);
      expect(new Set(list.body.data.map((a: { type: string }) => a.type))).toEqual(
        new Set(['document', 'sheet', 'board']),
      );
      const board = list.body.data.find((a: { type: string }) => a.type === 'board');
      expect(board.title).toBe('__mtest__ Multi Board');
      expect(board.content.columns).toHaveLength(2);
    });
  });
});
