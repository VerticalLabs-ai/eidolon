/**
 * Type declarations for scripts/quality-metrics-summary.mjs
 */

export interface TestCounts {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  testFiles: number;
}

export interface DuplicationResult {
  percentage: number;
  duplicatedLines: number;
  totalLines: number;
}

export function parseTestCounts(output: string): TestCounts | null;
export function parseDuplication(output: string): DuplicationResult | null;
export function buildSummary(): string;
