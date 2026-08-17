import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const scriptPath = resolve(root, 'scripts/verify-branch-protection.mjs');
const docsPath = resolve(root, 'docs/delivery/branch-protection.md');

describe('branch protection verification script', () => {
  it('exists at scripts/verify-branch-protection.mjs', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('checks both main and staging branches', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain("'main'");
    expect(content).toContain("'staging'");
  });

  it('requires at least 1 approving review', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('required_approving_review_count');
    expect(content).toMatch(/REQUIRED_REVIEW_COUNT\s*=\s*1/);
  });

  it('does not require unavailable status checks', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('required_status_checks must be omitted');
    expect(content).not.toContain('REQUIRED_STATUS_CHECKS');
  });

  it('blocks force-push via non_fast_forward rule', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('non_fast_forward');
  });

  it('allows only GitHub Actions to bypass main', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('bypass_actors');
    expect(content).toContain('GITHUB_ACTIONS_APP_ID = 41898282');
    expect(content).toContain("actor_type === 'User'");
  });

  it('checks enforcement is active', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain("'active'");
    expect(content).toMatch(/enforcement.*active/);
  });

  it('exits with code 1 on failure', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('process.exit(1)');
  });
});

describe('branch protection documentation', () => {
  it('exists at docs/delivery/branch-protection.md', () => {
    expect(existsSync(docsPath)).toBe(true);
  });

  it('documents required pull request reviews', () => {
    const content = readFileSync(docsPath, 'utf8');
    expect(content).toMatch(/approving review/i);
    expect(content).toMatch(/1.*approving/i);
  });

  it('documents why status checks are temporarily disabled', () => {
    const content = readFileSync(docsPath, 'utf8');
    expect(content).toMatch(/status checks are intentionally.*not required/i);
    expect(content).toMatch(/billing lock/i);
  });

  it('documents force-push blocking', () => {
    const content = readFileSync(docsPath, 'utf8');
    expect(content).toMatch(/force.?push/i);
  });

  it('documents enforcement for administrators', () => {
    const content = readFileSync(docsPath, 'utf8');
    expect(content).toMatch(/administrator/i);
    expect(content).toMatch(/bypass.*actor/i);
  });

  it('references the verification script', () => {
    const content = readFileSync(docsPath, 'utf8');
    expect(content).toContain('verify-branch-protection.mjs');
  });
});
