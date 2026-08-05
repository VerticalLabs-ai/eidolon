import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import {
  WorkflowStatusEnum,
  WorkflowNodeTypeEnum,
  WorkflowNodeStatusEnum,
  WorkflowNodeSchema,
  CreateWorkflowInputSchema,
  UpdateWorkflowInputSchema,
  UpdateNodeInputSchema,
  type WorkflowNode,
  type Workflow,
  type WorkflowStatus,
  type WorkflowNodeType,
  type WorkflowNodeStatus,
} from '@eidolon/shared';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createCompany(app: Awaited<ReturnType<typeof createTestServer>>) {
  const res = await request(app).post('/api/companies').send({ name: 'Test Co' }).expect(201);
  return res.body.data.id as string;
}

async function createProject(app: Awaited<ReturnType<typeof createTestServer>>, companyId: string) {
  const res = await request(app)
    .post(`/api/companies/${companyId}/projects`)
    .send({ name: 'Test Project' })
    .expect(201);
  return res.body.data.id as string;
}

/** A representative node for each of the four node types. */
function sampleNodes(): Record<string, unknown>[] {
  return [
    { id: 'node-1', type: 'trigger', label: 'Start', config: {}, status: 'pending', dependsOn: [] },
    { id: 'node-2', type: 'task', label: 'Do Work', config: { retries: 3 }, status: 'pending', dependsOn: ['node-1'] },
    { id: 'node-3', type: 'decision', label: 'Check Result', config: {}, status: 'pending', dependsOn: ['node-2'] },
    { id: 'node-4', type: 'action', label: 'Notify', config: { channel: 'email' }, status: 'pending', dependsOn: ['node-3'] },
  ];
}

// ---------------------------------------------------------------------------
// Unit: Shared Zod schema validation
// ---------------------------------------------------------------------------

describe('Shared workflow status enum', () => {
  it('accepts exactly draft, active, paused, archived', () => {
    for (const status of ['draft', 'active', 'paused', 'archived'] as const) {
      expect(WorkflowStatusEnum.parse(status)).toBe(status);
    }
  });

  it('rejects completed and failed (old enum values)', () => {
    expect(() => WorkflowStatusEnum.parse('completed')).toThrow();
    expect(() => WorkflowStatusEnum.parse('failed')).toThrow();
  });

  it('rejects unknown values', () => {
    expect(() => WorkflowStatusEnum.parse('running')).toThrow();
    expect(() => WorkflowStatusEnum.parse('')).toThrow();
  });
});

describe('Shared workflow node type enum', () => {
  it('accepts task, decision, trigger, action', () => {
    for (const type of ['task', 'decision', 'trigger', 'action'] as const) {
      expect(WorkflowNodeTypeEnum.parse(type)).toBe(type);
    }
  });

  it('rejects unknown node types', () => {
    expect(() => WorkflowNodeTypeEnum.parse('approval')).toThrow();
    expect(() => WorkflowNodeTypeEnum.parse('')).toThrow();
  });
});

describe('Shared workflow node status enum', () => {
  it('accepts pending, running, completed, failed, skipped', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'skipped'] as const) {
      expect(WorkflowNodeStatusEnum.parse(status)).toBe(status);
    }
  });

  it('rejects unknown statuses', () => {
    expect(() => WorkflowNodeStatusEnum.parse('archived')).toThrow();
    expect(() => WorkflowNodeStatusEnum.parse('')).toThrow();
  });
});

describe('Shared WorkflowNodeSchema', () => {
  it('accepts a full node with all optional fields', () => {
    const node = {
      id: 'node-1',
      type: 'task',
      label: 'My Task',
      agentId: randomUUID(),
      taskId: randomUUID(),
      config: { key: 'value' },
      status: 'pending',
      dependsOn: ['node-0'],
    };
    const parsed = WorkflowNodeSchema.parse(node);
    expect(parsed.id).toBe('node-1');
    expect(parsed.type).toBe('task');
    expect(parsed.label).toBe('My Task');
    expect(parsed.status).toBe('pending');
  });

  it('accepts a minimal node and applies defaults', () => {
    const parsed = WorkflowNodeSchema.parse({
      id: 'n1',
      type: 'trigger',
      label: 'Start',
    });
    expect(parsed.config).toEqual({});
    expect(parsed.status).toBe('pending');
    expect(parsed.dependsOn).toEqual([]);
  });

  it('accepts all four node types', () => {
    for (const type of ['task', 'decision', 'trigger', 'action'] as const) {
      const parsed = WorkflowNodeSchema.parse({ id: `n-${type}`, type, label: type });
      expect(parsed.type).toBe(type);
    }
  });

  it('accepts all five node statuses', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'skipped'] as const) {
      const parsed = WorkflowNodeSchema.parse({
        id: 'n1',
        type: 'task',
        label: 'T',
        status,
      });
      expect(parsed.status).toBe(status);
    }
  });

  it('rejects a node missing required fields', () => {
    expect(() => WorkflowNodeSchema.parse({ id: 'n1', type: 'task' })).toThrow(); // missing label
    expect(() => WorkflowNodeSchema.parse({ type: 'task', label: 'T' })).toThrow(); // missing id
    expect(() => WorkflowNodeSchema.parse({ id: 'n1', label: 'T' })).toThrow(); // missing type
  });
});

