import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseTestCounts, parseDuplication } from '../../../scripts/quality-metrics-summary.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const workflowPath = resolve(repoRoot, '.github/workflows/quality-gate.yml');
const vitestConfigPath = resolve(repoRoot, 'vitest.config.ts');
const summaryScriptPath = resolve(repoRoot, 'scripts/quality-metrics-summary.mjs');

describe('quality-gate workflow (VAL-OBS-010, VAL-OBS-011)', () => {
  it('.github/workflows/quality-gate.yml exists', () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  const content = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';

  it('triggers on pull requests', () => {
    expect(content).toMatch(/pull_request:/);
  });

  it('triggers on pushes to main and staging', () => {
    expect(content).toMatch(/push:/);
    expect(content).toContain('main');
    expect(content).toContain('staging');
  });

  it('runs pnpm test:coverage', () => {
    expect(content).toContain('test:coverage');
  });

  it('runs pnpm duplication', () => {
    expect(content).toContain('duplication');
  });

  it('runs pnpm dead-code', () => {
    expect(content).toContain('dead-code');
  });

  it('uses GITHUB_STEP_SUMMARY for metrics reporting', () => {
    expect(content).toContain('GITHUB_STEP_SUMMARY');
  });

  it('uses the quality-metrics-summary script', () => {
    expect(content).toContain('quality-metrics-summary');
  });

  it('enforces coverage thresholds via test:coverage exit code', () => {
    // The workflow runs `pnpm test:coverage` as a gating step (not
    // `continue-on-error: true`), so vitest threshold violations cause
    // the step to fail and the workflow to exit non-zero.
    expect(content).toContain('test:coverage');
    // Ensure the coverage step is not wrapped in continue-on-error
    const coverageStepMatch = content.match(
      /- name:.*coverage[\s\S]*?(?=\n- name:|\njobs:|\n\s{4}- name:|$)/i,
    );
    if (coverageStepMatch) {
      expect(coverageStepMatch[0]).not.toContain('continue-on-error: true');
    }
  });
});

describe('root vitest coverage configuration (VAL-OBS-010)', () => {
  const configContent = readFileSync(vitestConfigPath, 'utf8');

  it('vitest.config.ts has coverage thresholds', () => {
    expect(configContent).toContain('coverage');
    expect(configContent).toContain('thresholds');
  });

  it('coverage thresholds include lines, statements, functions, and branches', () => {
    expect(configContent).toContain('lines:');
    expect(configContent).toContain('statements:');
    expect(configContent).toContain('functions:');
    expect(configContent).toContain('branches:');
  });

  it('coverage uses v8 provider', () => {
    expect(configContent).toContain('v8');
  });

  it('coverage reporters include json-summary', () => {
    expect(configContent).toContain('json-summary');
  });
});

describe('quality-metrics-summary script (VAL-OBS-011)', () => {
  it('scripts/quality-metrics-summary.mjs exists', () => {
    expect(existsSync(summaryScriptPath)).toBe(true);
  });

  it('parseTestCounts extracts passed/failed/skipped from vitest output', () => {
    const output = `
 ✓ server/src/__tests__/example.test.ts (2 tests) 45ms

 Test Files  1 passed (1)
      Tests  2541 passed (2542)
   Start at  09:30:00
`;
    const counts = parseTestCounts(output);
    expect(counts).not.toBeNull();
    expect(counts!.passed).toBe(2541);
    expect(counts!.testFiles).toBe(1);
  });

  it('parseTestCounts handles failed and skipped counts', () => {
    const output = `
 Test Files  10 passed | 2 failed (12)
      Tests  2540 passed | 2 failed (2542)
`;
    const counts = parseTestCounts(output);
    expect(counts).not.toBeNull();
    expect(counts!.passed).toBe(2540);
    expect(counts!.failed).toBe(2);
    expect(counts!.tests).toBe(2542);
  });

  it('parseTestCounts returns null for empty input', () => {
    expect(parseTestCounts('')).toBeNull();
    expect(parseTestCounts('no test output here')).toBeNull();
  });

  it('parseDuplication extracts percentage from jscpd output', () => {
    const output = `
Duplicated lines found:
  - file1.ts (10 lines)
Total: 2.34% (45 duplicated lines)
`;
    const dup = parseDuplication(output);
    expect(dup).not.toBeNull();
    expect(dup!.percentage).toBe(2.34);
    expect(dup!.duplicatedLines).toBe(45);
  });

  it('parseDuplication returns null for empty input', () => {
    expect(parseDuplication('')).toBeNull();
    expect(parseDuplication('no duplication info')).toBeNull();
  });
});
