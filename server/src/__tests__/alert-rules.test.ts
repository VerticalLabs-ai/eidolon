import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface RuleGroup {
  name: string;
  interval?: string;
  rules: AlertRule[];
}

interface AlertRulesFile {
  groups: RuleGroup[];
}

const alertRulesPath = resolve(import.meta.dirname, '../../../monitoring/alert-rules.yml');
const alertRulesContent = readFileSync(alertRulesPath, 'utf8');
const parsed = parse(alertRulesContent) as AlertRulesFile;

const rules = parsed.groups.flatMap((group) => group.rules);
const ruleByName = new Map(rules.map((rule) => [rule.alert, rule]));

const expectedRuleNames = [
  'HighErrorRate',
  'HighLatencyP99',
  'DatabaseUnavailable',
  'CircuitBreakerOpen',
  'MemoryPressure',
];

describe('monitoring/alert-rules.yml', () => {
  it('is valid YAML with a top-level groups array', () => {
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.groups)).toBe(true);
    expect(parsed.groups.length).toBeGreaterThan(0);
  });

  it('defines the expected alert rule names', () => {
    for (const name of expectedRuleNames) {
      expect(
        rules.some((rule) => rule.alert === name),
        `missing alert rule: ${name}`,
      ).toBe(true);
    }
  });

  describe.each(expectedRuleNames)('%s', (name) => {
    const rule = ruleByName.get(name);

    it('has a PromQL expression', () => {
      expect(rule).toBeDefined();
      expect(typeof rule?.expr).toBe('string');
      expect(rule?.expr.trim().length).toBeGreaterThan(0);
    });

    it('has a for duration', () => {
      expect(rule?.for).toBeDefined();
      expect(typeof rule?.for).toBe('string');
      // Duration must look like "<number><unit>" (e.g. "5m", "2m", "10m").
      expect(rule?.for).toMatch(/^\d+[smh]$/);
    });

    it('has a severity label of critical or warning', () => {
      expect(rule?.labels?.severity).toBeDefined();
      expect(['critical', 'warning']).toContain(rule?.labels?.severity);
    });

    it('has a service label', () => {
      expect(rule?.labels?.service).toBe('eidolon');
    });

    it('has summary and description annotations', () => {
      expect(rule?.annotations?.summary).toBeDefined();
      expect(rule?.annotations?.description).toBeDefined();
    });
  });

  it('references the Eidolon metrics exposed by the server', () => {
    const expressions = rules.map((rule) => rule.expr).join('\n');
    expect(expressions).toContain('eidolon_http_requests_total');
    expect(expressions).toContain('eidolon_http_request_duration_seconds');
    expect(expressions).toContain('eidolon_provider_circuits_open');
  });
});