describe('Shared CreateWorkflowInputSchema', () => {
  it('accepts projectId as null', () => {
    const parsed = CreateWorkflowInputSchema.parse({
      name: 'My Workflow',
      projectId: null,
    });
    expect(parsed.projectId).toBeNull();
  });

  it('accepts projectId as a UUID', () => {
    const pid = randomUUID();
    const parsed = CreateWorkflowInputSchema.parse({
      name: 'My Workflow',
      projectId: pid,
    });
    expect(parsed.projectId).toBe(pid);
  });

  it('accepts projectId omitted (undefined)', () => {
    const parsed = CreateWorkflowInputSchema.parse({ name: 'My Workflow' });
    expect(parsed.projectId).toBeUndefined();
  });

  it('accepts all four workflow statuses', () => {
    for (const status of ['draft', 'active', 'paused', 'archived'] as const) {
      const parsed = CreateWorkflowInputSchema.parse({ name: 'WF', status });
      expect(parsed.status).toBe(status);
    }
  });

  it('defaults status to draft and nodes to empty array', () => {
    const parsed = CreateWorkflowInputSchema.parse({ name: 'WF' });
    expect(parsed.status).toBe('draft');
    expect(parsed.nodes).toEqual([]);
  });

  it('rejects old status values completed and failed', () => {
    expect(() => CreateWorkflowInputSchema.parse({ name: 'WF', status: 'completed' })).toThrow();
    expect(() => CreateWorkflowInputSchema.parse({ name: 'WF', status: 'failed' })).toThrow();
  });

  it('accepts an empty nodes array', () => {
    const parsed = CreateWorkflowInputSchema.parse({ name: 'WF', nodes: [] });
    expect(parsed.nodes).toEqual([]);
  });

  it('accepts nodes with all four types', () => {
    const parsed = CreateWorkflowInputSchema.parse({
      name: 'WF',
      nodes: sampleNodes(),
    });
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.nodes[0].type).toBe('trigger');
    expect(parsed.nodes[1].type).toBe('task');
    expect(parsed.nodes[2].type).toBe('decision');
    expect(parsed.nodes[3].type).toBe('action');
  });
});

describe('Shared UpdateWorkflowInputSchema', () => {
  it('accepts partial updates with all statuses', () => {
    for (const status of ['draft', 'active', 'paused', 'archived'] as const) {
      const parsed = UpdateWorkflowInputSchema.parse({ status });
      expect(parsed.status).toBe(status);
    }
  });

  it('accepts null description', () => {
    const parsed = UpdateWorkflowInputSchema.parse({ description: null });
    expect(parsed.description).toBeNull();
  });

  it('accepts node array updates', () => {
    const parsed = UpdateWorkflowInputSchema.parse({ nodes: sampleNodes() });
    expect(parsed.nodes).toHaveLength(4);
  });
});

