import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createTestDb, createTestApp } from '../test-utils.js';

describe('Tasks API', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: 'Task Test Corp' });
    companyId = res.body.data.id;
  });

  const tasksUrl = () => `/api/companies/${companyId}/tasks`;
  const taskUrl = (id: string) => `${tasksUrl()}/${id}`;

  async function createCheckedOutTask(
    title: string,
    taskFields: Record<string, unknown> = {},
  ) {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: `${title} Worker`, role: 'engineer' })
      .expect(201);
    const task = await request(app)
      .post(tasksUrl())
      .send({ title, status: 'todo', ...taskFields })
      .expect(201);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({ taskId: task.body.data.id })
      .expect(201);

    const checkout = await request(app)
      .post(`${taskUrl(task.body.data.id)}/checkout`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
        idempotencyKey: `test-checkout:${execution.body.data.id}`,
      })
      .expect(201);

    return checkout.body.data.task;
  }

  // ---------------------------------------------------------------------------
  // POST - create task
  // ---------------------------------------------------------------------------

  describe('POST /api/companies/:companyId/tasks', () => {
    it('should create a task with minimal fields', async () => {
      const res = await request(app)
        .post(tasksUrl())
        .send({ title: 'Build login page' })
        .expect(201);

      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.title).toBe('Build login page');
      expect(res.body.data.companyId).toBe(companyId);
      expect(res.body.data.status).toBe('backlog');
      expect(res.body.data.priority).toBe('medium');
      expect(res.body.data.type).toBe('feature');
      expect(res.body.data.taskNumber).toBe(1);
      expect(res.body.data.identifier).toBe('TASK-1');
    });

    it('should create a task with full fields', async () => {
      const res = await request(app)
        .post(tasksUrl())
        .send({
          title: 'Fix critical bug',
          description: 'Users cannot log in',
          type: 'bug',
          status: 'todo',
          priority: 'critical',
          tags: ['auth', 'urgent'],
          estimatedTokens: 5000,
        })
        .expect(201);

      expect(res.body.data.title).toBe('Fix critical bug');
      expect(res.body.data.description).toBe('Users cannot log in');
      expect(res.body.data.type).toBe('bug');
      expect(res.body.data.status).toBe('todo');
      expect(res.body.data.priority).toBe('critical');
      expect(res.body.data.tags).toEqual(['auth', 'urgent']);
      expect(res.body.data.estimatedTokens).toBe(5000);
    });

    it('should accept the canonical timed_out status', async () => {
      const res = await request(app)
        .post(tasksUrl())
        .send({ title: 'Timed out task', status: 'timed_out' })
        .expect(201);

      expect(res.body.data.status).toBe('timed_out');
    });

    it('requires checkout instead of creating a task in progress', async () => {
      const res = await request(app)
        .post(tasksUrl())
        .send({ title: 'Bypass checkout', status: 'in_progress' })
        .expect(409);

      expect(res.body.code).toBe('TASK_CHECKOUT_REQUIRED');
    });

    it('should auto-increment task numbers', async () => {
      const t1 = await request(app)
        .post(tasksUrl())
        .send({ title: 'Task 1' });
      const t2 = await request(app)
        .post(tasksUrl())
        .send({ title: 'Task 2' });
      const t3 = await request(app)
        .post(tasksUrl())
        .send({ title: 'Task 3' });

      expect(t1.body.data.taskNumber).toBe(1);
      expect(t2.body.data.taskNumber).toBe(2);
      expect(t3.body.data.taskNumber).toBe(3);
      expect(t1.body.data.identifier).toBe('TASK-1');
      expect(t2.body.data.identifier).toBe('TASK-2');
      expect(t3.body.data.identifier).toBe('TASK-3');
    });

    it('should reject empty title', async () => {
      await request(app)
        .post(tasksUrl())
        .send({ title: '' })
        .expect(400);
    });

    it('should reject missing title', async () => {
      await request(app)
        .post(tasksUrl())
        .send({ description: 'no title' })
        .expect(400);
    });

    it('should reject invalid priority', async () => {
      await request(app)
        .post(tasksUrl())
        .send({ title: 'Bad', priority: 'ultra' })
        .expect(400);
    });

    it('should reject invalid status', async () => {
      await request(app)
        .post(tasksUrl())
        .send({ title: 'Bad', status: 'unknown' })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // GET - list tasks with filters
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/tasks', () => {
    it('should return empty array when no tasks', async () => {
      const res = await request(app).get(tasksUrl()).expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.total).toBe(0);
    });

    it('should list all tasks', async () => {
      await request(app).post(tasksUrl()).send({ title: 'T1' });
      await request(app).post(tasksUrl()).send({ title: 'T2' });

      const res = await request(app).get(tasksUrl()).expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta.total).toBe(2);
    });

    it('should filter tasks by status', async () => {
      await request(app).post(tasksUrl()).send({ title: 'Backlog', status: 'backlog' });
      await createCheckedOutTask('In Progress');
      await request(app).post(tasksUrl()).send({ title: 'Done', status: 'done' });

      const res = await request(app)
        .get(`${tasksUrl()}?status=in_progress`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('In Progress');
    });

    it('should filter tasks by priority', async () => {
      await request(app).post(tasksUrl()).send({ title: 'Low', priority: 'low' });
      await request(app).post(tasksUrl()).send({ title: 'Critical', priority: 'critical' });
      await request(app).post(tasksUrl()).send({ title: 'High', priority: 'high' });

      const res = await request(app)
        .get(`${tasksUrl()}?priority=critical`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('Critical');
    });

    it('should return meta with total count', async () => {
      for (let i = 1; i <= 5; i++) {
        await request(app).post(tasksUrl()).send({ title: `Task ${i}` });
      }

      const res = await request(app)
        .get(tasksUrl())
        .expect(200);

      expect(res.body.data).toHaveLength(5);
      expect(res.body.meta.total).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // GET - get task by id
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/tasks/:id', () => {
    it('should get a task by id', async () => {
      const created = await request(app)
        .post(tasksUrl())
        .send({ title: 'Find Me' });
      const id = created.body.data.id;

      const res = await request(app).get(taskUrl(id)).expect(200);

      expect(res.body.data.id).toBe(id);
      expect(res.body.data.title).toBe('Find Me');
    });

    it('should 404 for non-existent task', async () => {
      const res = await request(app)
        .get(taskUrl('00000000-0000-0000-0000-000000000000'))
        .expect(404);

      expect(res.body.code).toBe('TASK_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH - update task
  // ---------------------------------------------------------------------------

  describe('PATCH /api/companies/:companyId/tasks/:id', () => {
    it('should update task title', async () => {
      const created = await request(app)
        .post(tasksUrl())
        .send({ title: 'Old Title' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(taskUrl(id))
        .send({ title: 'New Title' })
        .expect(200);

      expect(res.body.data.title).toBe('New Title');
    });

    it('requires execution-scoped checkout before transitioning to in_progress', async () => {
      const created = await request(app)
        .post(tasksUrl())
        .send({ title: 'Start Me' });
      const id = created.body.data.id;

      expect(created.body.data.startedAt).toBeNull();

      const res = await request(app)
        .patch(taskUrl(id))
        .send({ status: 'in_progress' })
        .expect(409);

      expect(res.body.code).toBe('TASK_CHECKOUT_REQUIRED');
    });

    it('keeps lifecycle timestamps server-controlled', async () => {
      const created = await request(app)
        .post(tasksUrl())
        .send({ title: 'Server timestamps only' });
      const id = created.body.data.id;

      const updated = await request(app)
        .patch(taskUrl(id))
        .send({
          startedAt: '2000-01-01T00:00:00.000Z',
          completedAt: '2000-01-02T00:00:00.000Z',
        })
        .expect(200);

      expect(updated.body.data.startedAt).toBeNull();
      expect(updated.body.data.completedAt).toBeNull();
    });

    it('allows an idempotent in_progress PATCH that updates another field', async () => {
      const created = await createCheckedOutTask('Already running');

      const res = await request(app)
        .patch(taskUrl(created.id))
        .send({ title: 'Updated while running', status: 'in_progress' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        title: 'Updated while running',
        status: 'in_progress',
      });

      const dependency = await request(app)
        .post(tasksUrl())
        .send({ title: 'Late dependency', status: 'todo' })
        .expect(201);
      const dependencyConflict = await request(app)
        .patch(taskUrl(created.id))
        .send({ dependencies: [dependency.body.data.id] })
        .expect(409);
      expect(dependencyConflict.body.code).toBe('TASK_CHECKOUT_CONFLICT');
    });

    it('rejects direct reassignment while a checkout is active', async () => {
      const created = await createCheckedOutTask('Keep checkout owner');
      const replacement = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Replacement Worker', role: 'engineer' })
        .expect(201);

      await expect(
        db.drizzle
          .update(db.schema.tasks)
          .set({ assigneeAgentId: replacement.body.data.id })
          .where(eq(db.schema.tasks.id, created.id)),
      ).rejects.toBeDefined();

      const [unchanged] = await db.drizzle
        .select({ assigneeAgentId: db.schema.tasks.assigneeAgentId })
        .from(db.schema.tasks)
        .where(eq(db.schema.tasks.id, created.id));
      expect(unchanged.assigneeAgentId).toBe(created.assigneeAgentId);
    });

    it('rejects deleting a dependency required by an active checkout', async () => {
      const dependency = await request(app)
        .post(tasksUrl())
        .send({ title: 'Required dependency', status: 'done' })
        .expect(201);
      await createCheckedOutTask('Depends on completed work', {
        dependencies: [dependency.body.data.id],
      });

      await expect(
        db.drizzle
          .delete(db.schema.tasks)
          .where(eq(db.schema.tasks.id, dependency.body.data.id)),
      ).rejects.toBeDefined();

      const [preserved] = await db.drizzle
        .select({ id: db.schema.tasks.id })
        .from(db.schema.tasks)
        .where(eq(db.schema.tasks.id, dependency.body.data.id));
      expect(preserved.id).toBe(dependency.body.data.id);
    });

    it('should auto-set completedAt when transitioning to done', async () => {
      const created = await createCheckedOutTask('Complete Me');
      const id = created.id;

      const conflict = await request(app)
        .patch(taskUrl(id))
        .send({ status: 'done' })
        .expect(409);
      expect(conflict.body.code).toBe('TASK_CHECKOUT_CONFLICT');

      const [execution] = await db.drizzle
        .select()
        .from(db.schema.agentExecutions)
        .where(eq(db.schema.agentExecutions.taskId, id));
      await request(app)
        .patch(
          `/api/companies/${companyId}/agents/${created.assigneeAgentId}/executions/${execution.id}`,
        )
        .send({ status: 'completed' })
        .expect(200);

      const res = await request(app)
        .patch(taskUrl(id))
        .send({ status: 'done' })
        .expect(200);

      expect(res.body.data.status).toBe('done');
      expect(res.body.data.completedAt).toBeDefined();
      expect(res.body.data.completedAt).not.toBeNull();
    });

    it('should update priority', async () => {
      const created = await request(app)
        .post(tasksUrl())
        .send({ title: 'Priority Change', priority: 'low' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(taskUrl(id))
        .send({ priority: 'critical' })
        .expect(200);

      expect(res.body.data.priority).toBe('critical');
    });

    it('should update status to review', async () => {
      const created = await request(app)
        .post(tasksUrl())
        .send({ title: 'Review Me' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(taskUrl(id))
        .send({ status: 'review' })
        .expect(200);

      expect(res.body.data.status).toBe('review');
    });

    it('should not wake a working assignee when a blocker resolves', async () => {
      const agent = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Busy assignee', role: 'engineer', status: 'working' })
        .expect(201);
      const agentId = agent.body.data.id;

      const blocker = await request(app)
        .post(tasksUrl())
        .send({ title: 'Blocking task', status: 'todo' })
        .expect(201);
      const blockerId = blocker.body.data.id;

      await request(app)
        .post(tasksUrl())
        .send({
          title: 'Blocked task',
          status: 'todo',
          dependencies: [blockerId],
          assigneeAgentId: agentId,
        })
        .expect(201);

      await request(app)
        .patch(taskUrl(blockerId))
        .send({ status: 'done' })
        .expect(200);

      const unchangedAgent = await request(app)
        .get(`/api/companies/${companyId}/agents/${agentId}`)
        .expect(200);
      expect(unchangedAgent.body.data.status).toBe('working');
    });

    it('should 404 for non-existent task', async () => {
      await request(app)
        .patch(taskUrl('00000000-0000-0000-0000-000000000000'))
        .send({ title: 'Ghost' })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE - cancel task
  // ---------------------------------------------------------------------------

  describe('DELETE /api/companies/:companyId/tasks/:id', () => {
    it('should cancel a task', async () => {
      const created = await request(app)
        .post(tasksUrl())
        .send({ title: 'Cancel Me' });
      const id = created.body.data.id;

      const res = await request(app).delete(taskUrl(id)).expect(200);

      expect(res.body.data.status).toBe('cancelled');
    });

    it('should 404 for non-existent task', async () => {
      await request(app)
        .delete(taskUrl('00000000-0000-0000-0000-000000000000'))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST - assign task
  // ---------------------------------------------------------------------------

  describe('POST /api/companies/:companyId/tasks/:id/assign', () => {
    it('should assign a task to an agent', async () => {
      // Create an agent
      const agentRes = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Worker', role: 'engineer' });
      const agentId = agentRes.body.data.id;

      // Create a task
      const taskRes = await request(app)
        .post(tasksUrl())
        .send({ title: 'Assign Me' });
      const taskId = taskRes.body.data.id;

      const res = await request(app)
        .post(`${taskUrl(taskId)}/assign`)
        .send({ agentId })
        .expect(200);

      expect(res.body.data.assigneeAgentId).toBe(agentId);
      expect(res.body.data.status).toBe('backlog');
      expect(res.body.data.startedAt).toBeNull();
    });

    it('rejects ownership changes through generic PATCH', async () => {
      const agentRes = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Worker', role: 'engineer' });
      const taskRes = await request(app)
        .post(tasksUrl())
        .send({ title: 'Assign through route' });

      const res = await request(app)
        .patch(taskUrl(taskRes.body.data.id))
        .send({ assigneeAgentId: agentRes.body.data.id })
        .expect(400);

      expect(res.body.code).toBe('TASK_ASSIGNMENT_REQUIRED');
    });

    it('should 404 for non-existent task', async () => {
      await request(app)
        .post(`${taskUrl('00000000-0000-0000-0000-000000000000')}/assign`)
        .send({ agentId: '00000000-0000-0000-0000-000000000001' })
        .expect(404);
    });

    it('should reject missing agentId', async () => {
      const taskRes = await request(app)
        .post(tasksUrl())
        .send({ title: 'No Agent' });
      const taskId = taskRes.body.data.id;

      await request(app)
        .post(`${taskUrl(taskId)}/assign`)
        .send({})
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // GET - board view
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/tasks/board', () => {
    it('should return board grouped by status with all columns', async () => {
      const res = await request(app)
        .get(`${tasksUrl()}/board`)
        .expect(200);

      expect(res.body.data).toBeDefined();
      expect(res.body.data.backlog).toBeDefined();
      expect(res.body.data.todo).toBeDefined();
      expect(res.body.data.in_progress).toBeDefined();
      expect(res.body.data.review).toBeDefined();
      expect(res.body.data.done).toBeDefined();
      expect(res.body.data.cancelled).toBeDefined();
    });

    it('should group tasks by their status', async () => {
      await request(app).post(tasksUrl()).send({ title: 'B1', status: 'backlog' });
      await request(app).post(tasksUrl()).send({ title: 'B2', status: 'backlog' });
      await createCheckedOutTask('IP1');
      await request(app).post(tasksUrl()).send({ title: 'D1', status: 'done' });

      const res = await request(app)
        .get(`${tasksUrl()}/board`)
        .expect(200);

      expect(res.body.data.backlog).toHaveLength(2);
      expect(res.body.data.in_progress).toHaveLength(1);
      expect(res.body.data.done).toHaveLength(1);
      expect(res.body.data.todo).toHaveLength(0);
      expect(res.body.data.review).toHaveLength(0);
      expect(res.body.data.cancelled).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Thread and structured interactions
  // ---------------------------------------------------------------------------

  describe('Task thread endpoints', () => {
    it('should persist comments in the task thread', async () => {
      const taskRes = await request(app)
        .post(tasksUrl())
        .send({ title: 'Discuss Me' });
      const taskId = taskRes.body.data.id;

      const created = await request(app)
        .post(`${taskUrl(taskId)}/thread/comments`)
        .send({
          content: 'Operator context for the agent.',
          idempotencyKey: 'operator-comment-1',
        })
        .expect(201);

      const duplicate = await request(app)
        .post(`${taskUrl(taskId)}/thread/comments`)
        .send({
          content: 'Operator context for the agent.',
          idempotencyKey: 'operator-comment-1',
        })
        .expect(201);

      expect(duplicate.body.data.id).toBe(created.body.data.id);

      const res = await request(app)
        .get(`${taskUrl(taskId)}/thread`)
        .expect(200);

      const comments = res.body.data.filter((item: any) => item.kind === 'comment');
      expect(comments).toEqual([
        expect.objectContaining({
          id: created.body.data.id,
          content: 'Operator context for the agent.',
        }),
      ]);
    });

    it('should make suggested-task decisions idempotent and create child tasks once', async () => {
      const taskRes = await request(app)
        .post(tasksUrl())
        .send({ title: 'Parent Issue' });
      const taskId = taskRes.body.data.id;

      const interactionRes = await request(app)
        .post(`${taskUrl(taskId)}/thread/interactions`)
        .send({
          interactionType: 'suggested_tasks',
          content: 'Suggested follow-up work',
          idempotencyKey: 'suggestion-1',
          payload: {
            tasks: [
              { title: 'Child A', priority: 'high' },
              { title: 'Child B', type: 'chore' },
            ],
          },
        })
        .expect(201);
      const interactionId = interactionRes.body.data.id;

      const duplicate = await request(app)
        .post(`${taskUrl(taskId)}/thread/interactions`)
        .send({
          interactionType: 'suggested_tasks',
          content: 'Suggested follow-up work',
          idempotencyKey: 'suggestion-1',
          payload: { tasks: [{ title: 'Should not appear' }] },
        })
        .expect(200);
      expect(duplicate.body.data.id).toBe(interactionId);

      const firstDecision = await request(app)
        .post(`${taskUrl(taskId)}/thread/interactions/${interactionId}/accept`)
        .send({ note: 'Accept the proposal' })
        .expect(200);

      const secondDecision = await request(app)
        .post(`${taskUrl(taskId)}/thread/interactions/${interactionId}/accept`)
        .send({ note: 'Accept again' })
        .expect(200);

      expect(firstDecision.body.data.status).toBe('accepted');
      expect(firstDecision.body.data.payload.createdTaskIds).toHaveLength(2);
      expect(secondDecision.body.data.payload.createdTaskIds).toHaveLength(2);
      expect(secondDecision.body.data.payload.createdTaskIds).toEqual(
        firstDecision.body.data.payload.createdTaskIds,
      );

      const children = await request(app)
        .get(tasksUrl())
        .expect(200);
      const childTasks = children.body.data.filter((task: any) => task.parentId === taskId);
      expect(childTasks.map((task: any) => task.title).sort()).toEqual(['Child A', 'Child B']);
      expect(childTasks.find((task: any) => task.title === 'Child A')).toEqual(
        expect.objectContaining({ priority: 'high' }),
      );
      expect(childTasks.find((task: any) => task.title === 'Child B')).toEqual(
        expect.objectContaining({ type: 'chore' }),
      );
    });

    it('should link approval decisions back into the task thread', async () => {
      const taskRes = await request(app)
        .post(tasksUrl())
        .send({ title: 'Needs Approval' });
      const taskId = taskRes.body.data.id;

      const approvalRes = await request(app)
        .post(`/api/companies/${companyId}/approvals`)
        .send({
          kind: 'task_review',
          title: 'Approve plan',
          taskId,
        })
        .expect(201);

      await request(app)
        .post(`/api/companies/${companyId}/approvals/${approvalRes.body.data.id}/decide`)
        .send({ decision: 'approved', resolutionNote: 'Looks good.' })
        .expect(200);

      const res = await request(app)
        .get(`${taskUrl(taskId)}/thread`)
        .expect(200);

      expect(res.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'approval_link', content: 'Approve plan' }),
          expect.objectContaining({ kind: 'decision', content: 'Looks good.' }),
        ]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Subtree controls
  // ---------------------------------------------------------------------------

  describe('Task subtree controls', () => {
    it('should pause, cancel, and restore a parent subtree', async () => {
      const parent = await request(app)
        .post(tasksUrl())
        .send({ title: 'Parent', status: 'todo' });
      const parentId = parent.body.data.id;
      const child = await request(app)
        .post(tasksUrl())
        .send({ title: 'Child', status: 'todo', parentId })
        .expect(201);
      const childId = child.body.data.id;

      const pause = await request(app)
        .post(`${taskUrl(parentId)}/subtree/pause`)
        .send({ reason: 'Operator pause' })
        .expect(200);
      expect(pause.body.data.affectedTaskIds.sort()).toEqual([childId, parentId].sort());

      await request(app)
        .post(`${taskUrl(parentId)}/subtree/cancel`)
        .send({ reason: 'Stop this branch' })
        .expect(200);

      const cancelledParent = await request(app).get(taskUrl(parentId)).expect(200);
      const cancelledChild = await request(app).get(taskUrl(childId)).expect(200);
      expect(cancelledParent.body.data.status).toBe('cancelled');
      expect(cancelledChild.body.data.status).toBe('cancelled');

      await request(app)
        .post(`${taskUrl(parentId)}/subtree/restore`)
        .expect(200);

      const restoredParent = await request(app).get(taskUrl(parentId)).expect(200);
      const restoredChild = await request(app).get(taskUrl(childId)).expect(200);
      expect(restoredParent.body.data.status).toBe('todo');
      expect(restoredChild.body.data.status).toBe('todo');
    });

    it('rejects pausing a subtree while a descendant has an active checkout', async () => {
      const parent = await request(app)
        .post(tasksUrl())
        .send({ title: 'Parent', status: 'todo' })
        .expect(201);
      const child = await createCheckedOutTask('Active Child', { parentId: parent.body.data.id });

      const pause = await request(app)
        .post(`${taskUrl(parent.body.data.id)}/subtree/pause`)
        .send({ reason: 'Operator pause' })
        .expect(409);

      expect(pause.body).toMatchObject({
        code: 'TASK_PAUSE_CONFLICT',
        details: { taskId: child.id },
      });
    });

    it('should treat repeated subtree pause as idempotent', async () => {
      const parent = await request(app)
        .post(tasksUrl())
        .send({ title: 'Parent', status: 'todo' });
      const parentId = parent.body.data.id;

      const firstPause = await request(app)
        .post(`${taskUrl(parentId)}/subtree/pause`)
        .send({ reason: 'Pause once' })
        .expect(200);
      expect(firstPause.body.data.affectedTaskIds).toEqual([parentId]);
      expect(firstPause.body.data.holds).toHaveLength(1);

      const secondPause = await request(app)
        .post(`${taskUrl(parentId)}/subtree/pause`)
        .send({ reason: 'Pause twice' })
        .expect(200);
      expect(secondPause.body.data.affectedTaskIds).toEqual([parentId]);
      expect(secondPause.body.data.holds).toHaveLength(0);
    });

    it('should allow restoring a subtree with no active holds as a no-op', async () => {
      const parent = await request(app)
        .post(tasksUrl())
        .send({ title: 'Unpaused parent', status: 'todo' });
      const parentId = parent.body.data.id;

      const restored = await request(app)
        .post(`${taskUrl(parentId)}/subtree/restore`)
        .expect(200);
      expect(restored.body.data.affectedTaskIds).toEqual([parentId]);

      const unchangedParent = await request(app).get(taskUrl(parentId)).expect(200);
      expect(unchangedParent.body.data.status).toBe('todo');
    });

    it('should cancel only the parent when a subtree has no children', async () => {
      const parent = await request(app)
        .post(tasksUrl())
        .send({ title: 'Solo parent', status: 'todo' });
      const parentId = parent.body.data.id;

      const cancelled = await request(app)
        .post(`${taskUrl(parentId)}/subtree/cancel`)
        .send({ reason: 'Cancel solo' })
        .expect(200);
      expect(cancelled.body.data.affectedTaskIds).toEqual([parentId]);

      const cancelledParent = await request(app).get(taskUrl(parentId)).expect(200);
      expect(cancelledParent.body.data.status).toBe('cancelled');
    });
  });
});
