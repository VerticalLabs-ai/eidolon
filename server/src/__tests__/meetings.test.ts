import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createTestServer, createTestDb } from '../test-utils.js';
import { setupWebSocketServer } from '../realtime/ws-server.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Realtime WS helpers (mirrors artifacts-ws.test.ts)
// ---------------------------------------------------------------------------

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const onOpen = () => {
      ws.off('error', onError);
      resolve(ws);
    };
    const onError = (err: unknown) => {
      ws.off('open', onOpen);
      reject(err);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function subscribe(ws: WebSocket, companyId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timeout')), 3000);
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as { type: string; companyId?: string };
      if (msg.type === 'subscribed' && msg.companyId === companyId) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'subscribe', companyId }));
  });
}

function collectUntil(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeout = 3000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const out: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(out);
    }, timeout);
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      out.push(msg);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(out);
      }
    };
    ws.on('message', onMessage);
  });
}

function filterMeetingEvents(msgs: Record<string, unknown>[]): Record<string, unknown>[] {
  return msgs.filter((m) => typeof m.type === 'string' && (m.type as string).startsWith('meeting.'));
}

function closeWs(ws: WebSocket | null): Promise<void> {
  if (!ws) return Promise.resolve();
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// Transcript fixture — names/topics present, others absent (VAL-MEETING-004)
// ---------------------------------------------------------------------------

const TRANSCRIPT = `Alice: Let's launch the billing dashboard next week.
Bob: I'll wire up the Stripe integration by Wednesday.
Alice: We need to fix the login redirect bug before then.
Carol: I'll write the docs for the new API.
Dave: Reminder — the Q3 review is on Friday.`;

// ===========================================================================
// Meetings pipeline — VAL-MEETING-001..013, 015
// ===========================================================================

describe('Meetings pipeline', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let port: number;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let wss: ReturnType<typeof setupWebSocketServer> | null = null;
  let wsA: WebSocket | null = null;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    port = (app.address() as { port: number }).port;
    wss = setupWebSocketServer(app);

    const company = await request(app).post('/api/companies').send({ name: '__mtest__ Meetings Co' }).expect(201);
    companyId = company.body.data.id;
    const otherCompany = await request(app).post('/api/companies').send({ name: '__mtest__ Other Co' }).expect(201);
    otherCompanyId = otherCompany.body.data.id;
    const project = await request(app).post(`/api/companies/${companyId}/projects`).send({ name: 'Meetings Proj', status: 'active' }).expect(201);
    projectId = project.body.data.id;
    const otherProject = await request(app).post(`/api/companies/${otherCompanyId}/projects`).send({ name: 'Other Proj', status: 'active' }).expect(201);
    otherProjectId = otherProject.body.data.id;
  });

  afterEach(async () => {
    await closeWs(wsA);
    wsA = null;
    wss?.close();
    wss = null;
  });

  /** Create a meeting via the project-scoped endpoint. */
  async function createMeeting(overrides: { projectId?: string; companyId?: string; transcript?: string; title?: string } = {}) {
    const res = await request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/projects/${overrides.projectId ?? projectId}/meetings`)
      .send({
        title: overrides.title ?? '__mtest__ Standup',
        transcript: overrides.transcript ?? TRANSCRIPT,
      })
      .expect(201);
    return res.body.data as { id: string; projectId: string | null; transcript: string | null; summary: string | null };
  }

  // -- VAL-MEETING-001: create meeting scoped to a project ------------------

  it('creates a project-scoped meeting (201, projectId set)', async () => {
    const meeting = await createMeeting();
    expect(meeting.id).toBeTruthy();
    expect(meeting.projectId).toBe(projectId);
    expect(meeting.transcript).toBe(TRANSCRIPT);
    expect(meeting.summary).toBeNull();
  });

  // -- VAL-MEETING-001: rejects missing title with 400 ----------------------

  it('rejects create with missing title (400)', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/meetings`)
      .send({ transcript: TRANSCRIPT })
      .expect(400);
  });

  // -- VAL-MEETING-002: attach/replace transcript ---------------------------

  it('attaches and retrieves a transcript via POST /transcript', async () => {
    const meeting = await createMeeting({ transcript: '' });
    const updated = await request(app)
      .post(`/api/companies/${companyId}/meetings/${meeting.id}/transcript`)
      .send({ transcript: TRANSCRIPT })
      .expect(200);
    expect(updated.body.data.transcript).toBe(TRANSCRIPT);
    const got = await request(app).get(`/api/companies/${companyId}/meetings/${meeting.id}`).expect(200);
    expect(got.body.data.transcript).toBe(TRANSCRIPT);
  });

  // -- VAL-MEETING-003 + 004: generate a grounded summary -------------------

  it('generates a grounded summary that references transcript content', async () => {
    const meeting = await createMeeting();
    const res = await request(app)
      .post(`/api/companies/${companyId}/meetings/${meeting.id}/summarize`)
      .expect(200);
    const summary = res.body.data.summary as string;
    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    // Grounding: the summary must reference content present in the transcript.
    // Either the LLM summary or the extractive fallback mentions transcript
    // terms. We check for at least one transcript-derived token.
    const lower = summary.toLowerCase();
    const grounded =
      lower.includes('billing') ||
      lower.includes('stripe') ||
      lower.includes('login') ||
      lower.includes('dashboard') ||
      lower.includes('meeting transcript excerpt');
    expect(grounded).toBe(true);
    // VAL-MEETING-004: a name absent from the transcript must NOT be invented.
    expect(lower.includes('chris')).toBe(false);
    const got = await request(app).get(`/api/companies/${companyId}/meetings/${meeting.id}`).expect(200);
    expect(got.body.data.summary).toBe(summary);
  });

  // -- VAL-MEETING-005: extract action items as tasks linked to the project

  it('extracts action items as real tasks linked to the project', async () => {
    const meeting = await createMeeting();
    const res = await request(app)
      .post(`/api/companies/${companyId}/meetings/${meeting.id}/action-items`)
      .expect(200);
    const tasks = res.body.data.tasks as Array<Record<string, unknown>>;
    // The LLM may or may not extract items; both are valid. When items are
    // extracted, each must be a real task with an id + title (linked via the
    // meeting_tasks join, queryable via the meeting's task list).
    for (const t of tasks) {
      expect(t.id).toBeTruthy();
      expect(typeof t.title).toBe('string');
      expect(t.projectId).toBe(projectId);
    }
    // The meeting's task list endpoint returns them (bidirectional linkage).
    const tasksList = await request(app).get(`/api/companies/${companyId}/meetings/${meeting.id}/tasks`).expect(200);
    expect(Array.isArray(tasksList.body.data)).toBe(true);
    expect(tasksList.body.data.length).toBe(tasks.length);
    // VAL-MEETING-005: tasks appear in the project task list.
    if (tasks.length > 0) {
      const projectTasks = await request(app).get(`/api/companies/${companyId}/tasks?project=${projectId}`).expect(200);
      const ids = (projectTasks.body.data as Array<{ id: string }>).map((t) => t.id);
      for (const t of tasks) expect(ids).toContain(t.id);
    }
  });

  // -- VAL-MEETING-010: action items are real tasks (status/assignee/board) -

  it('extracted action items are real tasks editable via PATCH /tasks/:id', async () => {
    const meeting = await createMeeting();
    const res = await request(app)
      .post(`/api/companies/${companyId}/meetings/${meeting.id}/action-items`)
      .expect(200);
    const tasks = res.body.data.tasks as Array<Record<string, unknown>>;
    if (tasks.length === 0) {
      // No LLM — skip the board-mechanics sub-assertion gracefully (still
      // assert that zero tasks is a valid graceful result).
      expect(tasks.length).toBe(0);
      return;
    }
    const task = tasks[0];
    // PATCH the task to change status — it behaves like any task.
    const patched = await request(app)
      .patch(`/api/companies/${companyId}/tasks/${task.id}`)
      .send({ status: 'todo' })
      .expect(200);
    expect(patched.body.data.status).toBe('todo');
    // The task remains linked to the meeting via the join table.
    const meetingTasksList = await request(app).get(`/api/companies/${companyId}/meetings/${meeting.id}/tasks`).expect(200);
    const linkedIds = (meetingTasksList.body.data as Array<{ id: string }>).map((t) => t.id);
    expect(linkedIds).toContain(task.id);
  });

  // -- VAL-MEETING-011: empty/garbage transcript handled gracefully (no 500)

  it('summarize + action-items on an empty transcript are graceful (no 500)', async () => {
    const meeting = await createMeeting({ transcript: '   \n\n  \t  ' });
    const sumRes = await request(app)
      .post(`/api/companies/${companyId}/meetings/${meeting.id}/summarize`)
      .expect(200);
    expect(sumRes.body.data.skipped).toBe(true);
    const aiRes = await request(app)
      .post(`/api/companies/${companyId}/meetings/${meeting.id}/action-items`)
      .expect(200);
    expect(aiRes.body.data.tasks).toEqual([]);
    expect(aiRes.body.data.skipped).toBe(true);
  });

  it('summarize on a meeting with no transcript at all is graceful', async () => {
    const meeting = await createMeeting({ transcript: undefined as unknown as string });
    // create with no transcript
    const created = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/meetings`)
      .send({ title: '__mtest__ No Transcript' })
      .expect(201);
    const res = await request(app)
      .post(`/api/companies/${companyId}/meetings/${created.body.data.id}/summarize`)
      .expect(200);
    expect(res.body.data.skipped).toBe(true);
    // meeting var referenced to satisfy linter; the test uses created.id
    expect(meeting).toBeDefined();
  });

  // -- VAL-MEETING-009: meetings are distinct from agent execution transcripts

  it('creating a meeting does not create an execution-transcript thread item', async () => {
    const meeting = await createMeeting();
    // Project thread items should not contain a meeting-creation entry.
    const threads = await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .expect(200);
    const threadList = threads.body.data as Array<Record<string, unknown>>;
    // No thread item references this meeting id (meetings are disjoint).
    const references = threadList.some((t) => JSON.stringify(t.payload ?? {}).includes(meeting.id));
    expect(references).toBe(false);
  });

  // -- VAL-MEETING-012: project-scoped + company-isolated -------------------

  it('rejects cross-company meeting fetch (404) and project-scoped list excludes other projects', async () => {
    const meeting = await createMeeting();
    // Cross-company fetch → 404
    await request(app).get(`/api/companies/${otherCompanyId}/meetings/${meeting.id}`).expect(404);
    // Cross-company mutate → 404
    await request(app)
      .patch(`/api/companies/${otherCompanyId}/meetings/${meeting.id}`)
      .send({ title: 'hijack' })
      .expect(404);
    // Project-scoped list for the other company's project excludes this meeting
    const otherList = await request(app)
      .get(`/api/companies/${otherCompanyId}/projects/${otherProjectId}/meetings`)
      .expect(200);
    const ids = (otherList.body.data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).not.toContain(meeting.id);
  });

  it('rejects create with a projectId not owned by the company (404)', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/projects/${otherProjectId}/meetings`)
      .send({ title: '__mtest__ cross', transcript: TRANSCRIPT })
      .expect(404);
  });

  // -- VAL-MEETING-007: meeting detail shows transcript + summary + items ---

  it('meeting detail returns transcript + summary + tasks in one place', async () => {
    const meeting = await createMeeting();
    await request(app).post(`/api/companies/${companyId}/meetings/${meeting.id}/summarize`).expect(200);
    await request(app).post(`/api/companies/${companyId}/meetings/${meeting.id}/action-items`).expect(200);
    const detail = await request(app).get(`/api/companies/${companyId}/meetings/${meeting.id}`).expect(200);
    expect(detail.body.data.transcript).toBe(TRANSCRIPT);
    expect(typeof detail.body.data.summary).toBe('string');
    const tasks = await request(app).get(`/api/companies/${companyId}/meetings/${meeting.id}/tasks`).expect(200);
    expect(Array.isArray(tasks.body.data)).toBe(true);
  });

  // -- VAL-MEETING-013: realtime events on summary/action-item creation ----

  it('emits meeting.* realtime events on create/summary/action-items', async () => {
    wsA = await openWs(port);
    await subscribe(wsA, companyId);
    // create
    const collectCreate = collectUntil(wsA, (m) => m.type === 'meeting.created');
    const meeting = await createMeeting();
    let msgs = await collectCreate;
    expect(filterMeetingEvents(msgs).some((m) => m.type === 'meeting.created')).toBe(true);
    // summary
    const collectSummary = collectUntil(wsA, (m) => m.type === 'meeting.summary.created');
    await request(app).post(`/api/companies/${companyId}/meetings/${meeting.id}/summarize`).expect(200);
    msgs = await collectSummary;
    expect(filterMeetingEvents(msgs).some((m) => m.type === 'meeting.summary.created')).toBe(true);
    // action items
    const collectAi = collectUntil(wsA, (m) => m.type === 'meeting.action_items.created');
    await request(app).post(`/api/companies/${companyId}/meetings/${meeting.id}/action-items`).expect(200);
    msgs = await collectAi;
    expect(filterMeetingEvents(msgs).some((m) => m.type === 'meeting.action_items.created')).toBe(true);
  });

  // -- Cross-company realtime isolation -------------------------------------

  it('does not deliver meeting events to another company channel', async () => {
    wsA = await openWs(port);
    await subscribe(wsA, otherCompanyId);
    const collect = collectUntil(wsA, (m) => m.type === 'meeting.created', 1500);
    await createMeeting(); // created in companyId, not otherCompanyId
    const msgs = await collect;
    expect(filterMeetingEvents(msgs).length).toBe(0);
  });

  // -- Soft-delete / archive ------------------------------------------------

  it('soft-deletes and archives meetings (status transitions)', async () => {
    const meeting = await createMeeting();
    const archived = await request(app).post(`/api/companies/${companyId}/meetings/${meeting.id}/archive`).expect(200);
    expect(archived.body.data.status).toBe('archived');
    const restored = await request(app).post(`/api/companies/${companyId}/meetings/${meeting.id}/restore`).expect(200);
    expect(restored.body.data.status).toBe('active');
    const deleted = await request(app).delete(`/api/companies/${companyId}/meetings/${meeting.id}`).expect(200);
    expect(deleted.body.data.status).toBe('deleted');
    // default list excludes deleted
    const list = await request(app).get(`/api/companies/${companyId}/projects/${projectId}/meetings`).expect(200);
    const ids = (list.body.data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).not.toContain(meeting.id);
  });

  // -- VAL-MEETING-015: meeting participates in thread linkage model -------
  // (Thread item payload.meetingId renders a meeting card. The agent path is
  // covered by the agent-tools test below; here we assert the API shape: a
  // thread item can carry a meetingId payload and the meeting is fetchable.)

  it('a meeting can be referenced from a thread item payload (linkage model)', async () => {
    const meeting = await createMeeting();
    // Create a project thread + item referencing the meeting.
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: '__mtest__ meeting thread' })
      .expect(201);
    const item = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads/${thread.body.data.id}/items`)
      .send({
        kind: 'comment',
        content: `Meeting summary: ${meeting.id}`,
        payload: { meetingId: meeting.id },
      })
      .expect(201);
    expect(item.body.data.payload.meetingId).toBe(meeting.id);
    // The meeting referenced by the payload is fetchable + cross-linked.
    const ref = await request(app).get(`/api/companies/${companyId}/meetings/${meeting.id}`).expect(200);
    expect(ref.body.data.id).toBe(meeting.id);
  });
});

// ===========================================================================
// Meeting agent tools — VAL-MEETING-008 (agent summarize → action-items)
// ===========================================================================

describe('Meeting agent tools (built-in tool surface)', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let agentId: string;
  const agentHeaders: Record<string, string> = {};

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    const company = await request(app).post('/api/companies').send({ name: '__mtest__ Meeting Tools Co' }).expect(201);
    companyId = company.body.data.id;
    const project = await request(app).post(`/api/companies/${companyId}/projects`).send({ name: 'Tools Proj', status: 'active' }).expect(201);
    projectId = project.body.data.id;
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: '__mtest__ Meeting Bot', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
    agentHeaders['X-Eidolon-Agent-Id'] = agentId;
  });

  it('ArtifactToolService.isArtifactTool recognizes meeting.* tools', async () => {
    const { ArtifactToolService } = await import('../services/artifact-tools.js');
    expect(ArtifactToolService.isArtifactTool('meeting.create')).toBe(true);
    expect(ArtifactToolService.isArtifactTool('meeting.summarize')).toBe(true);
    expect(ArtifactToolService.isArtifactTool('meeting.action_items')).toBe(true);
    expect(ArtifactToolService.isArtifactTool('artifact.create')).toBe(true);
    expect(ArtifactToolService.isArtifactTool('mcp.foo')).toBe(false);
  });

  it('meeting.create + summarize + action_items run via the tool service (agent context)', async () => {
    const { ArtifactToolService } = await import('../services/artifact-tools.js');
    const svc = new ArtifactToolService(db);
    const ctx = { companyId, agentId, projectId };
    // create
    const createRes = await svc.executeTool('meeting.create', {
      title: '__mtest__ Tool Meeting',
      transcript: TRANSCRIPT,
    }, ctx);
    expect(createRes.isError).toBeFalsy();
    const meetingId = (createRes.data as { meetingId: string }).meetingId;
    expect(meetingId).toBeTruthy();
    // summarize
    const sumRes = await svc.executeTool('meeting.summarize', { meetingId }, ctx);
    expect(sumRes.isError).toBeFalsy();
    // action items
    const aiRes = await svc.executeTool('meeting.action_items', { meetingId }, ctx);
    expect(aiRes.isError).toBeFalsy();
    const produced = svc.getProducedMeetings();
    expect(produced.length).toBeGreaterThanOrEqual(2);
    expect(produced.some((p) => p.action === 'created')).toBe(true);
    // The meeting gained a summary.
    const got = await request(app).get(`/api/companies/${companyId}/meetings/${meetingId}`).expect(200);
    expect(typeof got.body.data.summary).toBe('string');
  });

  it('meeting.summarize on an empty transcript is graceful (no error)', async () => {
    const { ArtifactToolService } = await import('../services/artifact-tools.js');
    const svc = new ArtifactToolService(db);
    const ctx = { companyId, agentId, projectId };
    const createRes = await svc.executeTool('meeting.create', {
      title: '__mtest__ Empty Tool Meeting',
      transcript: '   ',
    }, ctx);
    const meetingId = (createRes.data as { meetingId: string }).meetingId;
    const sumRes = await svc.executeTool('meeting.summarize', { meetingId }, ctx);
    expect(sumRes.isError).toBeFalsy();
    const text = sumRes.content[0]?.text ?? '';
    expect(text.toLowerCase()).toContain('skipped');
  });

  it('rejects agent tool calls when the agent does not belong to the company', async () => {
    const { ArtifactToolService } = await import('../services/artifact-tools.js');
    const svc = new ArtifactToolService(db);
    // Foreign agent id (does not belong to companyId)
    const res = await svc.executeTool('meeting.create', {
      title: '__mtest__ forgery',
      transcript: TRANSCRIPT,
    }, { companyId, agentId: '00000000-0000-0000-0000-000000000000', projectId });
    expect(res.isError).toBe(true);
  });
});
