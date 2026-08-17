/**
 * Reconcile the GitHub repository labels against `.github/labels.json`.
 *
 * The taxonomy has to live somewhere reviewable. A label list that exists only
 * in the GitHub UI cannot be code-reviewed, cannot be diffed, and drifts the
 * moment someone renames one in passing — which is how this repository ended up
 * with nine stock labels and a Linear team using a different vocabulary.
 *
 * Usage:
 *   pnpm labels:check    # report drift, exit 1 if any (safe, read-only)
 *   pnpm labels:sync     # create and update labels to match the file
 *
 * `sync` never deletes. An unexpected label is reported, not removed: a label
 * may be applied to closed issues that would silently lose their
 * classification, and that is not a decision a script should make.
 *
 * Auth: uses `gh api`, so it relies on the caller's existing GitHub CLI
 * authentication and never handles a token itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const DEFINITION = '.github/labels.json';
const mode = process.argv.includes('--sync') ? 'sync' : 'check';

function gh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function repositorySlug() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

function normalize(label) {
  return {
    name: label.name,
    color: String(label.color).replace(/^#/, '').toLowerCase(),
    description: label.description ?? '',
  };
}

const definition = JSON.parse(readFileSync(DEFINITION, 'utf8'));
if (!Array.isArray(definition.labels) || definition.labels.length === 0) {
  console.error(`${DEFINITION} defines no labels.`);
  process.exit(1);
}

const duplicates = definition.labels
  .map((label) => label.name)
  .filter((name, index, all) => all.indexOf(name) !== index);
if (duplicates.length > 0) {
  console.error(`${DEFINITION} defines duplicate labels: ${duplicates.join(', ')}`);
  process.exit(1);
}

const slug = repositorySlug();
let remote;
try {
  remote = JSON.parse(
    gh(['api', '--paginate', `repos/${slug}/labels`, '--jq', '[.[] | {name, color, description}]']),
  );
} catch (error) {
  console.error(
    `Could not read labels for ${slug}. Authenticate the GitHub CLI first (gh auth login).\n` +
      String(error.message ?? error).split('\n')[0],
  );
  process.exit(1);
}

const remoteByName = new Map(remote.map((label) => [label.name, normalize(label)]));
const missing = [];
const changed = [];

for (const raw of definition.labels) {
  const wanted = normalize(raw);
  const actual = remoteByName.get(wanted.name);
  if (!actual) {
    missing.push(wanted);
    continue;
  }
  if (actual.color !== wanted.color || (actual.description ?? '') !== wanted.description) {
    changed.push({ wanted, actual });
  }
}

const unexpected = remote
  .map((label) => label.name)
  .filter((name) => !definition.labels.some((label) => label.name === name));

function report() {
  for (const label of missing) {
    console.log(`missing  ${label.name}`);
  }
  for (const { wanted, actual } of changed) {
    const parts = [];
    if (actual.color !== wanted.color) {
      parts.push(`color ${actual.color} -> ${wanted.color}`);
    }
    if (actual.description !== wanted.description) {
      parts.push('description differs');
    }
    console.log(`drifted  ${wanted.name} (${parts.join(', ')})`);
  }
  for (const name of unexpected) {
    console.log(`extra    ${name} (not in ${DEFINITION}; never removed automatically)`);
  }
}

if (mode === 'check') {
  report();
  const drift = missing.length + changed.length;
  if (drift > 0) {
    console.error(
      `\n${drift} label(s) differ from ${DEFINITION}. Run \`pnpm labels:sync\` to reconcile.`,
    );
    process.exit(1);
  }
  console.log(
    `Labels match ${DEFINITION} (${definition.labels.length} defined` +
      `${unexpected.length > 0 ? `, ${unexpected.length} extra reported above` : ''}).`,
  );
  process.exit(0);
}

report();

for (const label of missing) {
  gh([
    'api',
    '-X',
    'POST',
    `repos/${slug}/labels`,
    '-f',
    `name=${label.name}`,
    '-f',
    `color=${label.color}`,
    '-f',
    `description=${label.description}`,
  ]);
  console.log(`created  ${label.name}`);
}

for (const { wanted } of changed) {
  gh([
    'api',
    '-X',
    'PATCH',
    `repos/${slug}/labels/${encodeURIComponent(wanted.name)}`,
    '-f',
    `new_name=${wanted.name}`,
    '-f',
    `color=${wanted.color}`,
    '-f',
    `description=${wanted.description}`,
  ]);
  console.log(`updated  ${wanted.name}`);
}

console.log(
  `\nSynced ${missing.length} created, ${changed.length} updated. ` +
    `${unexpected.length} extra label(s) left in place for a human to decide on.`,
);