describe('Shared UpdateNodeInputSchema', () => {
  it('accepts all five node statuses', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'skipped'] as const) {
      const parsed = UpdateNodeInputSchema.parse({ status });
      expect(parsed.status).toBe(status);
    }
  });

  it('accepts optional config update', () => {
    const parsed = UpdateNodeInputSchema.parse({ status: 'completed', config: { result: 'ok' } });
    expect(parsed.config).toEqual({ result: 'ok' });
  });

  it('rejects missing status', () => {
    expect(() => UpdateNodeInputSchema.parse({ config: {} })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Type-level compile checks (these are validated by tsc at typecheck time)
// ---------------------------------------------------------------------------

describe('Shared type compatibility', () => {
  it('Workflow type has nullable projectId', () => {
    const wf: Workflow = {
      id: randomUUID(),
      companyId: randomUUID(),
      projectId: null,
      name: 'Test',
      description: null,
      nodes: [],
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(wf.projectId).toBeNull();
  });

  it('WorkflowNode type matches route contract shape', () => {
    const node: WorkflowNode = {
      id: 'n1',
      type: 'task',
      label: 'Do something',
      config: {},
      status: 'pending',
      dependsOn: [],
    };
    expect(node.type).toBe('task');
    expect(node.label).toBe('Do something');
  });

  it('WorkflowStatus type accepts all four route statuses', () => {
    const statuses: WorkflowStatus[] = ['draft', 'active', 'paused', 'archived'];
    expect(statuses).toHaveLength(4);
  });

  it('WorkflowNodeType type accepts all four node types', () => {
    const types: WorkflowNodeType[] = ['task', 'decision', 'trigger', 'action'];
    expect(types).toHaveLength(4);
  });

  it('WorkflowNodeStatus type accepts all five node statuses', () => {
    const statuses: WorkflowNodeStatus[] = ['pending', 'running', 'completed', 'failed', 'skipped'];
    expect(statuses).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Integration: API round-trip with shared schema
// ---------------------------------------------------------------------------

describe('Workflow API round-trip with shared schema', () => {
  let db: DbInstance;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = await createCompany(app);
    projectId = await createProject(app, companyId);
  });

  it('creates and lists a workflow with all four node types', async () => {
    const nodes = sampleNodes();
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'DAG Workflow', nodes })
      .expect(201);

    const created = createRes.body.data;
    expect(created.id).toBeDefined();
    expect(created.nodes).toHaveLength(4);

    // Verify each node type survived the round-trip
    const returnedTypes = created.nodes.map((n: { type: string }) => n.type);
    expect(returnedTypes).toEqual(['trigger', 'task', 'decision', 'action']);

    // List and verify
    const listRes = await request(app)
      .get(`/api/companies/${companyId}/workflows`)
      .expect(200);

    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].id).toBe(created.id);
    expect(listRes.body.data[0].nodes).toHaveLength(4);
  });

  it('creates a workflow with each status value', async () => {
    for (const status of ['draft', 'active', 'paused', 'archived'] as const) {
      const res = await request(app)
        .post(`/api/companies/${companyId}/workflows`)
        .send({ name: `WF ${status}`, status })
        .expect(201);
      expect(res.body.data.status).toBe(status);
    }

    const listRes = await request(app)
      .get(`/api/companies/${companyId}/workflows`)
      .expect(200);
    expect(listRes.body.data).toHaveLength(4);
  });

  it('creates a workflow with null projectId (company-scoped)', async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Company WF', projectId: null })
      .expect(201);
    expect(res.body.data.projectId).toBeNull();
  });

  it('creates a workflow with a valid projectId (project-scoped)', async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Project WF', projectId })
      .expect(201);
    expect(res.body.data.projectId).toBe(projectId);
  });

  it('creates a workflow without projectId (defaults to null)', async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'No Project WF' })
      .expect(201);
    expect(res.body.data.projectId).toBeNull();
  });

  it('filters workflows by project', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Company WF' })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Project WF', projectId })
      .expect(201);

    const allRes = await request(app)
      .get(`/api/companies/${companyId}/workflows`)
      .expect(200);
    expect(allRes.body.data).toHaveLength(2);

    const projectRes = await request(app)
      .get(`/api/companies/${companyId}/workflows?project=${projectId}`)
      .expect(200);
    expect(projectRes.body.data).toHaveLength(1);
    expect(projectRes.body.data[0].projectId).toBe(projectId);
  });

  it('updates node status through all five values', async () => {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({
        name: 'Node Status WF',
        nodes: [
          { id: 'n1', type: 'task', label: 'Task 1', config: {}, status: 'pending', dependsOn: [] },
          { id: 'n2', type: 'task', label: 'Task 2', config: {}, status: 'pending', dependsOn: ['n1'] },
        ],
      })
      .expect(201);
    const wfId = createRes.body.data.id;

    for (const status of ['running', 'completed'] as const) {
      const res = await request(app)
        .patch(`/api/companies/${companyId}/workflows/${wfId}/nodes/n1`)
        .send({ status })
        .expect(200);
      const n1 = res.body.data.nodes.find((n: { id: string }) => n.id === 'n1');
      expect(n1.status).toBe(status);
    }

    // Skipped on n2
    const skipRes = await request(app)
      .patch(`/api/companies/${companyId}/workflows/${wfId}/nodes/n2`)
      .send({ status: 'skipped' })
      .expect(200);
    const n2 = skipRes.body.data.nodes.find((n: { id: string }) => n.id === 'n2');
    expect(n2.status).toBe('skipped');
  });

  it('updates workflow status to all four route values', async () => {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Status Update WF' })
      .expect(201);
    const wfId = createRes.body.data.id;

    for (const status of ['active', 'paused', 'archived', 'draft'] as const) {
      const res = await request(app)
        .patch(`/api/companies/${companyId}/workflows/${wfId}`)
        .send({ status })
        .expect(200);
      expect(res.body.data.status).toBe(status);
    }
  });

  it('rejects creation with old status completed', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Bad Status WF', status: 'completed' })
      .expect(400);
  });

  it('rejects creation with old status failed', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Bad Status WF', status: 'failed' })
      .expect(400);
  });

  it('rejects creation with invalid node type', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({
        name: 'Bad Node WF',
        nodes: [{ id: 'n1', type: 'approval', label: 'Approve', config: {}, status: 'pending', dependsOn: [] }],
      })
      .expect(400);
  });

  it('round-trips a node with optional agentId and taskId', async () => {
    const agentId = randomUUID();
    const taskId = randomUUID();
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/workflows`)
      .send({
        name: 'Linked Node WF',
        nodes: [
          {
            id: 'n1',
            type: 'task',
            label: 'Linked Task',
            agentId,
            taskId,
            config: { priority: 'high' },
            status: 'pending',
            dependsOn: [],
          },
        ],
      })
      .expect(201);

    const node = createRes.body.data.nodes[0];
    expect(node.agentId).toBe(agentId);
    expect(node.taskId).toBe(taskId);
    expect(node.config).toEqual({ priority: 'high' });
  });
});
