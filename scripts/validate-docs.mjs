import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = ['README.md', 'AGENTS.md', 'docs/openapi.yaml', 'docs/runbooks/README.md'];
const missing = required.filter((file) => !existsSync(path.join(root, file)));
const ignoredDirectories = new Set(['.git', '.gitnexus', 'coverage', 'dist', 'node_modules']);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : markdownFiles(file);
    }
    return entry.name.endsWith('.md') ? [file] : [];
  });
}

const brokenLinks = [];
const maintainedMarkdown = [
  path.join(root, 'README.md'),
  path.join(root, 'AGENTS.md'),
  ...markdownFiles(path.join(root, 'docs')),
];

for (const file of maintainedMarkdown) {
  const contents = readFileSync(file, 'utf8');
  for (const match of contents.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(https?:|mailto:)/.test(target)) {
      continue;
    }

    const resolved = path.resolve(path.dirname(file), target);
    if (!existsSync(resolved)) {
      brokenLinks.push(`${path.relative(root, file)} → ${target}`);
    }
  }
}

const agents = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
if (!agents.includes('## Promotion')) {
  missing.push('AGENTS.md promotion instructions');
}

// Every runbook must be reachable from the runbook index. Without this a new
// procedure can land in the directory and never be found during an incident,
// which is exactly when nobody is going to go spelunking for it.
const runbookDirectory = path.join(root, 'docs', 'runbooks');
const runbookIndexPath = path.join(runbookDirectory, 'README.md');
const runbookIndex = readFileSync(runbookIndexPath, 'utf8');
const linkedRunbooks = new Set(
  Array.from(runbookIndex.matchAll(/\[[^\]]*]\(([^)]+)\)/g), (match) =>
    path.basename(match[1].split('#', 1)[0]),
  ),
);
const unindexedRunbooks = readdirSync(runbookDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)
  .filter((name) => name !== 'README.md' && !linkedRunbooks.has(name));

if (missing.length || brokenLinks.length || unindexedRunbooks.length) {
  if (missing.length) {
    console.error(`Missing required documentation:\n${missing.join('\n')}`);
  }
  if (brokenLinks.length) {
    console.error(`Broken relative Markdown links:\n${brokenLinks.join('\n')}`);
  }
  if (unindexedRunbooks.length) {
    console.error(
      'Runbooks not linked from docs/runbooks/README.md:\n' +
        unindexedRunbooks.map((name) => `docs/runbooks/${name}`).join('\n'),
    );
  }
  process.exit(1);
}

console.log(`Documentation validated: ${maintainedMarkdown.length} Markdown files checked.`);
