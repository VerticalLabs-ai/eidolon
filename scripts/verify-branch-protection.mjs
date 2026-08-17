/**
 * Verifies that GitHub branch protection rulesets are correctly configured
 * on both the `main` and `staging` branches.
 *
 * Required rules on each branch:
 *   - pull_request: at least 1 approving review (code-owner review enabled)
 *   - no required status checks while CI billing is unavailable
 *   - non_fast_forward: force-push blocked
 *   - enforcement: "active"
 *   - main bypass_actors: GitHub Actions bot identity only
 *   - staging bypass_actors: empty (enforced for administrators)
 *
 * Usage:  node scripts/verify-branch-protection.mjs
 * Exit:   0 if all checks pass, 1 otherwise
 */

import { execSync } from 'node:child_process';

const REPO = 'VerticalLabs-ai/eidolon';
const BRANCHES = ['main', 'staging'];
const REQUIRED_REVIEW_COUNT = 1;
const GITHUB_ACTIONS_APP_ID = 41898282;

/**
 * Fetches all repository ruleset summaries from the GitHub API.
 * The list endpoint returns summaries without conditions or rules,
 * so each must be fetched individually for full details.
 * @returns {Array<object>} Array of ruleset summary objects.
 */
function fetchRulesetSummaries() {
  const output = execSync(`gh api repos/${REPO}/rulesets`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

/**
 * Fetches a single ruleset by ID (includes full rule details and conditions).
 * @param {number} id - The ruleset ID.
 * @returns {object} The ruleset object with full details.
 */
function fetchRulesetDetail(id) {
  const output = execSync(`gh api repos/${REPO}/rulesets/${id}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

/**
 * Finds the detailed ruleset that targets a given branch.
 * Fetches each ruleset's details to inspect its conditions.
 * @param {Array<object>} summaries - List of ruleset summaries from the list endpoint.
 * @param {string} branch - The branch name (e.g. "main").
 * @returns {object|null} The matching ruleset detail, or null.
 */
function findRulesetForBranch(summaries, branch) {
  const refPattern = `refs/heads/${branch}`;
  for (const summary of summaries) {
    if (summary.target !== 'branch') {
      continue;
    }
    const detail = fetchRulesetDetail(summary.id);
    const includes = detail.conditions?.ref_name?.include ?? [];
    if (includes.includes(refPattern)) {
      return detail;
    }
  }
  return null;
}

/**
 * Validates a single ruleset against the required branch protection policy.
 * @param {object} ruleset - The full ruleset detail object.
 * @param {string} branch - The branch name being validated.
 * @returns {Array<string>} List of error messages (empty if valid).
 */
function validateRuleset(ruleset, branch) {
  const errors = [];

  // Enforcement must be "active"
  if (ruleset.enforcement !== 'active') {
    errors.push(`${branch}: enforcement is "${ruleset.enforcement}", expected "active"`);
  }

  // The promotion workflow pushes directly to main, so only the GitHub Actions
  // app may bypass main. Human pushes remain subject to the ruleset.
  const bypassActors = ruleset.bypass_actors ?? [];
  if (branch === 'main') {
    const validActionsBypass =
      bypassActors.length === 1 &&
      bypassActors[0].actor_id === GITHUB_ACTIONS_APP_ID &&
      bypassActors[0].actor_type === 'User' &&
      bypassActors[0].bypass_mode === 'always';
    if (!validActionsBypass) {
      errors.push(`${branch}: expected GitHub Actions bypass actor ${GITHUB_ACTIONS_APP_ID} only`);
    }
  } else if (bypassActors.length > 0) {
    errors.push(
      `${branch}: bypass_actors is non-empty (${bypassActors.length} actor(s)), expected empty`,
    );
  }

  const rules = ruleset.rules ?? [];

  // pull_request rule
  const prRule = rules.find((r) => r.type === 'pull_request');
  if (!prRule) {
    errors.push(`${branch}: missing "pull_request" rule`);
  } else {
    const count = prRule.parameters?.required_approving_review_count;
    if (count === undefined || count < REQUIRED_REVIEW_COUNT) {
      errors.push(
        `${branch}: required_approving_review_count is ${count}, expected >= ${REQUIRED_REVIEW_COUNT}`,
      );
    }
    if (!prRule.parameters?.require_code_owner_review) {
      errors.push(`${branch}: require_code_owner_review is false, expected true`);
    }
  }

  // CI billing is currently unavailable. Do not require checks that cannot run.
  if (rules.some((r) => r.type === 'required_status_checks')) {
    errors.push(`${branch}: required_status_checks must be omitted while CI is unavailable`);
  }

  // non_fast_forward rule (blocks force-push)
  const nonFFRule = rules.find((r) => r.type === 'non_fast_forward');
  if (!nonFFRule) {
    errors.push(`${branch}: missing "non_fast_forward" rule (force-push not blocked)`);
  }

  return errors;
}

// --- Main ---

const allErrors = [];
const summaries = fetchRulesetSummaries();

for (const branch of BRANCHES) {
  const detail = findRulesetForBranch(summaries, branch);
  if (!detail) {
    allErrors.push(`${branch}: no ruleset found targeting this branch`);
    continue;
  }

  const errors = validateRuleset(detail, branch);
  allErrors.push(...errors);

  if (errors.length === 0) {
    console.log(`✓ ${branch}: branch protection ruleset is correctly configured`);
  }
}

if (allErrors.length > 0) {
  console.error('\nBranch protection verification FAILED:');
  for (const err of allErrors) {
    console.error(`  ✗ ${err}`);
  }
  process.exit(1);
}

console.log('\nAll branch protection rulesets verified successfully.');
