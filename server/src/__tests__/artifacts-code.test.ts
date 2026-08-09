import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from '../services/artifact-tools.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Code artifact payloads
// ---------------------------------------------------------------------------

const JS_HELLO = {
  language: 'javascript',
  files: [{ path: 'main.js', content: "console.log('hello');\n" }],
};

const JS_STDERR = {
  language: 'javascript',
  files: [{ path: 'main.js', content: "console.error('boom');\nprocess.exit(2);\n" }],
};

const JS_LOOP = {
  language: 'javascript',
  files: [{ path: 'main.js', content: 'while (true) {}\n' }],
};

const JS_READ_HOST = {
  language: 'javascript',
  files: [
    {
      path: 'main.js',
      content:
        "const fs = require('fs');\n" +
        "try { const p = fs.readFileSync('/etc/passwd', 'utf8'); console.log('LEAK:' + p.slice(0, 20)); } catch (e) { console.log('BLOCKED_FS:' + e.message); }\n" +
        "console.log('ENV_KEY:' + (process.env.OPENAI_API_KEY ?? 'undefined'));\n" +
        "console.log('ENV_ANTHROPIC:' + (process.env.ANTHROPIC_API_KEY ?? 'undefined'));\n",
    },
  ],
};

const PY_HELLO = {
  language: 'python',
  files: [{ path: 'main.py', content: "print('hello from python')\n" }],
};

// Python: attempt to read a host file, spawn a subprocess, and open a
// non-loopback network connection. The sandbox must block all three while
// still allowing stdout and sandbox-local file reads.
const PY_READ_HOST = {
  language: 'python',
  files: [
    {
      path: 'main.py',
      content:
        "try:\n" +
        "    print('PY_LEAK:' + open('/etc/passwd').read()[:20])\n" +
        "except Exception as e:\n" +
        "    print('PY_BLOCKED_OPEN:' + str(e).split(':')[0])\n" +
        "try:\n" +
        "    import subprocess\n" +
        "    print('PY_SUBPROCESS_LEAK')\n" +
        "except ImportError as e:\n" +
        "    print('PY_BLOCKED_SUBPROCESS:' + str(e))\n" +
        "import os\n" +
        "try:\n" +
        "    os.system('echo leaked')\n" +
        "    print('PY_OS_SYSTEM_LEAK')\n" +
        "except Exception as e:\n" +
        "    print('PY_BLOCKED_OS_SYSTEM:' + str(e).split(':')[0])\n" +
        "import socket\n" +
        "try:\n" +
        "    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n" +
        "    s.settimeout(2)\n" +
        "    s.connect(('1.1.1.1', 80))\n" +
        "    print('PY_NET_LEAK')\n" +
        "except Exception as e:\n" +
        "    print('PY_BLOCKED_NET:' + str(e).split(':')[0])\n" +
        "print('PY_STDOUT_OK:hello')\n" +
        "with open('main.py') as f:\n" +
        "    print('PY_SANDBOX_READ_OK:' + str(len(f.read()) > 0))\n",
    },
  ],
};

