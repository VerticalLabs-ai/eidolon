/**
 * Report backlog health for the Linear `EID` team against docs/delivery/backlog-health.md.
 *
 * A written policy nobody can check is a preference. This turns each rule into a
 * query, so "the backlog is healthy" is an assertion with evidence rather than
 * an impression formed by scrolling.
 *
 * Usage:
 *   pnpm backlog:health           # report, exit 1 if any rule is violated
 *   pnpm backlog:health -- --warn # report, always exit 0
 *
 * Requires LINEAR_API_KEY. Without it the command skips cleanly rather than
 * failing, so it can sit in a pipeline that has no Linear credential.
 */
import process from 'node:process';

const API = 'https://api.linear.app/graphql';
const TEAM_KEY = 'EID';
const STALE_DAYS = 60;
const warnOnly = process.argv.includes('--warn');

const key = process.env.LINEAR_API_KEY;
if (!key) {
  console.log('LINEAR_API_KEY is not set; skipping the backlog health check.');
  process.exit(0);
}

async function graphql(query, variables = {}) {
  const response = await fetch(API, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`Linear responded ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (body.errors) {
    // Message only: a Linear error payload can echo the query and identifiers.
    throw new Error(body.errors.map((error) => error.message).join('; '));
  }
  return body.data;
}

const QUERY = `
  query($key: String!, $after: String) {
    teams(filter: { key: { eq: $key } }, first: 1) {
      nodes {
        key
        issues(
          first: 100
          after: $after
          filter: { state: { type: { nin: ["completed", "canceled"] } } }
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            identifier
            title
            priority
            updatedAt
            url
            state { name type }
            labels { nodes { name } }
            parent { identifier state { type } }
            project { name }
            attachments { nodes { url } }
            children { nodes { id } }
          }
        }
      }
    }
  }
`;

const issues = [];
let after = null;
let teamKey = TEAM_KEY;
do {
  const data = await graphql(QUERY, { key: TEAM_KEY, after });
  const team = data.teams.nodes[0];
  if (!team) {
    console.error(`No Linear team with key ${TEAM_KEY}.`);
    process.exit(1);
  }
  teamKey = team.key;
  issues.push(...team.issues.nodes);
  after = team.issues.pageInfo.hasNextPage ? team.issues.pageInfo.endCursor : null;
} while (after);

const now = Date.now();
const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;
const names = (issue) => issue.labels.nodes.map((label) => label.name);
const has = (issue, prefix) => names(issue).some((name) => name.startsWith(prefix));

const rules = [
  {
    id: 'missing-type',
    description: 'carries no type/* label, so it cannot be filtered by kind of work',
    match: (issue) => !has(issue, 'type/'),
  },
  {
    id: 'missing-area',
    description: 'carries no area/* label, so it cannot be routed to part of the system',
    match: (issue) => !has(issue, 'area/'),
  },
  {
    id: 'multiple-types',
    description: 'carries more than one type/* label, so its kind is ambiguous',
    match: (issue) => names(issue).filter((name) => name.startsWith('type/')).length > 1,
  },
  {
    id: 'untriaged',
    description: 'has no priority, so it cannot be ordered against anything else',
    match: (issue) => !issue.priority,
  },
  {
    id: 'no-project',
    description: 'belongs to no project, so it is invisible in roadmap views',
    match: (issue) => !issue.project,
  },
  {
    id: 'review-without-pull-request',
    description: 'is In Review with no linked pull request, so the state overstates progress',
    // A parent is exempt: its pull requests hang off its children, so requiring
    // one on the parent would flag every correctly tracked epic.
    match: (issue) =>
      issue.state.name === 'In Review' &&
      issue.children.nodes.length === 0 &&
      !issue.attachments.nodes.some((attachment) => attachment.url.includes('/pull/')),
  },
  {
    id: 'parent-closed-with-open-child',
    description:
      'is open beneath a parent that is already closed, so the hierarchy misreports completion',
    match: (issue) => issue.parent?.state?.type === 'completed',
  },
  {
    id: 'stale',
    description: `has had no update in ${STALE_DAYS} days, so it is a claim nobody has re-checked`,
    match: (issue) => now - Date.parse(issue.updatedAt) > staleMs,
  },
];

const violations = rules
  .map((rule) => ({ rule, offenders: issues.filter((issue) => rule.match(issue)) }))
  .filter((entry) => entry.offenders.length > 0);

const priorityNames = ['none', 'urgent', 'high', 'medium', 'low'];
const distribution = new Map();
for (const issue of issues) {
  const label = priorityNames[issue.priority] ?? String(issue.priority);
  distribution.set(label, (distribution.get(label) ?? 0) + 1);
}

console.log(`Backlog health for ${teamKey}: ${issues.length} open issues\n`);
console.log('Priority distribution');
for (const label of priorityNames) {
  if (distribution.has(label)) {
    const count = distribution.get(label);
    const share = Math.round((count / issues.length) * 100);
    console.log(`  ${label.padEnd(7)} ${String(count).padStart(3)}  ${share}%`);
  }
}

const labelled = issues.filter((issue) => has(issue, 'type/') && has(issue, 'area/')).length;
console.log(`\nFully classified (type and area): ${labelled}/${issues.length}`);

if (violations.length === 0) {
  console.log('\nNo policy violations.');
  process.exit(0);
}

console.log('\nViolations');
for (const { rule, offenders } of violations) {
  console.log(`\n  ${rule.id} (${offenders.length}) — ${rule.description}`);
  for (const issue of offenders.slice(0, 15)) {
    console.log(`    ${issue.identifier}  ${issue.title.slice(0, 70)}`);
  }
  if (offenders.length > 15) {
    console.log(`    ... and ${offenders.length - 15} more`);
  }
}

const total = violations.reduce((sum, entry) => sum + entry.offenders.length, 0);
console.log(
  `\n${total} violation(s) across ${violations.length} rule(s). ` +
    'See docs/delivery/backlog-health.md.',
);
process.exit(warnOnly ? 0 : 1);
