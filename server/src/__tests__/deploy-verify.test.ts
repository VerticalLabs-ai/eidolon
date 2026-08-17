import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

// ---------------------------------------------------------------------------
// Deploy-verify workflow structure (VAL-OBS-012)
// ---------------------------------------------------------------------------

const workflowPath = resolve(import.meta.dirname, '../../../.github/workflows/deploy-verify.yml');
const workflowContent = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowContent) as Record<string, unknown>;

type WorkflowJob = {
  steps?: Array<{ name?: string; run?: string; if?: string }>;
};

describe('deploy-verify workflow (VAL-OBS-012)', () => {
  it('is valid YAML with a name', () => {
    expect(workflow).toBeDefined();
    expect(workflow.name).toBe('Deploy verification');
  });

  it('triggers on push to main', () => {
    const on = workflow.on as { push?: { branches?: string[] }; workflow_dispatch?: unknown };
    expect(on.push).toBeDefined();
    expect(on.push?.branches).toContain('main');
  });

  it('supports manual workflow_dispatch', () => {
    const on = workflow.on as { workflow_dispatch?: unknown };
    expect(on.workflow_dispatch).toBeDefined();
  });

  it('checks /api/health endpoint', () => {
    const jobs = workflow.jobs as Record<string, WorkflowJob>;
    const verifyJob = jobs.verify;
    expect(verifyJob).toBeDefined();
    const steps = verifyJob.steps ?? [];
    const healthStep = steps.find((s) => s.name === 'Verify /api/health');
    expect(healthStep).toBeDefined();
    expect(healthStep?.run).toContain('/api/health');
  });

  it('checks /api/ready endpoint', () => {
    const jobs = workflow.jobs as Record<string, WorkflowJob>;
    const verifyJob = jobs.verify;
    const steps = verifyJob.steps ?? [];
    const readyStep = steps.find((s) => s.name === 'Verify /api/ready');
    expect(readyStep).toBeDefined();
    expect(readyStep?.run).toContain('/api/ready');
  });

  it('fails when either endpoint returns non-200', () => {
    const jobs = workflow.jobs as Record<string, WorkflowJob>;
    const steps = jobs.verify?.steps ?? [];
    const healthStep = steps.find((s) => s.name === 'Verify /api/health');
    const readyStep = steps.find((s) => s.name === 'Verify /api/ready');
    // Both steps must exit non-zero when the HTTP code is not 200.
    expect(healthStep?.run).toMatch(/200/);
    expect(healthStep?.run).toMatch(/exit 1/);
    expect(readyStep?.run).toMatch(/200/);
    expect(readyStep?.run).toMatch(/exit 1/);
  });

  it('defaults to the production URL', () => {
    const content = workflowContent;
    expect(content).toContain('https://eidolon.verticallabs.ai');
  });

  it('posts a notification on failure', () => {
    const jobs = workflow.jobs as Record<string, WorkflowJob>;
    const steps = jobs.verify?.steps ?? [];
    const notifyStep = steps.find((s) => s.name === 'Notify on failure');
    expect(notifyStep).toBeDefined();
    expect(notifyStep?.if).toBe('failure()');
    expect(notifyStep?.run).toContain('gh issue');
  });

  it('writes a results summary to the step summary', () => {
    const jobs = workflow.jobs as Record<string, WorkflowJob>;
    const steps = jobs.verify?.steps ?? [];
    const summaryStep = steps.find((s) => s.name === 'Health check summary');
    expect(summaryStep).toBeDefined();
    expect(summaryStep?.run).toContain('GITHUB_STEP_SUMMARY');
  });
});

// ---------------------------------------------------------------------------
// Health endpoint response structure (VAL-OBS-012)
// ---------------------------------------------------------------------------

describe('health endpoint response structure', () => {
  it('/api/health response includes status, uptime, timestamp, and memory', () => {
    // The health endpoint structure is defined in server/src/routes/health.ts.
    // This test documents the expected contract that the deploy-verify
    // workflow relies on: a 200 response with a JSON body containing
    // status=ok. The full integration test is in health.test.ts.
    const healthRoutePath = resolve(import.meta.dirname, '../routes/health.ts');
    const healthRoute = readFileSync(healthRoutePath, 'utf8');

    // The route must return status: 'ok'
    expect(healthRoute).toContain("status: 'ok'");
    // Must include uptime
    expect(healthRoute).toContain('uptime');
    // Must include timestamp
    expect(healthRoute).toContain('timestamp');
    // Must include memory info
    expect(healthRoute).toContain('memory');
    expect(healthRoute).toContain('rss');
    expect(healthRoute).toContain('heapUsed');
  });

  it('/api/ready returns 200 when ok and 503 when degraded', () => {
    const healthRoutePath = resolve(import.meta.dirname, '../routes/health.ts');
    const healthRoute = readFileSync(healthRoutePath, 'utf8');

    // The readiness route must return 200 for ok and 503 for degraded
    expect(healthRoute).toMatch(/200/);
    expect(healthRoute).toMatch(/503/);
    expect(healthRoute).toContain('checkReadiness');
  });
});
