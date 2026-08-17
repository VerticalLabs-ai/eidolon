import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface RenovateConfig {
  extends?: string | string[];
  dependencyDashboard?: boolean;
  minimumReleaseAge?: string | number;
  rangeStrategy?: string;
  packageRules?: Array<{
    matchManagers?: string[];
    groupName?: string;
    matchUpdateTypes?: string[];
  }>;
}

const renovatePath = resolve(import.meta.dirname, '../../../renovate.json');
const config = JSON.parse(readFileSync(renovatePath, 'utf8')) as RenovateConfig;

function parseReleaseAge(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
  if (!match) {
    return 0;
  }
  const numeric = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  // EXACT unit name matching only. Accepts the singular and plural form of
  // each supported unit. Misspelled or look-alike units (e.g. "dayz",
  // "hourglass") are rejected (return 0) so they fail the at-least-3-days
  // assertion. Prefix matching (startsWith) is intentionally NOT used because
  // it would accept "dayz" as a day unit.
  if (unit === 'day' || unit === 'days') {
    return numeric;
  }
  if (unit === 'week' || unit === 'weeks') {
    return numeric * 7;
  }
  if (unit === 'month' || unit === 'months') {
    return numeric * 30;
  }
  if (unit === 'hour' || unit === 'hours') {
    return numeric / 24;
  }
  // Unknown unit — reject.
  return 0;
}

describe('renovate configuration', () => {
  it('is valid JSON', () => {
    expect(config).toBeDefined();
  });

  it('extends a recommended preset', () => {
    const presets = Array.isArray(config.extends) ? config.extends : [config.extends];
    expect(presets).toContain('config:recommended');
  });

  it('enables the dependency dashboard', () => {
    expect(config.dependencyDashboard).toBe(true);
  });

  it('configures minimumReleaseAge of at least 3 days', () => {
    expect(config).toHaveProperty('minimumReleaseAge');
    expect(config.minimumReleaseAge).toBeDefined();
    expect(parseReleaseAge(config.minimumReleaseAge)).toBeGreaterThanOrEqual(3);
  });

  it('parseReleaseAge rejects unknown duration units', () => {
    expect(parseReleaseAge('5 minutes')).toBe(0);
    expect(parseReleaseAge('10 seconds')).toBe(0);
    expect(parseReleaseAge('2 years')).toBe(0);
    expect(parseReleaseAge('3 fortnights')).toBe(0);
  });

  it('parseReleaseAge rejects misspelled and look-alike unit names via exact matching', () => {
    // '3 dayz' shares the "day" prefix but is not an exact match for 'day'/'days'.
    expect(parseReleaseAge('3 dayz')).toBe(0);
    // '3 hourglass' shares the "hour" prefix but is not an exact match for 'hour'/'hours'.
    expect(parseReleaseAge('3 hourglass')).toBe(0);
    // Other prefix-collisions that exact matching must reject.
    expect(parseReleaseAge('3 dayzly')).toBe(0);
    expect(parseReleaseAge('3 hourly')).toBe(0);
    expect(parseReleaseAge('3 weeky')).toBe(0);
    expect(parseReleaseAge('3 monthly')).toBe(0);
  });

  it('parseReleaseAge correctly parses sub-three-day durations that should fail the at-least-3-days assertion', () => {
    // These durations are all less than 3 days and must fail the >= 3 check.
    expect(parseReleaseAge('3 hours')).toBeLessThan(3);
    expect(parseReleaseAge('12 hours')).toBeLessThan(3);
    expect(parseReleaseAge('1 hour')).toBeLessThan(3);
    expect(parseReleaseAge('2 days')).toBeLessThan(3);
    // '3 minutes' is an unknown unit → rejected → 0, which is < 3.
    expect(parseReleaseAge('3 minutes')).toBeLessThan(3);
  });

  it('parseReleaseAge correctly parses supported duration units', () => {
    expect(parseReleaseAge('3 days')).toBe(3);
    expect(parseReleaseAge('1 week')).toBe(7);
    expect(parseReleaseAge('1 month')).toBe(30);
    expect(parseReleaseAge('72 hours')).toBe(3);
    expect(parseReleaseAge(5)).toBe(5);
  });

  it('groups pnpm patch and minor updates', () => {
    const pnpmRule = config.packageRules?.find((rule) => rule.matchManagers?.includes('pnpm'));
    expect(pnpmRule).toBeDefined();
    expect(pnpmRule?.groupName).toBeDefined();
    expect(pnpmRule?.matchUpdateTypes).toContain('patch');
    expect(pnpmRule?.matchUpdateTypes).toContain('minor');
  });

  it('pins dependency ranges', () => {
    expect(config.rangeStrategy).toBe('pin');
  });
});
