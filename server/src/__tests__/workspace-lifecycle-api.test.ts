import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';

const execFileAsync = promisify(execFile);

describe('managed workspace lifecycle API', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let agentId: string;
  let executionId: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-lifecycle-api-'));
    vi.stubEnv('EIDOLON_WORKSPACE_ROOT', workspaceRoot);
    db = await createTestDb();
    app = createTestApp(db);
    const company = await request(app).post('/api/companies').send({ name: 'Lifecycle API Corp' }).expect(201);
    companyId = company.body.data.id;
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Lifecycle API Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
      .send({})
      .expect(201);
    executionId = execution.body.data.id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  async function createGitEnvironment(): Promise<{ environmentId: string; repository: string }> {
    const repository = path.join(workspaceRoot, companyId, 'managed-repo');
    await fs.mkdir(repository, { recursive: true });
    await execFileAsync('git', ['init'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.email', 'tests@eidolon.local'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.name', 'Eidolon Tests'], { cwd: repository });
    await fs.writeFile(path.join(repository, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repository });

    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Managed Git Workspace', workspacePath: 'managed-repo', branchName: 'main' })
      .expect(201);
    return { environmentId: environment.body.data.id, repository };
  }

  it('captures a diff base, renews the lease, and exposes bounded diff plus history', async () => {
    const { environmentId, repository } = await createGitEnvironment();
    const lease = await request(app)
      .post(`/api/companies/${companyId}/environments/${environmentId}/lease`)
      .send({ agentId, executionId })
      .expect(200);
    expect(lease.body.data).toEqual(expect.objectContaining({
      leaseId: expect.any(String),
      leaseBaseSha: expect.stringMatching(/^[0-9a-f]{40,64}$/),
    }));

    const heartbeat = await request(app)
      .post(`/api/companies/${companyId}/environments/${environmentId}/heartbeat`)
      .send({ agentId, executionId, leaseId: lease.body.data.leaseId })
      .expect(200);
    expect(new Date(heartbeat.body.data.leaseExpiresAt).getTime()).toBeGreaterThan(
      new Date(lease.body.data.leaseExpiresAt).getTime(),
    );

    await fs.writeFile(path.join(repository, 'tracked.txt'), 'after\n');
    await fs.writeFile(path.join(repository, 'untracked.txt'), 'new\n');
    const diff = await request(app)
      .get(`/api/companies/${companyId}/environments/${environmentId}/diff`)
      .expect(200);
    expect(diff.body.data).toEqual(expect.objectContaining({
      environmentId,
      leaseState: 'active',
      branch: 'main',
      clean: false,
      truncated: false,
    }));
    expect(diff.body.data.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', worktreeStatus: 'M' }),
      expect.objectContaining({ path: 'untracked.txt', untracked: true }),
    ]));

    const events = await request(app)
      .get(`/api/companies/${companyId}/environments/${environmentId}/events`)
      .expect(200);
    expect(events.body.data.map((event: { eventType: string }) => event.eventType)).toEqual([
      'leased',
      'created',
    ]);
    expect(events.body.meta.total).toBe(2);
  });

  it('rejects early recovery and recovers an expired lease through the API', async () => {
    const { environmentId } = await createGitEnvironment();
    const lease = await request(app)
      .post(`/api/companies/${companyId}/environments/${environmentId}/lease`)
      .send({ agentId, executionId })
      .expect(200);
    await request(app)
      .post(`/api/companies/${companyId}/environments/${environmentId}/recover`)
      .expect(409);

    await db.drizzle
      .update(db.schema.executionEnvironments)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(
        and(
          eq(db.schema.executionEnvironments.id, environmentId),
          eq(db.schema.executionEnvironments.leaseId, lease.body.data.leaseId),
        ),
      );
    const recovered = await request(app)
      .post(`/api/companies/${companyId}/environments/${environmentId}/recover`)
      .expect(200);
    expect(recovered.body.data).toEqual(expect.objectContaining({ status: 'available', leaseId: null }));

    const events = await request(app)
      .get(`/api/companies/${companyId}/environments/${environmentId}/events`)
      .expect(200);
    expect(events.body.data.map((event: { eventType: string }) => event.eventType)).toEqual([
      'recovered',
      'leased',
      'created',
    ]);
  });
});
