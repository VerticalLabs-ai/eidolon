#!/usr/bin/env node
/**
 * Quality metrics summary generator.
 *
 * Reads the vitest coverage-summary.json, optional captured command
 * outputs (test results, duplication, dead-code), and writes a Markdown
 * report to $GITHUB_STEP_SUMMARY (or stdout when not running in CI).
 *
 * Usage:
 *   node scripts/quality-metrics-summary.mjs \
 *     [coverage-summary.json] \
 *     [test-output.txt] \
 *     [duplication-output.txt] \
 *     [dead-code-output.txt]
 *
 * When invoked without arguments, defaults to:
 *   coverage/coverage-summary.json
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

const coveragePath = args[0] || 'coverage/coverage-summary.json';
const testOutputPath = args[1] || '';
const dupOutputPath = args[2] || '';
const deadCodeOutputPath = args[3] || '';

/**
 * Parse a vitest text-reporter output line to extract test counts.
 * Example line: "Tests  2541 passed (2542)" or "Tests  2540 passed | 2 failed | 1 skipped"
 *
 * @param {string} output - Raw vitest stdout
 * @returns {{tests: number, passed: number, failed: number, skipped: number, testFiles: number} | null}
 */
export function parseTestCounts(output) {
  if (!output) {
    return null;
  }

  const testsLine = output.match(
    /^[\s ]*Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?/m,
  );
  const filesLine = output.match(/^[\s ]*Test Files\s+(\d+)\s+passed(?:\s*\((\d+)\))?/m);

  if (!testsLine) {
    return null;
  }

  return {
    tests:
      parseInt(testsLine[1], 10) +
      parseInt(testsLine[2] || '0', 10) +
      parseInt(testsLine[3] || '0', 10),
    passed: parseInt(testsLine[1], 10),
    failed: parseInt(testsLine[2] || '0', 10),
    skipped: parseInt(testsLine[3] || '0', 10),
    testFiles: filesLine ? parseInt(filesLine[1], 10) : 0,
  };
}

/**
 * Parse jscpd console output to extract the duplication percentage.
 * Example line: "Total: 2.34% (45 duplicated lines)"
 *
 * @param {string} output - Raw jscpd stdout
 * @returns {{percentage: number, duplicatedLines: number, totalLines: number} | null}
 */
export function parseDuplication(output) {
  if (!output) {
    return null;
  }

  // jscpd console reporter prints a summary line like:
  // "Total: 2.34% (45 duplicated lines)"
  // or the newer format: "Clones detected: 2.34%"
  const totalMatch = output.match(/Total:\s+([\d.]+)%\s*\((\d+)\s+duplicated lines\)/);
  if (totalMatch) {
    return {
      percentage: parseFloat(totalMatch[1]),
      duplicatedLines: parseInt(totalMatch[2], 10),
      totalLines: 0,
    };
  }

  const clonesMatch = output.match(/Clones detected:\s+([\d.]+)%/);
  if (clonesMatch) {
    return {
      percentage: parseFloat(clonesMatch[1]),
      duplicatedLines: 0,
      totalLines: 0,
    };
  }

  return null;
}

/**
 * Build the Markdown summary from the parsed metrics.
 *
 * @returns {string} Markdown content
 */
export function buildSummary() {
  const lines = [];
  lines.push('## Code Quality Metrics');
  lines.push('');

  // Coverage
  if (existsSync(coveragePath)) {
    const cov = JSON.parse(readFileSync(coveragePath, 'utf8'));
    const t = cov.total;
    if (t) {
      lines.push('### Coverage');
      lines.push('');
      lines.push('| Metric | Percentage | Covered / Total |');
      lines.push('|--------|-----------|-----------------|');
      lines.push(`| Lines | ${t.lines.pct}% | ${t.lines.covered} / ${t.lines.total} |`);
      lines.push(
        `| Statements | ${t.statements.pct}% | ${t.statements.covered} / ${t.statements.total} |`,
      );
      lines.push(
        `| Functions | ${t.functions.pct}% | ${t.functions.covered} / ${t.functions.total} |`,
      );
      lines.push(`| Branches | ${t.branches.pct}% | ${t.branches.covered} / ${t.branches.total} |`);
      lines.push('');
    }
  }

  // Test counts
  if (testOutputPath && existsSync(testOutputPath)) {
    const testOutput = readFileSync(testOutputPath, 'utf8');
    const counts = parseTestCounts(testOutput);
    if (counts) {
      lines.push('### Test Results');
      lines.push('');
      lines.push('| Metric | Count |');
      lines.push('|--------|-------|');
      lines.push(`| Test Files | ${counts.testFiles} |`);
      lines.push(`| Tests Passed | ${counts.passed} |`);
      if (counts.failed > 0) {
        lines.push(`| Tests Failed | ${counts.failed} |`);
      }
      if (counts.skipped > 0) {
        lines.push(`| Tests Skipped | ${counts.skipped} |`);
      }
      lines.push(`| Tests Total | ${counts.tests} |`);
      lines.push('');
    }
  }

  // Duplication
  if (dupOutputPath && existsSync(dupOutputPath)) {
    const dupOutput = readFileSync(dupOutputPath, 'utf8');
    const dup = parseDuplication(dupOutput);
    lines.push('### Duplication');
    lines.push('');
    if (dup) {
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      lines.push(`| Duplication % | ${dup.percentage}% |`);
      if (dup.duplicatedLines > 0) {
        lines.push(`| Duplicated Lines | ${dup.duplicatedLines} |`);
      }
      lines.push('');
    } else {
      lines.push('```');
      lines.push(dupOutput.trim());
      lines.push('```');
      lines.push('');
    }
  }

  // Dead code
  if (deadCodeOutputPath && existsSync(deadCodeOutputPath)) {
    const dcOutput = readFileSync(deadCodeOutputPath, 'utf8').trim();
    lines.push('### Dead Code Analysis');
    lines.push('');
    if (dcOutput) {
      lines.push('```');
      lines.push(dcOutput);
      lines.push('```');
    } else {
      lines.push('No dead code or unused dependencies detected. ✅');
    }
    lines.push('');
  }

  return lines.join('\n');
}

const output = buildSummary();

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  appendFileSync(summaryFile, output + '\n');
} else {
  console.log(output);
}
