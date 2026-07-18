import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { createTestApp, createTestDb } from '../test-utils.js';
import { errorHandler } from '../middleware/error-handler.js';
import { sessionsRouter } from '../routes/sessions.js';
import { RuntimeSessionService } from '../services/runtime-sessions.js';

describe('Hybrid Jarvis runtime foundation', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let companyId: string;
  let tempDirs: string[];
  let workspaceRoot: string;
  let runtimeRoot: string;

  beforeEach(async () => {
    tempDirs = [];
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-workspace-root-'));
    runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-runtime-root-'));
    tempDirs.push(workspaceRoot, runtimeRoot);
    vi.stubEnv('EIDOLON_WORKSPACE_ROOT', workspaceRoot);
    vi.stubEnv('EIDOLON_RUNTIME_HOME', runtimeRoot);
    vi.stubEnv(
      'EIDOLON_LOCAL_CLI_ENV_ALLOWLIST',
      'FIXTURE_ADAPTER,EIDOLON_TEST_ENV,FIXTURE_MARKER,FIXTURE_MODE',
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-host-provider-value');
    vi.stubEnv('CODEX_API_KEY', 'fixture-codex-key');
    db = await createTestDb();
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Jarvis Runtime Corp', budgetMonthlyCents: 100000 })
      .expect(201);
    companyId = company.body.data.id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function createCliFixture(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eidolon-cli-fixture-'));
    tempDirs.push(dir);
    const executable = path.join(dir, 'fixture-cli');
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const adapter = process.env.FIXTURE_ADAPTER;
  const mode = process.env.FIXTURE_MODE;
  if (mode === "timeout") {
    if (process.env.FIXTURE_MARKER) {
      require("node:fs").writeFileSync(process.env.FIXTURE_MARKER, "started");
    }
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "fail") {
    process.stderr.write("fixture authentication failed\\n");
    process.exit(3);
  }
  const args = process.argv.slice(2);
  const resumeIndex = adapter === "codex"
    ? args.indexOf("resume")
    : args.indexOf("--resume");
  const resumedSession = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
  const sessionId = resumedSession || (adapter === "codex"
    ? "22222222-2222-4222-8222-222222222222"
    : "11111111-1111-4111-8111-111111111111");
  if (mode === "background") {
    const child = require("node:child_process").spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    child.unref();
    require("node:fs").writeFileSync(process.env.FIXTURE_MARKER, String(child.pid));
  }
  if (adapter === "codex") {
    console.log(JSON.stringify({ type: "thread.started", thread_id: sessionId }));
  } else {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  }
  console.log(JSON.stringify({
    type: "fixture.meta",
    cwd: process.cwd(),
    env: process.env.EIDOLON_TEST_ENV,
    codexHome: process.env.CODEX_HOME || null,
    anthropicKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
    hostAnthropicKeyLeaked:
      process.env.ANTHROPIC_API_KEY === "fixture-host-provider-value",
    anthropicAuthTokenPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null,
    codexKeyPresent: Boolean(process.env.CODEX_API_KEY),
    hostCodexKeyLeaked:
      process.env.CODEX_API_KEY === "fixture-codex-key",
    subprocessScrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB || null,
    args,
  }));
  if (mode === "unicode") {
    const line = Buffer.from(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hello 👋 from codex" },
    }) + "\\n");
    const emojiStart = line.indexOf(Buffer.from("👋"));
    process.stdout.write(line.subarray(0, emojiStart + 2));
    setTimeout(() => process.stdout.write(line.subarray(emojiStart + 2)), 25);
    return;
  }
  if (mode === "many-lines") {
    for (let index = 0; index < 5001; index += 1) {
      console.log(JSON.stringify({ type: "fixture.progress", index }));
    }
  }
  if (mode === "large-json") {
    console.log(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "L".repeat(150000) },
    }));
    return;
  }
  if (adapter === "codex") {
    console.log(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "hello from codex: " + prompt.trim() },
    }));
  } else {
    console.log(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "hello from claude: " + prompt.trim(),
    }));
  }
});
`,
      { mode: 0o755 },
    );
    const containmentWrapper = path.join(dir, 'containment-wrapper');
    await fs.writeFile(
      containmentWrapper,
      '#!/bin/sh\nexec "$@"\n',
      { mode: 0o755 },
    );
    const gatewayTokenHelper = path.join(dir, 'gateway-token-helper');
    await fs.writeFile(
      gatewayTokenHelper,
      '#!/bin/sh\nprintf %s test-value\n',
      { mode: 0o755 },
    );
    vi.stubEnv('EIDOLON_CODEX_CLI_COMMAND', executable);
    vi.stubEnv('EIDOLON_CLAUDE_CLI_COMMAND', executable);
    vi.stubEnv('EIDOLON_CODEX_GATEWAY_URL', 'https://gateway.example.test/v1');
    vi.stubEnv('EIDOLON_CODEX_GATEWAY_TOKEN_COMMAND', gatewayTokenHelper);
    vi.stubEnv('EIDOLON_CLAUDE_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubEnv('EIDOLON_CLAUDE_GATEWAY_TOKEN_COMMAND', gatewayTokenHelper);
    vi.stubEnv('EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND', containmentWrapper);
    vi.stubEnv('EIDOLON_LOCAL_CLI_CONTAINMENT_ARGS_JSON', '[]');
    return executable;
  }

  async function createWorkspace(name: string): Promise<string> {
    const workspace = path.join(workspaceRoot, companyId, name);
    await fs.mkdir(workspace, { recursive: true });
    return fs.realpath(workspace);
  }

  async function createManagedEnvironment(workspacePath: string): Promise<string> {
    const id = randomUUID();
    await db.drizzle.insert(db.schema.executionEnvironments).values({
      id,
      companyId,
      name: 'Managed CLI Workspace',
      workspacePath,
    });
    return id;
  }

  function authorizeAgent(agentId: string): void {
    const authorization = `${companyId}:${agentId}`;
    const existing = process.env.EIDOLON_LOCAL_CLI_ALLOWED_AGENTS;
    vi.stubEnv(
      'EIDOLON_LOCAL_CLI_ALLOWED_AGENTS',
      existing ? `${existing},${authorization}` : authorization,
    );
  }

  it('exposes provider and runtime-only adapter descriptors', async () => {
    const res = await request(app).get('/api/runtime/adapters').expect(200);
    const ids = res.body.data.map((adapter: any) => adapter.id);

    expect(ids).toContain('provider:anthropic');
    expect(ids).toContain('codex_local');
    expect(ids).toContain('claude_local');
    expect(ids).toContain('process:local');
    expect(ids).toContain('http:remote');
    expect(ids).toContain('openclaw:webhook');
    expect(ids).toContain('mcp:tool-runtime');
    expect(ids).toContain('openjarvis:local');
    expect(
      res.body.data.find((adapter: any) => adapter.id === 'codex_local')
        .capabilities.browser,
    ).toBe(false);
    expect(
      res.body.data.find((adapter: any) => adapter.id === 'claude_local')
        .capabilities.browser,
    ).toBe(false);

    const openJarvis = res.body.data.find((adapter: any) => adapter.id === 'openjarvis:local');
    expect(openJarvis.capabilities.voice).toBe(true);
    expect(openJarvis.capabilities.browser).toBe(true);
    expect(openJarvis.supportedModes).toContain('continuous');
  });

  it('runs and resumes Codex locally with isolated state and structured transcripts', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('codex');
    const environmentId = await createManagedEnvironment(workspace);
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Codex Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          model: 'codex-default',
          env: {
            FIXTURE_ADAPTER: 'codex',
            EIDOLON_TEST_ENV: 'codex-env-ok',
          },
          timeoutSec: 5,
          graceSec: 1,
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({})
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
        environmentId,
      })
      .expect(201);

    const firstRun = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Respond with hello.' })
      .expect(200);

    expect(
      firstRun.body.data.status,
      JSON.stringify(firstRun.body.data.transcript),
    ).toBe('completed');
    expect(firstRun.body.data.resumeState.sessionId).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(firstRun.body.data.resumeState.cwd).toBe(workspace);
    expect(firstRun.body.data.resumeState.codexHome).toContain(environmentId);
    const firstMeta = firstRun.body.data.transcript.find(
      (entry: any) => entry.data?.type === 'fixture.meta',
    );
    expect(firstMeta.data.cwd).toBe(workspace);
    expect(firstMeta.data.env).toBe('codex-env-ok');
    expect(firstMeta.data.codexHome).toBe(firstRun.body.data.resumeState.codexHome);
    expect(firstMeta.data.anthropicKeyPresent).toBe(false);
    expect(firstMeta.data.codexKeyPresent).toBe(true);
    expect(firstMeta.data.hostCodexKeyLeaked).toBe(false);
    expect(firstMeta.data.subprocessScrub).toBeNull();
    expect(firstMeta.data.args).toContain('--skip-git-repo-check');
    expect(firstMeta.data.args).not.toContain('codex-default');
    expect(firstMeta.data.args).toEqual(
      expect.arrayContaining([
        '--strict-config',
        '--disable',
        'shell_snapshot',
        'approval_policy="never"',
        'allow_login_shell=false',
        'default_permissions="eidolon"',
        'permissions.eidolon.filesystem.:minimal="read"',
        'permissions.eidolon.filesystem.:workspace_roots="write"',
        'permissions.eidolon.network.enabled=false',
        'shell_environment_policy.inherit="all"',
        'model_provider="eidolon_gateway"',
        'model_providers.eidolon_gateway.name="Eidolon Gateway"',
        'model_providers.eidolon_gateway.base_url="https://gateway.example.test/v1"',
        'model_providers.eidolon_gateway.env_key="CODEX_API_KEY"',
        'model_providers.eidolon_gateway.wire_api="responses"',
        'model_providers.eidolon_gateway.requires_openai_auth=false',
      ]),
    );
    const toolEnvPolicy = firstMeta.data.args.find(
      (arg: string) => arg.startsWith('shell_environment_policy.include_only='),
    );
    expect(toolEnvPolicy).toContain('EIDOLON_TEST_ENV');
    expect(toolEnvPolicy).toContain('FIXTURE_ADAPTER');
    expect(toolEnvPolicy).not.toContain('CODEX_API_KEY');
    const [recordedExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    expect(recordedExecution.status).toBe('completed');
    expect(recordedExecution.provider).toBe('codex_local');
    expect(recordedExecution.log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'codex_local fixture.meta',
          phase: 'act',
        }),
      ]),
    );

    const resumed = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Continue the session.' })
      .expect(200);
    const resumedMeta = [...resumed.body.data.transcript]
      .reverse()
      .find((entry: any) => entry.data?.type === 'fixture.meta');

    expect(resumed.body.data.status).toBe('completed');
    expect(resumedMeta.data.args).toEqual(
      expect.arrayContaining([
        'resume',
        '22222222-2222-4222-8222-222222222222',
        '-',
      ]),
    );
    expect(resumed.body.data.transcript).toHaveLength(
      firstRun.body.data.transcript.length + 4,
    );
  });

  it('reopens a linked execution while resuming a completed session', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('resume-execution');
    const environmentId = await createManagedEnvironment(workspace);
    const marker = path.join(workspace, 'resumed-run-started');
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Resumed Execution Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          env: { FIXTURE_ADAPTER: 'codex' },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({})
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
        environmentId,
      })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Complete the first run.' })
      .expect(200);
    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({
        adapterConfig: {
          env: {
            FIXTURE_ADAPTER: 'codex',
            FIXTURE_MARKER: marker,
            FIXTURE_MODE: 'timeout',
          },
          timeoutSec: 30,
          graceSec: 1,
        },
      })
      .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));

    const resumedRun = request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Resume and wait.' })
      .then((response) => response);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fs.access(marker);
        break;
      } catch {
        if (attempt === 49) throw new Error('Resumed CLI fixture did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const [runningExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    expect(runningExecution.status).toBe('running');
    expect(runningExecution.completedAt).toBeNull();
    expect(runningExecution.summary).toBeNull();
    expect(runningExecution.error).toBeNull();
    expect(runningExecution.lastUsefulAction).toBe('local_cli_started');

    await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({ reason: 'resume state verified' })
      .expect(200);
    const stoppedRun = await resumedRun;
    expect(stoppedRun.body.data.status).toBe('cancelled');
  });

  it('decodes local CLI output across UTF-8 chunk boundaries', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('unicode');
    const environmentId = await createManagedEnvironment(workspace);
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Unicode Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          env: {
            FIXTURE_ADAPTER: 'codex',
            FIXTURE_MODE: 'unicode',
          },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id, environmentId })
      .expect(201);

    const run = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Respond with Unicode.' })
      .expect(200);

    expect(run.body.data.status).toBe('completed');
    expect(run.body.data.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            item: expect.objectContaining({ text: 'hello 👋 from codex' }),
          }),
        }),
      ]),
    );
  });

  it('parses oversized structured result events before bounding storage', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('large-json');
    const environmentId = await createManagedEnvironment(workspace);
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Large Result Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          env: {
            FIXTURE_ADAPTER: 'codex',
            FIXTURE_MODE: 'large-json',
          },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id, environmentId })
      .expect(201);

    const run = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Return a large result.' })
      .expect(200);
    const resultEvent = run.body.data.transcript.find(
      (entry: any) => entry.data?.type === 'item.completed',
    );

    expect(run.body.data.status).toBe('completed');
    expect(resultEvent.kind).toBe('json');
    expect(resultEvent.data._eidolon).toEqual(
      expect.objectContaining({
        truncated: true,
        originalBytes: expect.any(Number),
      }),
    );
    expect(resultEvent.data.item.text.length).toBeLessThan(150_000);
  });

  it('runs and resumes Claude locally with cwd and environment propagation', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('claude');
    const environmentId = await createManagedEnvironment(workspace);
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Claude Worker',
        role: 'engineer',
        adapterId: 'claude_local',
        adapterConfig: {
          model: 'claude-default',
          env: {
            FIXTURE_ADAPTER: 'claude',
            EIDOLON_TEST_ENV: 'claude-env-ok',
          },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id, environmentId })
      .expect(201);

    const firstRun = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Respond with hello.' })
      .expect(200);
    expect(firstRun.body.data.status).toBe('completed');
    expect(firstRun.body.data.resumeState.sessionId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    const firstMeta = firstRun.body.data.transcript.find(
      (entry: any) => entry.data?.type === 'fixture.meta',
    );
    expect(firstMeta.data.cwd).toBe(workspace);
    expect(firstMeta.data.env).toBe('claude-env-ok');
    expect(firstMeta.data.anthropicKeyPresent).toBe(true);
    expect(firstMeta.data.hostAnthropicKeyLeaked).toBe(false);
    expect(firstMeta.data.anthropicAuthTokenPresent).toBe(false);
    expect(firstMeta.data.anthropicBaseUrl).toBe('https://gateway.example.test');
    expect(firstMeta.data.codexKeyPresent).toBe(false);
    expect(firstMeta.data.subprocessScrub).toBe('1');
    expect(firstMeta.data.args).not.toContain('claude-default');
    expect(firstMeta.data.args).toEqual(
      expect.arrayContaining([
        '--bare',
        '--safe-mode',
        '--strict-mcp-config',
        '--permission-mode',
        'bypassPermissions',
        '--tools',
        'default',
      ]),
    );

    const resumed = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Continue the session.' })
      .expect(200);
    const resumedMeta = [...resumed.body.data.transcript]
      .reverse()
      .find((entry: any) => entry.data?.type === 'fixture.meta');
    expect(resumedMeta.data.args).toEqual(
      expect.arrayContaining([
        '--resume',
        '11111111-1111-4111-8111-111111111111',
      ]),
    );
  });

  it('uses one isolated Codex home safely across concurrent sessions', async () => {
    await createCliFixture();
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Concurrent Codex Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          env: { FIXTURE_ADAPTER: 'codex' },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/sessions`)
        .send({ agentId: agent.body.data.id })
        .expect(201),
      request(app)
        .post(`/api/companies/${companyId}/sessions`)
        .send({ agentId: agent.body.data.id })
        .expect(201),
    ]);

    const [firstRun, secondRun] = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/sessions/${first.body.data.id}/run`)
        .send({ prompt: 'First concurrent run.' })
        .expect(200),
      request(app)
        .post(`/api/companies/${companyId}/sessions/${second.body.data.id}/run`)
        .send({ prompt: 'Second concurrent run.' })
        .expect(200),
    ]);

    expect(firstRun.body.data.status).toBe('completed');
    expect(secondRun.body.data.status).toBe('completed');
    const codexHome = path.join(
      runtimeRoot,
      companyId,
      agent.body.data.id,
      'codex_local',
      'codex-home',
    );
    expect(firstRun.body.data.resumeState.codexHome).toBe(codexHome);
    expect(secondRun.body.data.resumeState.codexHome).toBe(codexHome);
    const firstMeta = firstRun.body.data.transcript.find(
      (entry: any) => entry.data?.type === 'fixture.meta',
    );
    const secondMeta = secondRun.body.data.transcript.find(
      (entry: any) => entry.data?.type === 'fixture.meta',
    );
    expect(firstMeta.data.cwd).toContain(first.body.data.id);
    expect(secondMeta.data.cwd).toContain(second.body.data.id);
    expect(firstMeta.data.cwd).not.toBe(secondMeta.data.cwd);
    await expect(fs.lstat(path.join(codexHome, 'auth.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('isolates local CLI state when an environment is reused by another agent', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('reused-environment');
    const environmentId = await createManagedEnvironment(workspace);
    const firstAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'First Environment Owner',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: { env: { FIXTURE_ADAPTER: 'codex' } },
      })
      .expect(201);
    const secondAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Second Environment Owner',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: { env: { FIXTURE_ADAPTER: 'codex' } },
      })
      .expect(201);
    authorizeAgent(firstAgent.body.data.id);
    authorizeAgent(secondAgent.body.data.id);

    const firstSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: firstAgent.body.data.id, environmentId })
      .expect(201);
    const firstRun = await request(app)
      .post(`/api/companies/${companyId}/sessions/${firstSession.body.data.id}/run`)
      .send({ prompt: 'First owner.' })
      .expect(200);
    await request(app)
      .post(`/api/companies/${companyId}/sessions/${firstSession.body.data.id}/finalize`)
      .expect(200);

    const secondSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: secondAgent.body.data.id, environmentId })
      .expect(201);
    const secondRun = await request(app)
      .post(`/api/companies/${companyId}/sessions/${secondSession.body.data.id}/run`)
      .send({ prompt: 'Second owner.' })
      .expect(200);

    expect(firstRun.body.data.resumeState.codexHome).toContain(firstAgent.body.data.id);
    expect(firstRun.body.data.resumeState.codexHome).toContain(environmentId);
    expect(secondRun.body.data.resumeState.codexHome).toContain(secondAgent.body.data.id);
    expect(secondRun.body.data.resumeState.codexHome).toContain(environmentId);
    expect(secondRun.body.data.resumeState.codexHome).not.toBe(
      firstRun.body.data.resumeState.codexHome,
    );
  });

  it('bounds cumulative session transcripts and execution logs', async () => {
    await createCliFixture();
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Bounded Codex Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          env: {
            FIXTURE_ADAPTER: 'codex',
            FIXTURE_MODE: 'many-lines',
          },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({})
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
      })
      .expect(201);
    const timestamp = new Date().toISOString();
    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({
        transcript: Array.from({ length: 5_000 }, (_, index) => ({
          timestamp,
          stream: 'system' as const,
          kind: 'text' as const,
          content: `old transcript ${index}`,
        })),
      })
      .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));
    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({
        log: Array.from({ length: 5_000 }, (_, index) => ({
          timestamp,
          level: 'info',
          message: `old log ${index}`,
        })),
      })
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));

    const completed = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Record bounded output.' })
      .expect(200);
    const [recordedExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));

    expect(completed.body.data.transcript).toHaveLength(5_000);
    expect(completed.body.data.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            item: expect.objectContaining({
              text: expect.stringContaining('Record bounded output.'),
            }),
          }),
        }),
      ]),
    );
    expect(recordedExecution.log).toHaveLength(5_000);
    expect(recordedExecution.log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'codex_local item.completed' }),
      ]),
    );
  });

  it('rejects tenant-controlled CLI arguments and permission bypasses', async () => {
    await createCliFixture();
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Unsafe Local Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          args: ['--dangerously-bypass-approvals-and-sandbox'],
          dangerouslyBypassApprovalsAndSandbox: true,
          env: { FIXTURE_ADAPTER: 'codex' },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);
    const rejected = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Escape the workspace.' })
      .expect(200);

    expect(rejected.body.data.status).toBe('failed');
    expect(rejected.body.data.transcript.at(-1).data.message).toContain(
      'adapterConfig.args is not allowed',
    );
  });

  it('rejects adapter env that can alter the unsandboxed host launcher', async () => {
    await createCliFixture();
    vi.stubEnv(
      'EIDOLON_LOCAL_CLI_ENV_ALLOWLIST',
      `${process.env.EIDOLON_LOCAL_CLI_ENV_ALLOWLIST},Node_Options,ANTHROPIC_BASE_URL`,
    );
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Unsafe Environment Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          env: {
            FIXTURE_ADAPTER: 'codex',
            Node_Options: '--require ./workspace-payload.js',
          },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);
    const rejected = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Do not load host code.' })
      .expect(200);

    expect(rejected.body.data.status).toBe('failed');
    expect(rejected.body.data.transcript.at(-1).data.message).toContain(
      'Node_Options',
    );

    const routingAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Credential Routing Worker',
        role: 'engineer',
        adapterId: 'claude_local',
        adapterConfig: {
          env: {
            FIXTURE_ADAPTER: 'claude',
            ANTHROPIC_BASE_URL: 'https://attacker.example',
          },
        },
      })
      .expect(201);
    authorizeAgent(routingAgent.body.data.id);
    const routingSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: routingAgent.body.data.id })
      .expect(201);
    const routingRejected = await request(app)
      .post(`/api/companies/${companyId}/sessions/${routingSession.body.data.id}/run`)
      .send({ prompt: 'Do not redirect credentials.' })
      .expect(200);

    expect(routingRejected.body.data.status).toBe('failed');
    expect(routingRejected.body.data.transcript.at(-1).data.message).toContain(
      'ANTHROPIC_BASE_URL',
    );
  });

  it('keeps a bounded default timeout when tenant config supplies zero', async () => {
    await createCliFixture();
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Bounded Timeout Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          timeoutSec: 0,
          env: { FIXTURE_ADAPTER: 'codex' },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);
    const completed = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Complete with a bounded timeout.' })
      .expect(200);

    expect(completed.body.data.status).toBe('completed');
    expect(completed.body.data.transcript.at(-1).data.timeoutSec).toBe(600);
  });

  it('requires operator authorization before launching a local CLI', async () => {
    await createCliFixture();
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Unauthorized Local Worker',
        role: 'engineer',
        adapterId: 'claude_local',
        adapterConfig: {
          env: { FIXTURE_ADAPTER: 'claude' },
        },
      })
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);
    const rejected = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Do not launch.' })
      .expect(200);

    expect(rejected.body.data.status).toBe('failed');
    expect(rejected.body.data.transcript.at(-1).data.message).toContain(
      'is not operator-authorized',
    );
  });

  it('rejects option-like resume state before invoking Codex', async () => {
    await createCliFixture();
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Resume Guard Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          env: { FIXTURE_ADAPTER: 'codex' },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        resumeState: { sessionId: '--last' },
      })
      .expect(201);
    const rejected = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Do not resume another session.' })
      .expect(200);

    expect(rejected.body.data.status).toBe('failed');
    expect(rejected.body.data.transcript.at(-1).data.message).toBe(
      'Codex session ID must be a UUID.',
    );
  });

  it('requires an operator-managed descendant containment launcher', async () => {
    await createCliFixture();
    vi.stubEnv('EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND', '');
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Uncontained Local Worker',
        role: 'engineer',
        adapterId: 'claude_local',
        adapterConfig: {
          env: { FIXTURE_ADAPTER: 'claude' },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);
    const rejected = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Do not launch.' })
      .expect(200);

    expect(rejected.body.data.status).toBe('failed');
    expect(rejected.body.data.transcript.at(-1).data.message).toContain(
      'EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND',
    );
  });

  it('rejects unsupported run adapters without mutating the session', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'MCP Runtime Worker',
        role: 'engineer',
        adapterId: 'mcp:tool-runtime',
      })
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);

    const rejected = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Do not run.' })
      .expect(400);
    const [persisted] = await db.drizzle
      .select()
      .from(db.schema.agentRuntimeSessions)
      .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));

    expect(rejected.body.message).toContain('unsupported run adapter');
    expect(persisted.status).toBe('running');
    expect(persisted.transcript).toEqual([]);
  });

  it('tests and runs an operator-approved process adapter with structured logs', async () => {
    const command = await createCliFixture();
    vi.stubEnv(
      'EIDOLON_PROCESS_COMMAND_ALLOWLIST_JSON',
      JSON.stringify([[command]]),
    );
    const workspace = await createWorkspace('process');
    const environmentId = await createManagedEnvironment(workspace);
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Process Worker',
        role: 'engineer',
        adapterId: 'process:local',
        adapterConfig: {
          command,
          args: [],
          env: { FIXTURE_ADAPTER: 'process' },
          timeoutSec: 5,
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({})
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
        environmentId,
      })
      .expect(201);

    expect(created.body.data.status).toBe('queued');
    const diagnostic = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/test`)
      .expect(200);
    expect(diagnostic.body.data).toMatchObject({
      ok: true,
      adapterId: 'process:local',
      command,
    });

    const completed = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Process this request.' })
      .expect(200);
    expect(completed.body.data.status).toBe('completed');
    expect(
      completed.body.data.transcript.some(
        (entry: any) => entry.data?.type === 'fixture.meta',
      ),
    ).toBe(true);

    const [recordedExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    expect(recordedExecution.provider).toBe('process:local');
    expect(recordedExecution.lastUsefulAction).toBe(
      'runtime_adapter_response_recorded',
    );
    expect(recordedExecution.log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'process:local fixture.meta',
          phase: 'act',
        }),
      ]),
    );
  });

  it('tests and runs HTTP and OpenClaw webhook adapters', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const contentLengths: string[] = [];
    const remote = createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(req.url === '/no-head' ? 405 : 204).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push(JSON.parse(body) as Record<string, unknown>);
        contentLengths.push(req.headers['content-length'] ?? '');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          summary: 'accepted',
          privateData: 'response-marker',
        }));
      });
    });
    remote.listen(0, '127.0.0.1');
    await once(remote, 'listening');
    const address = remote.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server address.');
    }
    const redactedUrl = `http://localhost:${address.port}/hooks/agent`;
    const url = `${redactedUrl}?trace=redaction-marker#fragment`;
    vi.stubEnv(
      'EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON',
      JSON.stringify({
        [`http://localhost:${address.port}`]: ['127.0.0.1'],
      }),
    );

    try {
      const httpAgent = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({
          name: 'HTTP Worker',
          role: 'engineer',
          adapterId: 'http:remote',
          adapterConfig: {
            url,
            payload: { source: 'eidolon-test' },
            responseFields: ['summary'],
            timeoutSec: 1.2345,
          },
        })
        .expect(201);
      const httpExecution = await request(app)
        .post(`/api/companies/${companyId}/agents/${httpAgent.body.data.id}/executions`)
        .send({})
        .expect(201);
      const httpSession = await request(app)
        .post(`/api/companies/${companyId}/sessions`)
        .send({
          agentId: httpAgent.body.data.id,
          executionId: httpExecution.body.data.id,
        })
        .expect(201);
      await request(app)
        .post(`/api/companies/${companyId}/sessions/${httpSession.body.data.id}/test`)
        .expect(({ body }) => {
          expect(body.data.url).toBe(redactedUrl);
          expect(JSON.stringify(body)).not.toContain('redaction-marker');
        })
        .expect(200);
      const httpRun = await request(app)
        .post(`/api/companies/${companyId}/sessions/${httpSession.body.data.id}/run`)
        .send({ prompt: 'Dispatch over HTTP.' })
        .expect(200);

      expect(httpRun.body.data.status).toBe('completed');
      expect(JSON.stringify(httpRun.body.data.transcript)).not.toContain(
        'redaction-marker',
      );
      expect(JSON.stringify(httpRun.body.data.transcript)).not.toContain(
        'response-marker',
      );
      expect(
        httpRun.body.data.transcript.find(
          (entry: any) => entry.kind === 'diagnostic',
        )?.data.url,
      ).toBe(redactedUrl);
      expect(
        httpRun.body.data.transcript.find(
          (entry: any) => entry.kind === 'json',
        )?.data,
      ).toEqual({ summary: 'accepted' });
      expect(requests[0]).toMatchObject({
        source: 'eidolon-test',
        prompt: 'Dispatch over HTTP.',
        companyId,
        agentId: httpAgent.body.data.id,
        sessionId: httpSession.body.data.id,
      });
      expect(contentLengths[0]).toBe(
        String(Buffer.byteLength(JSON.stringify(requests[0]))),
      );
      const [httpRecordedExecution] = await db.drizzle
        .select()
        .from(db.schema.agentExecutions)
        .where(eq(db.schema.agentExecutions.id, httpExecution.body.data.id));
      expect(httpRecordedExecution.provider).toBe('http:remote');
      expect(httpRecordedExecution.log).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'http:remote diagnostic',
            phase: 'act',
          }),
        ]),
      );

      const openClawAgent = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({
          name: 'OpenClaw Worker',
          role: 'engineer',
          adapterId: 'openclaw:webhook',
          adapterConfig: {
            url,
            agentId: 'researcher',
            headers: { authorization: 'Bearer test-token' },
          },
        })
        .expect(201);
      const openClawSession = await request(app)
        .post(`/api/companies/${companyId}/sessions`)
        .send({ agentId: openClawAgent.body.data.id })
        .expect(201);
      await request(app)
        .post(`/api/companies/${companyId}/sessions/${openClawSession.body.data.id}/test`)
        .expect(200);
      const openClawRun = await request(app)
        .post(`/api/companies/${companyId}/sessions/${openClawSession.body.data.id}/run`)
        .send({ prompt: 'Wake OpenClaw.' })
        .expect(200);

      expect(openClawRun.body.data.status).toBe('completed');
      expect(requests[1]).toEqual({
        message: 'Wake OpenClaw.',
        agentId: 'researcher',
        deliver: true,
      });
      expect(contentLengths[1]).toBe(
        String(Buffer.byteLength(JSON.stringify(requests[1]))),
      );
      expect(JSON.stringify(openClawRun.body.data.transcript)).not.toContain(
        'response-marker',
      );

      const oversizedAgent = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({
          name: 'Oversized HTTP Worker',
          role: 'engineer',
          adapterId: 'http:remote',
          adapterConfig: {
            url,
            payload: { input: 'x'.repeat(300_000) },
          },
        })
        .expect(201);
      const oversizedSession = await request(app)
        .post(`/api/companies/${companyId}/sessions`)
        .send({ agentId: oversizedAgent.body.data.id })
        .expect(201);
      const oversizedDiagnostic = await request(app)
        .post(`/api/companies/${companyId}/sessions/${oversizedSession.body.data.id}/test`)
        .expect(400);
      expect(oversizedDiagnostic.body.message).toContain(
        'the limit is 262144 bytes',
      );
      const oversizedRun = await request(app)
        .post(`/api/companies/${companyId}/sessions/${oversizedSession.body.data.id}/run`)
        .send({ prompt: 'Reject this request.' })
        .expect(200);
      expect(oversizedRun.body.data.status).toBe('failed');
      expect(oversizedRun.body.data.transcript.at(-1).data.message).toContain(
        'the limit is 262144 bytes',
      );

      const noHeadAgent = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({
          name: 'No HEAD Worker',
          role: 'engineer',
          adapterId: 'http:remote',
          adapterConfig: {
            url: `http://localhost:${address.port}/no-head`,
          },
        })
        .expect(201);
      const noHeadSession = await request(app)
        .post(`/api/companies/${companyId}/sessions`)
        .send({ agentId: noHeadAgent.body.data.id })
        .expect(201);
      const noHeadDiagnostic = await request(app)
        .post(`/api/companies/${companyId}/sessions/${noHeadSession.body.data.id}/test`)
        .expect(200);
      expect(noHeadDiagnostic.body.data).toMatchObject({
        ok: false,
        reachable: true,
        inconclusive: true,
        status: 405,
      });
    } finally {
      remote.close();
      await once(remote, 'close');
    }
  });

  it('requires a platform operator to test a runtime adapter', async () => {
    const guardedApp = express();
    guardedApp.use((req, _res, next) => {
      req.user = {
        id: 'tenant-admin',
        name: 'Tenant Admin',
        email: 'tenant-admin@example.test',
        role: 'user',
      };
      next();
    });
    guardedApp.use(
      '/api/companies/:companyId/sessions',
      sessionsRouter(db),
    );
    guardedApp.use(errorHandler);

    const response = await request(guardedApp)
      .post(`/api/companies/${companyId}/sessions/${randomUUID()}/test`)
      .expect(403);
    expect(response.body.code).toBe('RUNTIME_SESSION_OPERATOR_REQUIRED');
  });

  it('returns actionable diagnostics for blocked process and remote adapter configs', async () => {
    const command = await createCliFixture();
    const processAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Blocked Process Worker',
        role: 'engineer',
        adapterId: 'process:local',
        adapterConfig: { command },
      })
      .expect(201);
    authorizeAgent(processAgent.body.data.id);
    const processSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: processAgent.body.data.id })
      .expect(201);
    const processDiagnostic = await request(app)
      .post(`/api/companies/${companyId}/sessions/${processSession.body.data.id}/test`)
      .expect(400);
    expect(processDiagnostic.body.code).toBe('RUNTIME_ADAPTER_TEST_FAILED');
    expect(processDiagnostic.body.message).toContain(
      'EIDOLON_PROCESS_COMMAND_ALLOWLIST_JSON',
    );

    vi.stubEnv(
      'EIDOLON_PROCESS_COMMAND_ALLOWLIST_JSON',
      JSON.stringify([[workspaceRoot]]),
    );
    const directoryAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Directory Process Worker',
        role: 'engineer',
        adapterId: 'process:local',
        adapterConfig: { command: workspaceRoot },
      })
      .expect(201);
    authorizeAgent(directoryAgent.body.data.id);
    const directorySession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: directoryAgent.body.data.id })
      .expect(201);
    const directoryDiagnostic = await request(app)
      .post(`/api/companies/${companyId}/sessions/${directorySession.body.data.id}/test`)
      .expect(400);
    expect(directoryDiagnostic.body.message).toContain(
      'regular executable file',
    );

    const httpAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Blocked HTTP Worker',
        role: 'engineer',
        adapterId: 'http:remote',
        adapterConfig: { url: 'http://192.0.2.1/runtime' },
      })
      .expect(201);
    const httpSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: httpAgent.body.data.id })
      .expect(201);
    const httpDiagnostic = await request(app)
      .post(`/api/companies/${companyId}/sessions/${httpSession.body.data.id}/test`)
      .expect(400);
    expect(httpDiagnostic.body.code).toBe('RUNTIME_ADAPTER_TEST_FAILED');
    expect(httpDiagnostic.body.message).toContain(
      'EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON',
    );

    const failedRun = await request(app)
      .post(`/api/companies/${companyId}/sessions/${httpSession.body.data.id}/run`)
      .send({ prompt: 'Do not dispatch.' })
      .expect(200);
    expect(failedRun.body.data.status).toBe('failed');
    expect(failedRun.body.data.transcript.at(-1).data.message).toContain(
      'EIDOLON_RUNTIME_HTTP_ORIGIN_ALLOWLIST_JSON',
    );
  });

  it('records actionable local CLI failures and enforces timeout grace periods', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('timeout');
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Failing Local Worker',
        role: 'engineer',
        adapterId: 'claude_local',
        adapterConfig: {
          cwd: workspace,
          env: {
            FIXTURE_ADAPTER: 'claude',
            FIXTURE_MODE: 'fail',
          },
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);
    const failed = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Respond with hello.' })
      .expect(200);
    const failureDiagnostic = failed.body.data.transcript.at(-1);

    expect(failed.body.data.status).toBe('failed');
    expect(failureDiagnostic.data.message).toContain('fixture authentication failed');
    expect(failureDiagnostic.data.exitCode).toBe(3);

    const timeoutAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Timed Out Local Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          cwd: workspace,
          env: {
            FIXTURE_ADAPTER: 'codex',
            FIXTURE_MODE: 'timeout',
          },
          timeoutSec: 0.05,
          graceSec: 0.05,
        },
      })
      .expect(201);
    authorizeAgent(timeoutAgent.body.data.id);
    const timeoutSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: timeoutAgent.body.data.id })
      .expect(201);
    const timedOut = await request(app)
      .post(`/api/companies/${companyId}/sessions/${timeoutSession.body.data.id}/run`)
      .send({ prompt: 'Respond with hello.' })
      .expect(200);
    const timeoutDiagnostic = timedOut.body.data.transcript.at(-1);

    expect(timedOut.body.data.status).toBe('failed');
    expect(timeoutDiagnostic.data.timedOut).toBe(true);
    expect(timeoutDiagnostic.data.message).toContain('configured timeout');
    expect(timeoutDiagnostic.data.durationMs).toBeLessThan(2_000);
  });

  it('cleans up background descendants when the CLI exits normally', async () => {
    await createCliFixture();
    const workspace = await createWorkspace('background-cleanup');
    const marker = path.join(workspace, 'background-pid');
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Background Cleanup Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          cwd: workspace,
          env: {
            FIXTURE_ADAPTER: 'codex',
            FIXTURE_MARKER: marker,
            FIXTURE_MODE: 'background',
          },
          graceSec: 0.1,
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);

    const completed = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Clean up descendants.' })
      .expect(200);
    expect(completed.body.data.status).toBe('completed');
    const backgroundPid = Number(await fs.readFile(marker, 'utf8'));
    expect(Number.isInteger(backgroundPid)).toBe(true);
    expect(() => process.kill(backgroundPid, 0)).toThrow();
  });

  it('fences the CLI tree when durable lease heartbeats stop', async () => {
    const cliFixture = await createCliFixture();
    const marker = path.join(workspaceRoot, 'lease-expired');
    const supervisor = spawn(
      process.execPath,
      [
        path.resolve('server/src/services/local-cli-supervisor.mjs'),
        '0',
        '1000',
        cliFixture,
      ],
      {
        cwd: workspaceRoot,
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
    const stderr: Buffer[] = [];
    supervisor.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    (supervisor.stdio[3] as Writable).write(String(Date.now()));
    (supervisor.stdio[4] as Writable).end(JSON.stringify({
      PATH: process.env.PATH ?? '',
      FIXTURE_ADAPTER: 'codex',
      FIXTURE_MARKER: marker,
      FIXTURE_MODE: 'timeout',
    }));
    supervisor.stdin.end();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fs.access(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('started');

    const startedAt = Date.now();
    const [exitCode] = await Promise.race([
      once(supervisor, 'exit'),
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Supervisor lease watchdog did not exit')),
          3_000,
        );
        timeout.unref();
      }),
    ]);
    expect(exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(Buffer.concat(stderr).toString('utf8')).toContain(
      'lease heartbeat expired',
    );
  });

  it('rejects duplicate runs and terminates the active CLI when cancelled', async () => {
    const cliFixture = await createCliFixture();
    const earlyExitContainment = path.join(
      path.dirname(cliFixture),
      'early-exit-containment',
    );
    await fs.writeFile(
      earlyExitContainment,
      '#!/bin/sh\n"$@" &\nchild=$!\ntrap "exit 0" TERM\nwait "$child"\n',
      { mode: 0o755 },
    );
    vi.stubEnv('EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND', earlyExitContainment);
    const workspace = await createWorkspace('cancellation');
    const fixtureMarker = path.join(workspace, 'fixture-started');
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Cancellable Local Worker',
        role: 'engineer',
        adapterId: 'codex_local',
        adapterConfig: {
          cwd: workspace,
          env: {
            FIXTURE_ADAPTER: 'codex',
            FIXTURE_MARKER: fixtureMarker,
            FIXTURE_MODE: 'timeout',
          },
          timeoutSec: 30,
          graceSec: 1,
        },
      })
      .expect(201);
    authorizeAgent(agent.body.data.id);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: (
          await request(app)
            .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
            .send({})
            .expect(201)
        ).body.data.id,
      })
      .expect(201);

    const activeRun = request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Keep running.' })
      .then((response) => response);

    let observedStatus = '';
    let observedProcessOwnerId = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [session] = await db.drizzle
        .select({
          status: db.schema.agentRuntimeSessions.status,
          resumeState: db.schema.agentRuntimeSessions.resumeState,
        })
        .from(db.schema.agentRuntimeSessions)
        .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));
      observedStatus = session.status;
      if (observedStatus === 'running') {
        observedProcessOwnerId =
          typeof session.resumeState.processOwnerId === 'string'
            ? session.resumeState.processOwnerId
            : '';
        if (observedProcessOwnerId) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observedStatus).toBe('running');
    expect(observedProcessOwnerId).not.toBe('');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fs.access(fixtureMarker);
        break;
      } catch {
        if (attempt === 49) throw new Error('CLI fixture did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/run`)
      .send({ prompt: 'Run twice.' })
      .expect(400);
    expect(duplicate.body.message).toContain('already running');

    const [cancelled, competingCancellation] = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
        .send({ reason: 'operator stop' })
        .expect(200),
      request(app)
        .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
        .send({ reason: 'competing stop' })
        .expect(200),
    ]);
    expect(cancelled.body.data.status).toBe('cancelling');
    expect(competingCancellation.body.data.status).toBe('cancelling');
    expect(['operator stop', 'competing stop']).toContain(
      cancelled.body.data.cancellationReason,
    );
    expect(competingCancellation.body.data.cancellationReason).toBe(
      cancelled.body.data.cancellationReason,
    );
    const repeatedCancellation = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({})
      .expect(200);
    expect(repeatedCancellation.body.data.status).toBe('cancelling');
    expect(repeatedCancellation.body.data.cancellationReason).toBe(
      cancelled.body.data.cancellationReason,
    );
    expect(repeatedCancellation.body.data.updatedAt).toBe(
      cancelled.body.data.updatedAt,
    );
    await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/finalize`)
      .expect(400);

    const stoppedRun = await activeRun;
    expect(stoppedRun.status).toBe(200);
    expect(stoppedRun.body.data.status).toBe('cancelled');
    expect(stoppedRun.body.data.transcript.at(-1).data.aborted).toBe(true);
    const [recordedExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.runtimeSessionId, created.body.data.id));
    expect(recordedExecution.status).toBe('cancelled');
    expect(recordedExecution.error).toBe(
      `Runtime session cancelled: ${cancelled.body.data.cancellationReason}`,
    );
    expect(recordedExecution.lastUsefulAction).toBe('local_cli_cancelled');
    expect(recordedExecution.log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'codex_local diagnostic',
          level: 'error',
        }),
      ]),
    );

    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({
        status: 'running',
        completedAt: null,
        resumeState: {
          ...stoppedRun.body.data.resumeState,
          processOwnerId: observedProcessOwnerId,
        },
        updatedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));
    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({
        status: 'running',
        completedAt: null,
      })
      .where(eq(db.schema.agentExecutions.id, recordedExecution.id));

    const reconciled = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({ reason: 'orphaned persistence owner' })
      .expect(200);
    expect(reconciled.body.data.status).toBe('cancelled');
  });

  it('reconciles an expired foreign process owner only after its kill deadline', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Orphaned Local Worker',
        role: 'engineer',
        adapterId: 'codex_local',
      })
      .expect(201);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({})
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
      })
      .expect(201);
    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({
        status: 'running',
        adapterConfig: { graceSec: -1 },
        resumeState: { processOwnerId: 'previous-server-instance' },
        updatedAt: new Date(Date.now() - 15_000),
      })
      .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));

    const pendingCancellation = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({ reason: 'stale worker lease' })
      .expect(200);
    expect(pendingCancellation.body.data.status).toBe('cancelling');

    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({ updatedAt: new Date(Date.now() - 41_000) })
      .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));
    const cancelled = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({})
      .expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    const [cancelledExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    expect(cancelledExecution.status).toBe('cancelled');
    expect(cancelledExecution.error).toBe(
      'Runtime session cancelled: stale worker lease',
    );
    await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/finalize`)
      .expect(200);
  });

  it('cancels an upgraded ownerless process session immediately', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Legacy Process Worker',
        role: 'engineer',
        adapterId: 'process:local',
      })
      .expect(201);
    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);
    await db.drizzle
      .update(db.schema.agentRuntimeSessions)
      .set({
        status: 'running',
        resumeState: {},
      })
      .where(eq(db.schema.agentRuntimeSessions.id, created.body.data.id));

    const cancelled = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({ reason: 'upgrade reconciliation' })
      .expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.completedAt).not.toBeNull();
  });

  it('stores adapter, skill, routine, and session policy on agents', async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Local Jarvis',
        role: 'engineer',
        provider: 'ollama',
        model: 'gemma4',
        adapterId: 'openjarvis:local',
        adapterConfig: { preset: 'code-assistant' },
        skillsEnabled: ['code-explainer'],
        routinePolicy: { allowContinuous: true },
        sessionPolicy: { resume: true },
      })
      .expect(201);

    expect(created.body.data.provider).toBe('local');
    expect(created.body.data.adapterId).toBe('openjarvis:local');
    expect(created.body.data.adapterConfig).toEqual({ preset: 'code-assistant' });
    expect(created.body.data.skillsEnabled).toEqual(['code-explainer']);
    expect(created.body.data.routinePolicy).toEqual({ allowContinuous: true });
    expect(created.body.data.sessionPolicy).toEqual({ resume: true });
  });

  it('keeps agent wake scoped to the route company', async () => {
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Corp', budgetMonthlyCents: 100000 })
      .expect(201);

    const otherAgent = await request(app)
      .post(`/api/companies/${otherCompany.body.data.id}/agents`)
      .send({ name: 'Other Worker', role: 'engineer' })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/agents/${otherAgent.body.data.id}/wake`)
      .expect(404);
  });

  it('rejects runtime sessions with unrelated task or execution ids', async () => {
    const agentA = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Agent A', role: 'engineer' })
      .expect(201);
    const agentB = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Agent B', role: 'engineer' })
      .expect(201);

    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentB.body.data.id}/executions`)
      .send({})
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agentA.body.data.id,
        executionId: execution.body.data.id,
      })
      .expect(400);

    const otherCompanyId = randomUUID();
    const otherTaskId = randomUUID();
    await db.drizzle.insert(db.schema.companies).values({
      id: otherCompanyId,
      name: 'Task Owner Corp',
      budgetMonthlyCents: 100000,
    });
    await db.drizzle.insert(db.schema.tasks).values({
      id: otherTaskId,
      companyId: otherCompanyId,
      title: 'Other company task',
    });

    await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agentA.body.data.id,
        taskId: otherTaskId,
      })
      .expect(400);
  });

  it('maps pre-migration local agents to the Ollama runtime adapter', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Legacy Local', role: 'engineer', provider: 'ollama', model: 'gemma4' })
      .expect(201);

    await db.drizzle
      .update(db.schema.agents)
      .set({ adapterId: null })
      .where(eq(db.schema.agents.id, agent.body.data.id));

    const session = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);

    expect(session.body.data.adapterId).toBe('provider:ollama');
  });

  it('inherits agent adapter config and preserves an execution workspace when omitted', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Configured Runtime',
        role: 'engineer',
        adapterId: 'openjarvis:local',
        adapterConfig: { preset: 'desktop-assistant' },
      })
      .expect(201);
    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Existing Workspace', workspacePath: 'existing-workspace' })
      .expect(201);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({})
      .expect(201);
    const previousLeaseAt = new Date(Date.now() - 60_000);

    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ environmentId: environment.body.data.id })
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    await db.drizzle
      .update(db.schema.executionEnvironments)
      .set({
        status: 'leased',
        leaseOwnerAgentId: agent.body.data.id,
        leaseOwnerExecutionId: execution.body.data.id,
        leasedAt: previousLeaseAt,
      })
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));

    const session = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
      })
      .expect(201);

    expect(session.body.data.adapterConfig).toEqual({ preset: 'desktop-assistant' });
    expect(session.body.data.environmentId).toBe(environment.body.data.id);

    const nullEnvironmentSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
        environmentId: null,
      })
      .expect(201);
    expect(nullEnvironmentSession.body.data.environmentId).toBe(environment.body.data.id);

    await request(app)
      .post(`/api/companies/${companyId}/sessions/${session.body.data.id}/finalize`)
      .expect(200);

    const [updatedExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    expect(updatedExecution.environmentId).toBe(environment.body.data.id);

    const [stillLeased] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(stillLeased.status).toBe('leased');
    expect(stillLeased.leaseOwnerExecutionId).toBe(execution.body.data.id);
  });

  it('creates, cancels, and finalizes durable runtime sessions with workspace leases', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Worker', role: 'engineer', provider: 'ollama', model: 'gemma4' })
      .expect(201);

    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Local Worktree', workspacePath: 'runtime-foundation' })
      .expect(201);

    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        environmentId: environment.body.data.id,
        adapterId: 'process:local',
        adapterConfig: { command: 'echo' },
        resumeState: { turn: 1 },
      })
      .expect(201);

    expect(created.body.data.status).toBe('queued');
    expect(created.body.data.runId).toBeDefined();
    expect(created.body.data.environmentId).toBe(environment.body.data.id);

    const [leased] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(leased.status).toBe('leased');

    const cancelled = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({ reason: 'operator stop' })
      .expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.cancellationReason).toBe('operator stop');

    const finalized = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/finalize`)
      .expect(200);
    expect(finalized.body.data.status).toBe('finalized');
    const terminalCancellation = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({ reason: 'too late' })
      .expect(200);
    expect(terminalCancellation.body.data.status).toBe('finalized');

    const [released] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(released.status).toBe('available');

    const secondSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        environmentId: environment.body.data.id,
        adapterId: 'process:local',
      })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/finalize`)
      .expect(200);

    const [stillLeased] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(secondSession.body.data.status).toBe('queued');
    expect(stillLeased.status).toBe('leased');
    expect(stillLeased.leaseOwnerAgentId).toBe(agent.body.data.id);
  });

  it('preserves runtime session not-found codes across lifecycle routes', async () => {
    const missingId = randomUUID();
    const runResponse = await request(app)
      .post(`/api/companies/${companyId}/sessions/${missingId}/run`)
      .send({ prompt: 'Do not run.' })
      .expect(404);
    const cancelResponse = await request(app)
      .post(`/api/companies/${companyId}/sessions/${missingId}/cancel`)
      .send({})
      .expect(404);
    const finalizeResponse = await request(app)
      .post(`/api/companies/${companyId}/sessions/${missingId}/finalize`)
      .expect(404);

    expect(runResponse.body.code).toBe('RUNTIME_SESSION_NOT_FOUND');
    expect(cancelResponse.body.code).toBe('RUNTIME_SESSION_NOT_FOUND');
    expect(finalizeResponse.body.code).toBe('RUNTIME_SESSION_NOT_FOUND');
  });

  it('reports runtime cancellation update contention as a conflict', async () => {
    const sessionId = randomUUID();
    const cancelSpy = vi
      .spyOn(RuntimeSessionService.prototype, 'cancelSession')
      .mockRejectedValueOnce(new Error(`Session ${sessionId} is already being updated`));
    try {
      const response = await request(app)
        .post(`/api/companies/${companyId}/sessions/${sessionId}/cancel`)
        .send({})
        .expect(409);

      expect(response.body.code).toBe('RUNTIME_SESSION_CONFLICT');
    } finally {
      cancelSpy.mockRestore();
    }
  });

  it('installs company skills and assigns them to agents', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Researcher', role: 'engineer' })
      .expect(201);

    const installed = await request(app)
      .post(`/api/companies/${companyId}/skills/install`)
      .send({
        name: 'code-explainer',
        version: '1.0.0',
        source: 'github:example/skills',
        provenance: 'github',
        trustLevel: 'markdown_only',
        content: '# Code Explainer\nExplain code with citations.',
        agentIds: [agent.body.data.id],
      })
      .expect(201);

    expect(installed.body.data.skill.name).toBe('code-explainer');
    expect(installed.body.data.assignments).toHaveLength(1);

    const refreshedAgent = await request(app)
      .get(`/api/companies/${companyId}/agents/${agent.body.data.id}`)
      .expect(200);
    expect(refreshedAgent.body.data.skillsEnabled).toContain('code-explainer');
  });

  it('audits, exports, and resets company skill sync state', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Skill Operator', role: 'engineer' })
      .expect(201);

    const installed = await request(app)
      .post(`/api/companies/${companyId}/skills/install`)
      .send({
        name: 'daily-briefing',
        version: '1.0.0',
        source: 'agentskills.io/manual',
        provenance: 'manual',
        trustLevel: 'markdown_only',
        entrypoint: '../escape.md',
        content: '# Daily Briefing\nSummarize open tasks and approvals.',
        tags: ['jarvis', 'briefing'],
        agentIds: [agent.body.data.id],
      })
      .expect(201);

    await db.drizzle
      .update(db.schema.agentSkills)
      .set({
        syncStatus: 'synced',
        materializedPath: '/tmp/eidolon/skills/daily-briefing',
        lastSyncedAt: new Date(),
      })
      .where(eq(db.schema.agentSkills.id, installed.body.data.assignments[0].id));

    const audit = await request(app)
      .get(`/api/companies/${companyId}/skills/audit`)
      .expect(200);
    expect(audit.body.data.totals.skills).toBe(1);
    expect(audit.body.data.totals.assignments).toBe(1);
    expect(audit.body.data.totals.syncedAssignments).toBe(1);
    expect(audit.body.data.skills[0]).toMatchObject({
      name: 'daily-briefing',
      assignmentCount: 1,
      issues: [],
    });

    const exported = await request(app)
      .get(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/export`)
      .expect(200);
    expect(exported.body.data.schema).toBe('agentskills.io/v1');
    expect(exported.body.data.skill.name).toBe('daily-briefing');
    expect(exported.body.data.skill.entrypoint).toBe('SKILL.md');
    expect(exported.body.data.files).toEqual([
      {
        path: 'SKILL.md',
        content: '# Daily Briefing\nSummarize open tasks and approvals.',
      },
    ]);
    expect(exported.body.data.assignments[0]).toMatchObject({
      agentId: agent.body.data.id,
      syncStatus: 'synced',
      materializedPath: '/tmp/eidolon/skills/daily-briefing',
    });

    const reset = await request(app)
      .post(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/reset`)
      .send({ reason: 'resync local adapter home' })
      .expect(200);
    expect(reset.body.data.assignments[0]).toMatchObject({
      agentId: agent.body.data.id,
      syncStatus: 'pending',
      materializedPath: null,
      lastSyncedAt: null,
    });

    await request(app)
      .post(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/reset`)
      .send({ agentIds: [] })
      .expect(400);

    const unassignedAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Unassigned Skill Agent', role: 'support' })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/reset`)
      .send({ agentIds: [unassignedAgent.body.data.id] })
      .expect(404);

    const [assignment] = await db.drizzle
      .select()
      .from(db.schema.agentSkills)
      .where(
        and(
          eq(db.schema.agentSkills.companyId, companyId),
          eq(db.schema.agentSkills.skillId, installed.body.data.skill.id),
        ),
      );
    expect(assignment.syncStatus).toBe('pending');
    expect(assignment.materializedPath).toBeNull();
    expect(assignment.lastSyncedAt).toBeNull();
  });

  it('creates and triggers Jarvis routines', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Briefing Agent', role: 'support' })
      .expect(201);

    const routine = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        name: 'Morning briefing',
        agentId: agent.body.data.id,
        jarvisMode: 'daily_briefing',
        schedule: '0 8 * * *',
        prompt: 'Summarize the day.',
      })
      .expect(201);

    expect(routine.body.data.jarvisMode).toBe('daily_briefing');
    expect(routine.body.data.enabled).toBe(true);

    const triggered = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.body.data.id}/trigger`)
      .expect(200);
    expect(triggered.body.data.routine.lastTriggeredAt).toBeTruthy();
    expect(triggered.body.data.status).toBe('session_started');
    expect(triggered.body.data.task.title).toBe('Run routine: Morning briefing');
    expect(triggered.body.data.task.assigneeAgentId).toBe(agent.body.data.id);
    expect(triggered.body.data.task.status).toBe('in_progress');
    expect(triggered.body.data.task.startedAt).toBeTruthy();
    expect(triggered.body.data.execution.agentId).toBe(agent.body.data.id);
    expect(triggered.body.data.execution.taskId).toBe(triggered.body.data.task.id);
    expect(triggered.body.data.execution.runtimeSessionId).toBe(triggered.body.data.session.id);
    expect(triggered.body.data.session.agentId).toBe(agent.body.data.id);
    expect(triggered.body.data.session.taskId).toBe(triggered.body.data.task.id);
    expect(triggered.body.data.session.executionId).toBe(triggered.body.data.execution.id);
    expect(triggered.body.data.threadItem.relatedExecutionId).toBe(triggered.body.data.execution.id);

    const [execution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, triggered.body.data.execution.id));
    expect(execution).toBeDefined();
    expect(execution!.runtimeSessionId).toBe(triggered.body.data.session.id);

    const [threadItem] = await db.drizzle
      .select()
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.id, triggered.body.data.threadItem.id));
    expect(threadItem).toBeDefined();
    expect(threadItem!.payload).toMatchObject({
      routineId: routine.body.data.id,
      executionId: triggered.body.data.execution.id,
    });
  });

  it('creates task-only work when triggering a company-level routine', async () => {
    const routine = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        name: 'Company monitor',
        jarvisMode: 'monitoring',
        mode: 'on_demand',
        prompt: 'Check open operational risks.',
      })
      .expect(201);

    const triggered = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.body.data.id}/trigger`)
      .expect(200);

    expect(triggered.body.data.status).toBe('task_created_without_agent');
    expect(triggered.body.data.task.title).toBe('Run routine: Company monitor');
    expect(triggered.body.data.task.status).toBe('backlog');
    expect(triggered.body.data.task.assigneeAgentId).toBeNull();
    expect(triggered.body.data.execution).toBeNull();
    expect(triggered.body.data.session).toBeNull();
    expect(triggered.body.data.threadItem.content).toContain('no assigned agent');

    const persistedExecutions = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.taskId, triggered.body.data.task.id));
    expect(persistedExecutions).toHaveLength(0);
  });

  it('creates distinct work for repeated manual routine triggers', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Follow-up Agent', role: 'support' })
      .expect(201);

    const routine = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        name: 'Follow-up sweep',
        agentId: agent.body.data.id,
        jarvisMode: 'follow_up',
        mode: 'on_demand',
        prompt: 'Find stale follow-ups.',
      })
      .expect(201);

    const first = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.body.data.id}/trigger`)
      .expect(200);
    const second = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.body.data.id}/trigger`)
      .expect(200);

    expect(first.body.data.task.id).not.toBe(second.body.data.task.id);
    expect(first.body.data.execution.id).not.toBe(second.body.data.execution.id);
    expect(first.body.data.session.id).not.toBe(second.body.data.session.id);
  });
});