// JavaScript: exercise the newly-blocked fs methods (cpSync, createWriteStream,
// rmSync, opendir) and worker_threads to confirm the shim blocklists cover
// them. Each prints a BLOCKED/LEAK marker the test asserts on.
const JS_CPSYNC_LEAK = {
  language: 'javascript',
  files: [
    {
      path: 'main.js',
      content:
        "const fs = require('fs');\n" +
        "try { fs.cpSync('/etc', '/tmp/x-cp'); console.log('CPSYNC_LEAK'); } catch (e) { console.log('CPSYNC_BLOCKED:' + (e.message.includes('Sandbox') ? 'yes' : 'no')); }\n" +
        "try { fs.rmSync('/tmp/doesnotexist-cp'); console.log('RMSYNC_LEAK'); } catch (e) { console.log('RMSYNC_BLOCKED:' + (e.message.includes('Sandbox') ? 'yes' : 'no')); }\n" +
        "try { const s = fs.createWriteStream('/etc/passwd'); console.log('CREATEWRITESTREAM_LEAK'); s.destroy(); } catch (e) { console.log('CREATEWRITESTREAM_BLOCKED:' + (e.message.includes('Sandbox') ? 'yes' : 'no')); }\n" +
        "try { fs.opendirSync('/etc'); console.log('OPENDIR_LEAK'); } catch (e) { console.log('OPENDIR_BLOCKED:' + (e.message.includes('Sandbox') ? 'yes' : 'no')); }\n" +
        "try { const p = fs.promises.cp('/etc', '/tmp/x-pcp'); p.then(() => console.log('PROMISE_CP_LEAK')).catch(() => console.log('PROMISE_CP_BLOCKED')); } catch (e) { console.log('PROMISE_CP_BLOCKED:' + (e.message.includes('Sandbox') ? 'yes' : 'no')); }\n",
    },
  ],
};

// JavaScript: attempt to spawn a worker_thread. The shim must block it.
const JS_WORKER_THREADS = {
  language: 'javascript',
  files: [
    {
      path: 'main.js',
      content:
        "try {\n" +
        "  const wt = require('worker_threads');\n" +
        "  new wt.Worker(__filename);\n" +
        "  console.log('WORKER_LEAK');\n" +
        "} catch (e) {\n" +
        "  console.log('WORKER_BLOCKED:' + String(e.message).slice(0, 60));\n" +
        "}\n",
    },
  ],
};

// JavaScript: produce more than 1 MB of stdout so the runner reports
// truncated=true.
const JS_BIG_OUTPUT = {
  language: 'javascript',
  files: [
    {
      path: 'main.js',
      content: "process.stdout.write('x'.repeat(2 * 1024 * 1024));\n",
    },
  ],
};

// TypeScript: a minimal valid entrypoint used for the tsx-absent 422 test.
const TS_HELLO = {
  language: 'typescript',
  files: [{ path: 'main.ts', content: "const v: string = 'hi'; console.log(v);\n" }],
};

