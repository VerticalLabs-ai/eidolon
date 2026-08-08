import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from '../services/artifact-tools.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Timeline artifact payloads
// ---------------------------------------------------------------------------

const TIMELINE_CONTENT = {
  tasks: [
    {
      id: 'task_1',
      title: 'Planning',
      start: '2026-01-01',
      end: '2026-01-10',
      progress: 50,
    },
    {
      id: 'task_2',
      title: 'Development',
      start: '2026-01-10',
      end: '2026-01-25',
      dependsOn: ['task_1'],
      progress: 0,
    },
    {
      id: 'task_3',
      title: 'Testing',
      start: '2026-01-25',
      end: '2026-02-01',
      dependsOn: ['task_2'],
      progress: 0,
    },
  ],
};

/** Timeline with updated progress values and a new task. */
const TIMELINE_CONTENT_V2 = {
  tasks: [
    { id: 'task_1', title: 'Planning', start: '2026-01-01', end: '2026-01-10', progress: 100 },
    { id: 'task_2', title: 'Development', start: '2026-01-10', end: '2026-01-25', dependsOn: ['task_1'], progress: 60 },
    { id: 'task_3', title: 'Testing', start: '2026-01-25', end: '2026-02-01', dependsOn: ['task_2'], progress: 0 },
    { id: 'task_4', title: 'Deployment', start: '2026-02-01', end: '2026-02-05', dependsOn: ['task_3'], progress: 0 },
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
// Suite — VAL-TIMELINE-001, 004..011, 013 (API side) + VAL-TIMELINE-012/014 (events)
// ---------------------------------------------------------------------------

describe('Timeline artifact API — real-Postgres integration', () => {
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
      .send({ name: '__mtest__ Timeline Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Timeline Other Corp', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Timeline Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Timeline Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Timeline Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Timeline Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  /** Create a timeline artifact, returning the chainable supertest Test. */
  function createTimeline(
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
        type: 'timeline',
        title: overrides.title ?? '__mtest__ Timeline',
        content: overrides.content ?? TIMELINE_CONTENT,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-TIMELINE-001: create a timeline artifact
  // =========================================================================

  describe('VAL-TIMELINE-001: create a timeline artifact', () => {
    it('creates a timeline at version 1 scoped to the project', async () => {
      const res = await createTimeline().expect(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.type).toBe('timeline');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.projectId).toBe(projectId);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.content).toEqual(TIMELINE_CONTENT);
    });

    it('lists the timeline only in its own project', async () => {
      const created = await createTimeline().expect(201);

      const inProject = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${projectId}`)
        .expect(200);
      expect(inProject.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);

      const inOtherProject = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${secondProjectId}`)
        .expect(200);
      expect(inOtherProject.body.data).toHaveLength(0);
    });

    it('accepts an empty timeline (no tasks)', async () => {
      const res = await createTimeline({ content: { tasks: [] } }).expect(201);
      expect(res.body.data.content).toEqual({ tasks: [] });
    });
  });

  // =========================================================================
  // VAL-TIMELINE-003: task mutations round-trip through the API
  // =========================================================================

  describe('VAL-TIMELINE-003: task mutations round-trip', () => {
    it('adds a task and preserves stable ids and values', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const next = {
        tasks: [
          ...TIMELINE_CONTENT.tasks,
          { id: 'task_4', title: 'Deployment', start: '2026-02-01', end: '2026-02-05', dependsOn: ['task_3'], progress: 0 },
        ],
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      expect(patched.body.data.content.tasks.map((t: { id: string }) => t.id)).toEqual([
        'task_1', 'task_2', 'task_3', 'task_4',
      ]);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.tasks.map((t: { id: string }) => t.id)).toEqual([
        'task_1', 'task_2', 'task_3', 'task_4',
      ]);
    });

    it('edits a task title and progress', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const next = {
        tasks: [
          { id: 'task_1', title: 'Planning Phase', start: '2026-01-01', end: '2026-01-10', progress: 75 },
          ...TIMELINE_CONTENT.tasks.slice(1),
        ],
      };
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.tasks[0].title).toBe('Planning Phase');
      expect(reopened.body.data.content.tasks[0].progress).toBe(75);
    });

    it('deletes a task and leaves no dangling dependencies', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      // Delete task_2, which task_3 depends on — the dependency must be cleaned
      const next = {
        tasks: [
          { id: 'task_1', title: 'Planning', start: '2026-01-01', end: '2026-01-10', progress: 50 },
          { id: 'task_3', title: 'Testing', start: '2026-01-25', end: '2026-02-01', progress: 0 },
        ],
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: next, version: 1 })
        .expect(200);

      // task_3 no longer has dependsOn referencing the deleted task_2
      const task3 = patched.body.data.content.tasks.find((t: { id: string }) => t.id === 'task_3');
      expect(task3.dependsOn ?? []).not.toContain('task_2');
    });
  });

  // =========================================================================
  // VAL-TIMELINE-004: validate task dates (end >= start)
  // =========================================================================

  describe('VAL-TIMELINE-004: validate task dates', () => {
    it('rejects an unparsable start date with 400 and a per-task field-level path', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'Bad', start: 'not-a-date', end: '2026-01-10', progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects an unparsable end date with 400 and a per-task field-level path', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'Bad', start: '2026-01-01', end: 'also-bad', progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects both unparsable start and end with 400', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'Bad', start: 'garbage', end: 'trash', progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects an update with unparsable dates and leaves content/version untouched', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: { tasks: [{ id: 'task_1', title: 'Planning', start: 'not-a-date', end: '2026-01-10', progress: 50 }] },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(TIMELINE_CONTENT);
    });

    it('rejects a task with end before start with 400', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'Bad', start: '2026-02-01', end: '2026-01-01', progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('accepts equal start and end (zero-duration tasks)', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'Milestone', start: '2026-01-15', end: '2026-01-15', progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(201);
      expect(res.body.data.content.tasks[0].start).toBe('2026-01-15');
      expect(res.body.data.content.tasks[0].end).toBe('2026-01-15');
    });

    it('rejects an update with end before start and leaves content/version/revisions untouched', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: { tasks: [{ id: 'task_1', title: 'Planning', start: '2026-02-01', end: '2026-01-01', progress: 50 }] },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(TIMELINE_CONTENT);
    });
  });

  // =========================================================================
  // VAL-TIMELINE-005: reject dependency cycles
  // =========================================================================

  describe('VAL-TIMELINE-005: reject dependency cycles', () => {
    it('rejects a direct cycle (A depends on B, B depends on A) with 400', async () => {
      const content = {
        tasks: [
          { id: 'a', title: 'A', start: '2026-01-01', end: '2026-01-05', dependsOn: ['b'], progress: 0 },
          { id: 'b', title: 'B', start: '2026-01-01', end: '2026-01-05', dependsOn: ['a'], progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects an indirect cycle (A→B→C→A) with 400', async () => {
      const content = {
        tasks: [
          { id: 'a', title: 'A', start: '2026-01-01', end: '2026-01-05', dependsOn: ['c'], progress: 0 },
          { id: 'b', title: 'B', start: '2026-01-01', end: '2026-01-05', dependsOn: ['a'], progress: 0 },
          { id: 'c', title: 'C', start: '2026-01-01', end: '2026-01-05', dependsOn: ['b'], progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a self-dependency (A depends on A) with 400', async () => {
      const content = {
        tasks: [
          { id: 'a', title: 'A', start: '2026-01-01', end: '2026-01-05', dependsOn: ['a'], progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('does not increment version or add a revision on a rejected cycle', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const cyclicContent = {
        tasks: [
          { id: 'task_1', title: 'Planning', start: '2026-01-01', end: '2026-01-10', dependsOn: ['task_2'], progress: 50 },
          { id: 'task_2', title: 'Dev', start: '2026-01-10', end: '2026-01-25', dependsOn: ['task_1'], progress: 0 },
        ],
      };
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: cyclicContent, version: 1 })
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
  });

  // =========================================================================
  // VAL-TIMELINE-006: validate dependency references and progress
  // =========================================================================

  describe('VAL-TIMELINE-006: validate dependency references and progress', () => {
    it('rejects a dependency referring to a nonexistent task id with 400', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'A', start: '2026-01-01', end: '2026-01-05', dependsOn: ['nonexistent'], progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects duplicate task ids with 400', async () => {
      const content = {
        tasks: [
          { id: 'dup', title: 'A', start: '2026-01-01', end: '2026-01-05', progress: 0 },
          { id: 'dup', title: 'B', start: '2026-01-01', end: '2026-01-05', progress: 0 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects progress > 100 with 400', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'A', start: '2026-01-01', end: '2026-01-05', progress: 150 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects progress < 0 with 400', async () => {
      const content = {
        tasks: [
          { id: 't1', title: 'A', start: '2026-01-01', end: '2026-01-05', progress: -10 },
        ],
      };
      const res = await createTimeline({ content }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects malformed content (missing tasks, tasks not an array, task missing id/title/start/end)', async () => {
      const invalidPayloads: Array<[string, unknown]> = [
        ['missing tasks', { notTasks: [] }],
        ['tasks not an array', { tasks: {} }],
        ['task missing id', { tasks: [{ title: 'A', start: '2026-01-01', end: '2026-01-05' }] }],
        ['task empty id', { tasks: [{ id: '', title: 'A', start: '2026-01-01', end: '2026-01-05' }] }],
        ['task missing title', { tasks: [{ id: 't1', start: '2026-01-01', end: '2026-01-05' }] }],
        ['task missing start', { tasks: [{ id: 't1', title: 'A', end: '2026-01-05' }] }],
        ['task missing end', { tasks: [{ id: 't1', title: 'A', start: '2026-01-01' }] }],
        ['dependsOn not an array', { tasks: [{ id: 't1', title: 'A', start: '2026-01-01', end: '2026-01-05', dependsOn: 't2' }] }],
        ['document content under timeline type', { format: 'markdown', body: '# nope' }],
      ];
      for (const [, content] of invalidPayloads) {
        const res = await createTimeline({ content }).expect(400);
        expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
      }
    });

    it('existing valid timeline state remains unchanged after a rejected update', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: { tasks: [{ id: 't1', title: 'A', start: '2026-01-01', end: '2026-01-05', dependsOn: ['ghost'], progress: 0 }] },
          version: 1,
        })
        .expect(400);

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(TIMELINE_CONTENT);
    });
  });

  // =========================================================================
  // VAL-TIMELINE-009: version every timeline edit
  // =========================================================================

  describe('VAL-TIMELINE-009: version every timeline edit', () => {
    it('increments version once per save and appends exactly one revision with editSource=user', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const initialRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(initialRevs.body.data).toHaveLength(1);
      expect(initialRevs.body.data[0].version).toBe(1);
      expect(initialRevs.body.data[0].editSource).toBe('user');
      expect(initialRevs.body.data[0].content).toEqual(TIMELINE_CONTENT);

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: TIMELINE_CONTENT_V2, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
      expect(revs.body.data[1].version).toBe(2);
      expect(revs.body.data[1].editSource).toBe('user');
      expect(revs.body.data[1].content).toEqual(TIMELINE_CONTENT_V2);
    });

    it('does not increment version or add a revision on a failed validation', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: { tasks: [{ id: 't1', title: 'A', start: '2026-02-01', end: '2026-01-01', progress: 0 }] },
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
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: TIMELINE_CONTENT_V2, version: 1 })
        .expect(200);

      const stale = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: TIMELINE_CONTENT, version: 1 })
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
  // VAL-TIMELINE-010: timeline CRUD + restore follow the artifact contract
  // =========================================================================

  describe('VAL-TIMELINE-010: timeline CRUD and restore follow the artifact contract', () => {
    it('supports get, list, update, archive, and soft-delete', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${companyId}/artifacts/${id}`).expect(200);

      const listed = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=timeline`)
        .expect(200);
      expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(id);

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ title: '__mtest__ Timeline renamed', version: 1 })
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
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: TIMELINE_CONTENT_V2, version: 1 })
        .expect(200);

      const restored = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restored.body.data.version).toBe(3);
      expect(restored.body.data.content).toEqual(TIMELINE_CONTENT);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3]);
      expect(revs.body.data[0].content).toEqual(TIMELINE_CONTENT);
      expect(revs.body.data[1].content).toEqual(TIMELINE_CONTENT_V2);
    });

    it('retrieves a single timeline revision by version', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;
      const rev = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/1`)
        .expect(200);
      expect(rev.body.data.version).toBe(1);
      expect(rev.body.data.content).toEqual(TIMELINE_CONTENT);
    });
  });

  // =========================================================================
  // VAL-TIMELINE-011 / VAL-TIMELINE-012: agent authoring + agent revision source
  // =========================================================================

  describe('VAL-TIMELINE-011/012: agent authoring', () => {
    it('VAL-TIMELINE-011: an agent tool call creates a project-scoped timeline attributed to the agent', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        { type: 'timeline', title: '__mtest__ Agent Timeline', content: TIMELINE_CONTENT, projectId },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      const artifactId = result.data?.artifactId as string;
      expect(artifactId).toBeTruthy();

      const created = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);
      expect(created.body.data.type).toBe('timeline');
      expect(created.body.data.version).toBe(1);
      expect(created.body.data.projectId).toBe(projectId);
      expect(created.body.data.createdByAgentId).toBe(agentId);
      expect(created.body.data.createdByUserId).toBeNull();
      // Multiple tasks with valid dates and dependencies
      expect(created.body.data.content.tasks.length).toBeGreaterThanOrEqual(2);
      for (const task of created.body.data.content.tasks as Array<{
        id: string;
        title: string;
        start: string;
        end: string;
        dependsOn?: string[];
        progress?: number;
      }>) {
        expect(task.id.length).toBeGreaterThan(0);
        expect(new Date(task.end).getTime()).toBeGreaterThanOrEqual(new Date(task.start).getTime());
        if (task.progress !== undefined) {
          expect(task.progress).toBeGreaterThanOrEqual(0);
          expect(task.progress).toBeLessThanOrEqual(100);
        }
      }

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
      expect(revs.body.data[0].editedByAgentId).toBe(agentId);
    });

    it('VAL-TIMELINE-011: the agent tool rejects a timeline with a dependency cycle', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'timeline',
          title: '__mtest__ Bad Agent Timeline',
          content: {
            tasks: [
              { id: 'a', title: 'A', start: '2026-01-01', end: '2026-01-05', dependsOn: ['b'], progress: 0 },
              { id: 'b', title: 'B', start: '2026-01-01', end: '2026-01-05', dependsOn: ['a'], progress: 0 },
            ],
          },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });

    it('VAL-TIMELINE-012: an agent update bumps the version and records editSource=agent', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.update',
        { artifactId: id, version: 1, content: TIMELINE_CONTENT_V2, message: 'agent updated the timeline' },
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
      expect(agentRev.content).toEqual(TIMELINE_CONTENT_V2);
    });

    it('VAL-TIMELINE-012: an agent-authored timeline via the X-Eidolon-Agent-Id header records agent source', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'timeline', title: '__mtest__ Header Timeline', content: TIMELINE_CONTENT, projectId })
        .expect(201);
      expect(res.body.data.createdByAgentId).toBe(agentId);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
    });
  });

  // =========================================================================
  // VAL-TIMELINE-013: project + company isolation
  // =========================================================================

  describe('VAL-TIMELINE-013: timeline project and company isolation', () => {
    it('does not return a timeline from another company', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);

      const otherList = await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts?type=timeline`)
        .expect(200);
      expect(otherList.body.data).toHaveLength(0);
    });

    it('does not allow update, delete, or archive of a timeline through another company', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .send({ content: TIMELINE_CONTENT_V2, version: 1 })
        .expect(404);
      await request(app).delete(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);
      await request(app).post(`/api/companies/${otherCompanyId}/artifacts/${id}/archive`).expect(404);

      const untouched = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(untouched.body.data.version).toBe(1);
      expect(untouched.body.data.status).toBe('active');
    });

    it('cannot create a timeline scoped to a project in another company', async () => {
      await createTimeline({ projectId: otherProjectId }).expect(404);
    });

    it('a project-scoped list returns only that project timelines', async () => {
      const inProject = await createTimeline({ title: '__mtest__ Timeline P1' }).expect(201);
      const inSecond = await createTimeline({
        title: '__mtest__ Timeline P2',
        projectId: secondProjectId,
      }).expect(201);
      const unscoped = await createTimeline({ title: '__mtest__ Timeline none', projectId: null }).expect(201);

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
  // VAL-TIMELINE-014: realtime events for timeline create/update
  // =========================================================================

  describe('VAL-TIMELINE-014: timeline realtime events', () => {
    it('emits artifact.created + artifact.revision.created on timeline create', async () => {
      const events = await captureEvents(async () => {
        await createTimeline().expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact.created');
      expect(created).toHaveLength(1);
      expect(created[0].companyId).toBe(companyId);
      expect(
        (created[0].payload as { artifact: { type: string } }).artifact.type,
      ).toBe('timeline');
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.updated on timeline update and none on a rejected update', async () => {
      const created = await createTimeline().expect(201);
      const id = created.body.data.id;

      const okEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: TIMELINE_CONTENT_V2, version: 1 })
          .expect(200);
      });
      expect(okEvents.filter((e) => e.type === 'artifact.updated')).toHaveLength(1);

      const badEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({
            content: { tasks: [{ id: 't1', title: 'A', start: '2026-02-01', end: '2026-01-01', progress: 0 }] },
            version: 2,
          })
          .expect(400);
      });
      expect(badEvents.filter((e) => e.type.startsWith('artifact.'))).toHaveLength(0);
    });
  });
});
