import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { RuntimeSessionService } from '../services/runtime-sessions.js';

const execFileAsync = promisify(execFile);

describe('runtime workspace lease binding', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let agentId: string;
  let environmentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    const company = await request(app).post('/api/companies').send({ name: 'Runtime Lease Corp' }).expect(201);
    companyId = company.body.data.id;
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Runtime Lease Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Runtime Lease Environment' })
      .expect(201);
    environmentId = environment.body.data.id;
  });

  async function createSession() {
    return request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId, environmentId, adapterId: 'process:local', adapterConfig: { command: 'echo' } })
      .expect(201);
  }

  it('rejects a recovered lease at run time and protects the next lease from old finalization', async () => {
    const firstSession = await createSession();
    expect(firstSession.body.data.environmentLeaseId).toEqual(expect.any(String));

    await db.drizzle
      .update(db.schema.executionEnvironments)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(
        and(
          eq(db.schema.executionEnvironments.id, environmentId),
          eq(db.schema.executionEnvironments.leaseId, firstSession.body.data.environmentLeaseId),
        ),
      );
    await request(app)
      .post(`/api/companies/${companyId}/environments/${environmentId}/recover`)
      .expect(200);

    const run = await request(app)
      .post(`/api/companies/${companyId}/sessions/${firstSession.body.data.id}/run`)
      .send({ prompt: 'This must not start.' })
      .expect(400);
    expect(run.body.code).toBe('RUNTIME_SESSION_RUN_FAILED');
    expect(run.body.message).toContain('no longer active');

    const secondSession = await createSession();
    expect(secondSession.body.data.environmentLeaseId).not.toBe(firstSession.body.data.environmentLeaseId);
    await request(app)
      .post(`/api/companies/${companyId}/sessions/${firstSession.body.data.id}/finalize`)
      .expect(200);

    const [environment] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environmentId));
    expect(environment).toEqual(expect.objectContaining({
      status: 'leased',
      leaseId: secondSession.body.data.environmentLeaseId,
    }));
  });

  it('finalizes a session that never bound a workspace lease', async () => {
    const created = await createSession();
    const sessionId = created.body.data.id as string;
    const leaseId = created.body.data.environmentLeaseId as string;
    // Sessions created before workspace leases existed have a NULL lease id.
    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({ environmentLeaseId: null })
      .where(eq(db.schema.agentRuntimeSessions.id, sessionId));

    await request(app)
      .post(`/api/companies/${companyId}/sessions/${sessionId}/finalize`)
      .expect(200);

    const [environment] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environmentId));
    expect(environment).toEqual(expect.objectContaining({ status: 'leased', leaseId }));
  });

  it('acquires an inherited available environment so the created session can run', async () => {
    const now = new Date();
    const executionId = randomUUID();
    const command = await realpath('/bin/echo');
    vi.stubEnv('EIDOLON_PROCESS_COMMAND_ALLOWLIST_JSON', JSON.stringify([[command]]));
    vi.stubEnv('EIDOLON_LOCAL_CLI_ALLOWED_AGENTS', `${companyId}:${agentId}`);
    vi.stubEnv('EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND', command);
    vi.stubEnv('EIDOLON_LOCAL_CLI_CONTAINMENT_ARGS_JSON', '[]');
    await db.drizzle.insert(db.schema.agentExecutions).values({
      id: executionId,
      companyId,
      agentId,
      environmentId,
      status: 'running',
      startedAt: now,
      executionMode: 'single',
      createdAt: now,
      updatedAt: now,
    });

    const session = await new RuntimeSessionService(db).createSession({
      companyId,
      agentId,
      executionId,
      adapterId: 'process:local',
      adapterConfig: { command },
    });

    expect(session.environmentId).toBe(environmentId);
    expect(session.environmentLeaseId).toEqual(expect.any(String));

    try {
      const completed = await new RuntimeSessionService(db).runSession(companyId, session.id, {
        prompt: 'Run with the inherited workspace.',
      });
      expect(completed.status, JSON.stringify(completed.transcript)).toBe('completed');

      await new RuntimeSessionService(db).finalizeSession(companyId, session.id);
      const [environment] = await db.drizzle
        .select()
        .from(db.schema.executionEnvironments)
        .where(eq(db.schema.executionEnvironments.id, environmentId));
      expect(environment).toEqual(expect.objectContaining({ status: 'available', leaseId: null }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('captures a diff base when it leases an inherited Git workspace', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-runtime-lease-'));
    vi.stubEnv('EIDOLON_WORKSPACE_ROOT', workspaceRoot);
    try {
      const repository = path.join(workspaceRoot, companyId, 'inherited-repo');
      await fs.mkdir(repository, { recursive: true });
      await execFileAsync('git', ['init'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'tests@eidolon.local'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'Eidolon Tests'], { cwd: repository });
      await fs.writeFile(path.join(repository, 'tracked.txt'), 'before\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repository });
      const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository });

      const inherited = await request(app)
        .post(`/api/companies/${companyId}/environments`)
        .send({ name: 'Inherited Git Workspace', workspacePath: 'inherited-repo', branchName: 'main' })
        .expect(201);
      const inheritedEnvironmentId = inherited.body.data.id as string;

      const now = new Date();
      const executionId = randomUUID();
      await db.drizzle.insert(db.schema.agentExecutions).values({
        id: executionId,
        companyId,
        agentId,
        environmentId: inheritedEnvironmentId,
        status: 'running',
        startedAt: now,
        executionMode: 'single',
        createdAt: now,
        updatedAt: now,
      });

      const session = await new RuntimeSessionService(db).createSession({
        companyId,
        agentId,
        executionId,
        adapterId: 'process:local',
        adapterConfig: { command: 'echo' },
      });
      expect(session.environmentId).toBe(inheritedEnvironmentId);
      expect(session.environmentLeaseId).toEqual(expect.any(String));

      // Without a base SHA the workspace diff endpoint would always fail with
      // WORKSPACE_DIFF_BASE_UNAVAILABLE for inherited leases.
      const [environment] = await db.drizzle
        .select()
        .from(db.schema.executionEnvironments)
        .where(eq(db.schema.executionEnvironments.id, inheritedEnvironmentId));
      expect(environment.leaseBaseSha).toBe(head.trim());

      await request(app)
        .get(`/api/companies/${companyId}/environments/${inheritedEnvironmentId}/diff`)
        .expect(200);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not finalize or release a lease after a concurrent run claim', async () => {
    const created = await createSession();
    const sessionId = created.body.data.id as string;
    const leaseId = created.body.data.environmentLeaseId as string;
    const completedAt = new Date('2026-07-30T18:00:00.000Z');
    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({ status: 'completed', completedAt, updatedAt: completedAt })
      .where(eq(db.schema.agentRuntimeSessions.id, sessionId));

    const originalTransaction = db.drizzle.transaction.bind(db.drizzle);
    let injectedRunClaim = false;
    const runningAt = new Date(completedAt.getTime() + 1);
    const transactionSpy = vi.spyOn(db.drizzle, 'transaction').mockImplementation((async (
      callback: (tx: any) => Promise<unknown>,
      config?: unknown,
    ) => {
      try {
        return await originalTransaction(async (tx: any) => {
          const wrapQuery = (query: any, selectsSession = false): any => new Proxy(query, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (typeof value !== 'function') return value;
              if (property === 'then') return value.bind(target);
              return (...args: any[]) => {
                const next = value.apply(target, args);
                const nextSelectsSession = selectsSession || (
                  property === 'from' && args[0] === db.schema.agentRuntimeSessions
                );
                if (property === 'limit' && nextSelectsSession && !injectedRunClaim) {
                  return Promise.resolve(next).then(async (rows) => {
                    injectedRunClaim = true;
                    await tx
                      .update(db.schema.agentRuntimeSessions)
                      .set({ status: 'running', updatedAt: runningAt })
                      .where(eq(db.schema.agentRuntimeSessions.id, sessionId));
                    return rows;
                  });
                }
                return next && typeof next === 'object'
                  ? wrapQuery(next, nextSelectsSession)
                  : next;
              };
            },
          });
          const wrappedTx = new Proxy(tx, {
            get(target, property) {
              if (property === 'select') {
                return (...args: any[]) => wrapQuery(target.select(...args));
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return callback(wrappedTx);
        }, config as never);
      } catch (error) {
        if (injectedRunClaim) {
          await db.drizzle
            .update(db.schema.agentRuntimeSessions)
            .set({ status: 'running', updatedAt: runningAt })
            .where(eq(db.schema.agentRuntimeSessions.id, sessionId));
        }
        throw error;
      }
    }) as any);

    try {
      await expect(
        new RuntimeSessionService(db).finalizeSession(companyId, sessionId),
      ).rejects.toThrow(`Session ${sessionId} is already being updated`);
    } finally {
      transactionSpy.mockRestore();
    }

    const [[session], [environment]] = await Promise.all([
      db.drizzle
        .select()
        .from(db.schema.agentRuntimeSessions)
        .where(eq(db.schema.agentRuntimeSessions.id, sessionId)),
      db.drizzle
        .select()
        .from(db.schema.executionEnvironments)
        .where(eq(db.schema.executionEnvironments.id, environmentId)),
    ]);
    expect(session.status).toBe('running');
    expect(environment).toEqual(expect.objectContaining({ status: 'leased', leaseId }));
  });
});