const CODE_NO_LANGUAGE = { files: [{ path: 'main.js', content: 'console.log(1)' }] };
const CODE_EMPTY_FILES = { language: 'javascript', files: [] };
const CODE_FILE_NO_PATH = { language: 'javascript', files: [{ content: 'x' }] };
const CODE_DUP_PATHS = {
  language: 'javascript',
  files: [
    { path: 'main.js', content: 'a' },
    { path: 'main.js', content: 'b' },
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

describe('Code artifact API — real-Postgres integration', () => {
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
      .send({ name: '__mtest__ Code Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Code Other Corp', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Code Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Code Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Code Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Code Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  function createCode(
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
        type: 'code',
        title: overrides.title ?? '__mtest__ M6 code',
        content: overrides.content ?? JS_HELLO,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-CODE-001: create a code artifact with a language and files
  // =========================================================================
  describe('VAL-CODE-001: create a code artifact', () => {
    it('creates a code artifact at version 1 with content echoed', async () => {
      const res = await createCode({ title: '__mtest__ M6 code' }).expect(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.type).toBe('code');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.projectId).toBe(projectId);
      expect(res.body.data.content.language).toBe('javascript');
      expect(res.body.data.content.files).toEqual(JS_HELLO.files);

      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}`)
        .expect(200);
      expect(got.body.data.content).toEqual(res.body.data.content);
    });

    it('lists the code artifact under type=code', async () => {
      const created = await createCode().expect(201);
      const listed = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=code`)
        .expect(200);
      expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);
    });
  });

  // =========================================================================
  // VAL-CODE-002: server rejects code content that violates the schema
  // =========================================================================
  describe('VAL-CODE-002: schema validation', () => {
    it('rejects content missing language with 400', async () => {
      const res = await createCode({ content: CODE_NO_LANGUAGE }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects empty files array with 400', async () => {
      const res = await createCode({ content: CODE_EMPTY_FILES }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a file missing path with 400', async () => {
      const res = await createCode({ content: CODE_FILE_NO_PATH }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects duplicate file paths with 400', async () => {
      const res = await createCode({ content: CODE_DUP_PATHS }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects an entrypoint that does not match a file path with 400', async () => {
      const res = await createCode({
        content: { language: 'javascript', entrypoint: 'nope.js', files: JS_HELLO.files },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });
  });

  // =========================================================================
  // VAL-CODE-004: edit files and persist (version bump + revision)
  // =========================================================================
  describe('VAL-CODE-004: edit files and persist', () => {
    it('PATCH bumps version, writes a revision, and persists new content', async () => {
      const created = await createCode().expect(201);
      const id = created.body.data.id;
      const newContent = {
        language: 'javascript',
        files: [{ path: 'main.js', content: "console.log('updated');\n" }],
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: newContent, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content.files[0].content).toBe("console.log('updated');\n");

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.length).toBe(2);
      expect(revs.body.data[1].version).toBe(2);
      expect(revs.body.data[1].editSource).toBe('user');

      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(got.body.data.version).toBe(2);
      expect(got.body.data.content).toEqual(newContent);
    });
  });

  // =========================================================================
  // VAL-CODE-005/006: run the code and capture stdout/stderr/exit code
  // =========================================================================
  describe('VAL-CODE-005/006: run captures stdout/stderr/exit code', () => {
    it('runs a javascript artifact and captures stdout + exit 0', async () => {
      const created = await createCode({ content: JS_HELLO }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      expect(res.body.data.stdout).toContain('hello');
      expect(res.body.data.exitCode).toBe(0);
      expect(res.body.data.timedOut).toBe(false);
      expect(res.body.data.language).toBe('javascript');
    }, 30_000);

    it('captures stderr and a non-zero exit code without crashing the API', async () => {
      const created = await createCode({ content: JS_STDERR }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      expect(res.body.data.stderr).toContain('boom');
      expect(res.body.data.exitCode).toBe(2);
      // API remains responsive.
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${created.body.data.id}`)
        .expect(200);
    }, 30_000);

    it('runs a python artifact and captures stdout', async () => {
      const created = await createCode({ content: PY_HELLO }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      expect(res.body.data.stdout).toContain('hello from python');
      expect(res.body.data.exitCode).toBe(0);
    }, 30_000);
  });

  // =========================================================================
  // VAL-CODE-007: sandbox blocks host file/secret access
  // =========================================================================
  describe('VAL-CODE-007: sandbox blocks host file/secret access', () => {
    it('does not leak /etc/passwd or process.env secrets', async () => {
      const created = await createCode({ content: JS_READ_HOST }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      const out = res.body.data.stdout + res.body.data.stderr;
      // No host file contents leaked.
      expect(out).not.toContain('LEAK:');
      // No secret values leaked — env keys are undefined in the sandbox.
      expect(out).toContain('ENV_KEY:undefined');
      expect(out).toContain('ENV_ANTHROPIC:undefined');
      // The fs read was blocked (threw or sanitized).
      expect(out).toContain('BLOCKED_FS:');
    }, 30_000);
  });

  // =========================================================================
  // VAL-CODE-008: bounded runtime — long-running program is terminated
  // =========================================================================
  describe('VAL-CODE-008: bounded runtime terminates', () => {
    it('terminates a while(true) loop with a timeout status', async () => {
      const created = await createCode({ content: JS_LOOP }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      expect(res.body.data.timedOut).toBe(true);
      expect(res.body.data.exitCode).toBe(124);
      // API remains responsive afterward.
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${created.body.data.id}`)
        .expect(200);
    }, 60_000);
  });

  // =========================================================================
  // VAL-CODE-015: unsupported language is rejected gracefully (no 500)
  // =========================================================================
  describe('VAL-CODE-015: unsupported language rejected gracefully', () => {
    it('returns 422 (not 500) for an unsupported language', async () => {
      const created = await createCode({
        content: { language: 'cobol', files: [{ path: 'main.cbl', content: 'DISPLAY "x".\n' }] },
      }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(422);
      expect(res.body.code).toBe('UNSUPPORTED_LANGUAGE');
    }, 30_000);
  });

  // =========================================================================
  // VAL-CODE-010: code artifact is versioned like other artifacts
  // =========================================================================
  describe('VAL-CODE-010: versioning + restore', () => {
    it('restore creates a new version with append-only history', async () => {
      const created = await createCode().expect(201);
      const id = created.body.data.id;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { language: 'javascript', files: [{ path: 'main.js', content: 'v2\n' }] }, version: 1 })
        .expect(200);

      const restored = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restored.body.data.version).toBe(3);
      expect(restored.body.data.content).toEqual(created.body.data.content);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3]);
    });
  });

  // =========================================================================
  // VAL-CODE-011: code artifact participates in project scoping
  // =========================================================================
  describe('VAL-CODE-011: project scoping', () => {
    it('appears in the project-scoped list and not in another project', async () => {
      const created = await createCode({ projectId }).expect(201);
      const inProject = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);
      expect(inProject.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);

      const inOther = await request(app)
        .get(`/api/companies/${companyId}/projects/${secondProjectId}/artifacts`)
        .expect(200);
      expect(inOther.body.data.map((a: { id: string }) => a.id)).not.toContain(created.body.data.id);
    });
  });

  // =========================================================================
  // VAL-CODE-012: realtime event on run + save
  // =========================================================================
  describe('VAL-CODE-012: realtime events', () => {
    it('emits artifact.code.ran on run', async () => {
      const created = await createCode({ content: JS_HELLO }).expect(201);
      const events = await captureEvents(async () => {
        await request(app)
          .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
          .expect(200);
      });
      const ran = events.filter((e) => e.type === 'artifact.code.ran');
      expect(ran.length).toBe(1);
      expect(ran[0].payload).toMatchObject({ artifactId: created.body.data.id });
    }, 30_000);

    it('emits artifact.updated + artifact.revision.created on save', async () => {
      const created = await createCode().expect(201);
      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${created.body.data.id}`)
          .send({ content: { language: 'javascript', files: [{ path: 'main.js', content: 'x\n' }] }, version: 1 })
          .expect(200);
      });
      expect(events.some((e) => e.type === 'artifact.updated')).toBe(true);
      expect(events.some((e) => e.type === 'artifact.revision.created')).toBe(true);
    });
  });

  // =========================================================================
  // VAL-CROSS-019: optimistic 409 for code type
  // =========================================================================
  describe('VAL-CROSS-019: optimistic 409 for code', () => {
    it('concurrent PATCH with stale version returns 409 with current state', async () => {
      const created = await createCode().expect(201);
      const id = created.body.data.id;
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { language: 'javascript', files: [{ path: 'main.js', content: 'first\n' }] }, version: 1 })
        .expect(200);
      const stale = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { language: 'javascript', files: [{ path: 'main.js', content: 'second\n' }] }, version: 1 })
        .expect(409);
      expect(stale.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      expect(stale.body.details.current.version).toBe(2);
    });
  });

  // =========================================================================
  // VAL-CODE-009/014: agent authors + runs code (sandboxed identically)
  // =========================================================================
  describe('VAL-CODE-009/014: agent authors + runs code', () => {
    it('agent creates a code artifact via the built-in tool', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'code',
          title: '__mtest__ agent code',
          content: JS_HELLO,
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      const data = result.data as { artifactId: string; type: string };
      expect(data.type).toBe('code');
      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${data.artifactId}`)
        .expect(200);
      expect(got.body.data.createdByAgentId).toBe(agentId);
    });

    it('agent runs code via the code.run tool and is sandboxed identically', async () => {
      const service = new ArtifactToolService(db);
      const create = await service.executeTool(
        'artifact.create',
        { type: 'code', title: '__mtest__ agent run', content: JS_READ_HOST, projectId },
        { companyId, agentId, projectId },
      );
      const artifactId = (create.data as { artifactId: string }).artifactId;
      const run = await service.executeTool('code.run', { artifactId }, { companyId, agentId, projectId });
      expect(run.isError).toBeFalsy();
      const out = JSON.parse(run.content[0].text);
      // Agent-authored run is sandboxed identically — no host/secret leak.
      expect(out.stdout + out.stderr).not.toContain('LEAK:');
      expect(out.stdout).toContain('ENV_KEY:undefined');
    }, 30_000);

    it('agent-authored artifact via X-Eidolon-Agent-Id header records agent source', async () => {
      const res = await createCode({})
        .set('X-Eidolon-Agent-Id', agentId)
        .expect(201);
      expect(res.body.data.createdByAgentId).toBe(agentId);
    });
  });

  // =========================================================================
  // Cross-company scoping for code run
  // =========================================================================
  describe('cross-company scoping', () => {
    it('running an artifact from another company is rejected', async () => {
      const created = await createCode().expect(201);
      await request(app)
        .post(`/api/companies/${otherCompanyId}/artifacts/${created.body.data.id}/run`)
        .expect(404);
    });
  });

  // =========================================================================
  // M6 scrutiny round 1: Python sandbox boundary (VAL-CODE-007 for Python)
  // =========================================================================
  describe('Python sandbox boundary', () => {
    it('blocks host file read, subprocess, non-loopback network; stdout + sandbox read still work', async () => {
      const created = await createCode({ content: PY_READ_HOST }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      const out = res.body.data.stdout + res.body.data.stderr;
      // No host file leak.
      expect(out).not.toContain('PY_LEAK:');
      expect(out).toContain('PY_BLOCKED_OPEN:');
      // No subprocess.
      expect(out).not.toContain('PY_SUBPROCESS_LEAK');
      expect(out).toContain('PY_BLOCKED_SUBPROCESS:');
      // No os.system.
      expect(out).not.toContain('PY_OS_SYSTEM_LEAK');
      expect(out).toContain('PY_BLOCKED_OS_SYSTEM:');
      // No non-loopback network egress.
      expect(out).not.toContain('PY_NET_LEAK');
      expect(out).toContain('PY_BLOCKED_NET:');
      // stdout capture still works.
      expect(out).toContain('PY_STDOUT_OK:hello');
      expect(res.body.data.exitCode).toBe(0);
      // Reading a file inside the sandbox root is allowed.
      expect(out).toContain('PY_SANDBOX_READ_OK:True');
    }, 30_000);

    it('Python stdout/stderr/exit-code capture still works for sandboxed code', async () => {
      const pyStderr = {
        language: 'python',
        files: [{ path: 'main.py', content: "import sys\nprint('out line')\nsys.stderr.write('err line\\n')\nsys.exit(3)\n" }],
      };
      const created = await createCode({ content: pyStderr }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      expect(res.body.data.stdout).toContain('out line');
      expect(res.body.data.stderr).toContain('err line');
      expect(res.body.data.exitCode).toBe(3);
      expect(res.body.data.timedOut).toBe(false);
    }, 30_000);
  });

  // =========================================================================
  // M6 scrutiny round 1: JS shim blocklist coverage (cpSync/createWriteStream/
  // rmSync/opendir + fs.promises.cp) — VAL-CODE-007 hardening
  // =========================================================================
  describe('JS shim blocklist coverage', () => {
    it('blocks cpSync, rmSync, createWriteStream, opendir, and promises.cp', async () => {
      const created = await createCode({ content: JS_CPSYNC_LEAK }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      const out = res.body.data.stdout + res.body.data.stderr;
      expect(out).not.toContain('CPSYNC_LEAK');
      expect(out).toContain('CPSYNC_BLOCKED:yes');
      expect(out).not.toContain('RMSYNC_LEAK');
      expect(out).toContain('RMSYNC_BLOCKED:yes');
      expect(out).not.toContain('CREATEWRITESTREAM_LEAK');
      expect(out).toContain('CREATEWRITESTREAM_BLOCKED:yes');
      expect(out).not.toContain('OPENDIR_LEAK');
      expect(out).toContain('OPENDIR_BLOCKED:yes');
      // fs.promises.cp is wrapped and rejects with a Sandbox error.
      expect(out).not.toContain('PROMISE_CP_LEAK');
      expect(out).toContain('PROMISE_CP_BLOCKED');
    }, 30_000);
  });

  // =========================================================================
  // M6 scrutiny round 1: worker_threads blocked in the Node sandbox
  // =========================================================================
  describe('worker_threads blocked', () => {
    it('blocks spawning a worker_thread', async () => {
      const created = await createCode({ content: JS_WORKER_THREADS }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      const out = res.body.data.stdout + res.body.data.stderr;
      expect(out).not.toContain('WORKER_LEAK');
      expect(out).toContain('WORKER_BLOCKED:');
    }, 30_000);
  });

  // =========================================================================
  // M6 scrutiny round 1: output truncation is reported (truncated=true)
  // =========================================================================
  describe('output truncation', () => {
    it('reports truncated=true when stdout exceeds the byte cap', async () => {
      const created = await createCode({ content: JS_BIG_OUTPUT }).expect(201);
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
        .expect(200);
      expect(res.body.data.truncated).toBe(true);
      // The captured stdout is bounded (<= 1 MB) — not the full 2 MB.
      expect(Buffer.byteLength(res.body.data.stdout, 'utf8')).toBeLessThanOrEqual(
        1024 * 1024,
      );
    }, 30_000);

    it('agent code.run result includes the truncated field', async () => {
      const service = new ArtifactToolService(db);
      const create = await service.executeTool(
        'artifact.create',
        { type: 'code', title: '__mtest__ agent trunc', content: JS_BIG_OUTPUT, projectId },
        { companyId, agentId, projectId },
      );
      const artifactId = (create.data as { artifactId: string }).artifactId;
      const run = await service.executeTool('code.run', { artifactId }, { companyId, agentId, projectId });
      expect(run.isError).toBeFalsy();
      const out = JSON.parse(run.content[0].text);
      expect(out).toHaveProperty('truncated');
      expect(out.truncated).toBe(true);
      expect(run.data).toHaveProperty('truncated');
      expect(run.data?.truncated).toBe(true);
    }, 30_000);
  });

  // =========================================================================
  // M6 scrutiny round 1: TS without tsx returns 422 RUNTIME_UNAVAILABLE
  // (not a corrupting regex fallback)
  // =========================================================================
  describe('TS without tsx returns 422', () => {
    it('returns 422 RUNTIME_UNAVAILABLE when tsx is not installed', async () => {
      const created = await createCode({ content: TS_HELLO }).expect(201);
      // Point the runner at a non-existent tsx binary so the availability
      // check fails without uninstalling the real dependency.
      const prev = process.env.EIDOLON_TSX_BIN_PATH;
      process.env.EIDOLON_TSX_BIN_PATH = '/nonexistent/path/tsx';
      try {
        const res = await request(app)
          .post(`/api/companies/${companyId}/artifacts/${created.body.data.id}/run`)
          .expect(422);
        expect(res.body.code).toBe('RUNTIME_UNAVAILABLE');
        expect(res.body.message).toMatch(/tsx/i);
      } finally {
        if (prev === undefined) delete process.env.EIDOLON_TSX_BIN_PATH;
        else process.env.EIDOLON_TSX_BIN_PATH = prev;
      }
    }, 30_000);
  });
});
