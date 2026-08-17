/**
 * Render a readable security summary from CodeQL SARIF output.
 *
 * CodeQL already uploads results to the GitHub security tab. That is the wrong
 * place for a reviewer: a pull request shows no security summary, and nothing is
 * downloadable after the run. This turns the SARIF into Markdown for the run
 * summary and an artifact.
 *
 * Usage:
 *   node scripts/summarize-sarif.mjs <file-or-directory> [--out summary.md]
 *
 * Reporting only. It never fails a build on findings, because the gate is
 * CodeQL's own analysis step and a reporting script that can fail the job would
 * make the gate less trustworthy, not more. It exits non-zero only when it
 * cannot do its job: a missing path or unparseable SARIF.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MAX_LOCATIONS_PER_RULE = 5;

// SARIF `level` is coarse. CodeQL also emits a numeric security-severity, which
// is what GitHub's own severity filter uses, so prefer it when present.
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'warning', 'note', 'none'];

function severityFromScore(score) {
  const value = Number(score);
  if (Number.isNaN(value)) {
    return null;
  }
  if (value >= 9) {
    return 'critical';
  }
  if (value >= 7) {
    return 'high';
  }
  if (value >= 4) {
    return 'medium';
  }
  return 'low';
}

function sarifFiles(target) {
  const stats = statSync(target);
  if (stats.isFile()) {
    return [target];
  }
  return readdirSync(target)
    .filter((name) => name.endsWith('.sarif') || name.endsWith('.sarif.json'))
    .map((name) => path.join(target, name))
    .sort();
}

/** Index rule metadata by id so a result can resolve its own severity and name. */
function ruleIndex(run) {
  const index = new Map();
  const driver = run.tool?.driver ?? {};
  const extensions = run.tool?.extensions ?? [];
  for (const component of [driver, ...extensions]) {
    for (const rule of component.rules ?? []) {
      index.set(rule.id, rule);
    }
  }
  return index;
}

function resultSeverity(result, rule) {
  const score = result.properties?.['security-severity'] ?? rule?.properties?.['security-severity'];
  return severityFromScore(score) ?? result.level ?? rule?.defaultConfiguration?.level ?? 'warning';
}

export function summarize(documents) {
  const byRule = new Map();
  let total = 0;
  const tools = new Set();

  for (const document of documents) {
    for (const run of document.runs ?? []) {
      const name = run.tool?.driver?.name;
      if (name) {
        tools.add(name);
      }
      const rules = ruleIndex(run);
      for (const result of run.results ?? []) {
        total += 1;
        const ruleId = result.ruleId ?? result.rule?.id ?? 'unknown-rule';
        const rule = rules.get(ruleId);
        const severity = resultSeverity(result, rule);
        const key = `${severity}::${ruleId}`;
        const entry = byRule.get(key) ?? {
          severity,
          ruleId,
          title: rule?.shortDescription?.text ?? rule?.name ?? ruleId,
          count: 0,
          locations: [],
        };
        entry.count += 1;

        const physical = result.locations?.[0]?.physicalLocation;
        const file = physical?.artifactLocation?.uri;
        if (file && entry.locations.length < MAX_LOCATIONS_PER_RULE) {
          const line = physical?.region?.startLine;
          entry.locations.push(line ? `${file}:${line}` : file);
        }
        byRule.set(key, entry);
      }
    }
  }

  const entries = [...byRule.values()].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    return bySeverity !== 0 ? bySeverity : b.count - a.count;
  });

  const counts = {};
  for (const entry of entries) {
    counts[entry.severity] = (counts[entry.severity] ?? 0) + entry.count;
  }

  return { total, entries, counts, tools: [...tools].sort() };
}

export function renderMarkdown(summary, { scannedFiles = 0 } = {}) {
  const lines = ['## Security review summary', ''];
  const toolLabel = summary.tools.length > 0 ? summary.tools.join(', ') : 'CodeQL';

  if (summary.total === 0) {
    lines.push(
      `**No findings.** ${toolLabel} analysed the workspace and reported 0 results ` +
        `across ${scannedFiles} SARIF file(s).`,
      '',
      'This is an explicit clean result, not a skipped step.',
    );
    return `${lines.join('\n')}\n`;
  }

  lines.push(`${toolLabel} reported **${summary.total}** finding(s).`, '', '### By severity', '');
  lines.push('| Severity | Findings |', '| --- | --- |');
  for (const severity of SEVERITY_ORDER) {
    if (summary.counts[severity]) {
      lines.push(`| ${severity} | ${summary.counts[severity]} |`);
    }
  }

  lines.push('', '### By rule', '');
  lines.push('| Severity | Rule | Findings | Example locations |', '| --- | --- | --- | --- |');
  for (const entry of summary.entries) {
    const locations = entry.locations.length > 0 ? entry.locations.join('<br>') : '—';
    const more =
      entry.count > entry.locations.length
        ? ` (+${entry.count - entry.locations.length} more)`
        : '';
    lines.push(
      `| ${entry.severity} | \`${entry.ruleId}\`<br>${entry.title} | ${entry.count} | ${locations}${more} |`,
    );
  }

  lines.push('', 'Full results, including data flow paths, are in the repository security tab.');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith('--'));
  const outIndex = args.indexOf('--out');
  const outFile = outIndex >= 0 ? args[outIndex + 1] : null;

  if (!target) {
    console.error('Usage: node scripts/summarize-sarif.mjs <file-or-directory> [--out file.md]');
    process.exit(1);
  }

  let files;
  try {
    files = sarifFiles(target);
  } catch (error) {
    console.error(`Cannot read SARIF from "${target}": ${error.message}`);
    process.exit(1);
  }

  const documents = [];
  for (const file of files) {
    try {
      documents.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      console.error(`Cannot parse SARIF file "${file}": ${error.message}`);
      process.exit(1);
    }
  }

  const markdown = renderMarkdown(summarize(documents), { scannedFiles: files.length });
  process.stdout.write(markdown);
  if (outFile) {
    writeFileSync(outFile, markdown);
  }
}

// Only run as a CLI, so the pure functions above stay unit-testable.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
