#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Sentry alert → GitHub issue dispatch.
//
// Extracted from .github/workflows/sentry-issue.yml so the payload parsing,
// deduplication, and issue body construction can be unit-tested. The workflow
// calls this script via `node`; tests import the exported functions directly.
// ---------------------------------------------------------------------------

/** @typedef {{ shortId?: string, id?: string, title?: string, web_url?: string, url?: string }} SentryIssue */
/** @typedef {{ issue?: SentryIssue, data?: { issue?: SentryIssue }, shortId?: string, title?: string, url?: string }} SentryPayload */
/** @typedef {{ title: string, body: string, labels: string[] }} IssueDraft */

export const REQUIRED_LABELS = [
  { name: 'sentry', color: '6f42c1', description: 'Created from Sentry error tracking' },
  {
    name: 'type/bug',
    color: 'd73a4a',
    description: 'Behaviour is wrong relative to a documented or intended contract',
  },
];

/**
 * Extract a normalised Sentry issue from the raw dispatch payload, tolerating
 * the shape variations Sentry has sent over time.
 *
 * Returns `null` when the payload is so malformed that no issue can be
 * identified — the caller must not create an unusable GitHub issue in that case.
 *
 * @param {unknown} raw
 * @returns {{ shortId: string, title: string, url: string } | null}
 */
export function parseSentryPayload(raw) {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const payload = /** @type {SentryPayload} */ (raw);
  const sentryIssue = payload.issue ?? payload.data?.issue ?? {};
  const shortId = String(sentryIssue.shortId ?? sentryIssue.id ?? payload.shortId ?? '');
  const rawTitle = sentryIssue.title ?? payload.title ?? '';
  const url = sentryIssue.web_url ?? sentryIssue.url ?? payload.url ?? '';

  if (!shortId || !rawTitle) {
    return null;
  }

  return {
    shortId,
    title: String(rawTitle).slice(0, 180),
    url,
  };
}

/**
 * Build the GitHub issue title from a parsed Sentry alert.
 *
 * @param {{ shortId: string, title: string, url: string }} data
 * @returns {string}
 */
export function createIssueTitle(data) {
  return `Sentry alert: ${data.title}`;
}

/**
 * Build the GitHub issue body. The body must never include the raw Sentry
 * payload, stack traces, or event data — only the short ID and a link.
 *
 * @param {{ shortId: string, title: string, url: string }} data
 * @returns {string}
 */
export function createIssueBody(data) {
  return [
    'Automated issue from Sentry.',
    '',
    `Sentry ID: ${data.shortId}`,
    data.url ? `Sentry link: ${data.url}` : '',
    '',
    'Triage the error in Sentry before adding customer or request data here.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Check whether an existing open issue already tracks this Sentry ID.
 *
 * @param {{ body?: string | null }[]} existingIssues
 * @param {string} sentryId
 * @returns {boolean}
 */
export function findDuplicate(existingIssues, sentryId) {
  const marker = `Sentry ID: ${sentryId}`;
  return existingIssues.some((issue) => issue.body?.includes(marker) ?? false);
}

/**
 * Build the complete issue draft (title, body, labels) from a parsed payload.
 *
 * @param {{ shortId: string, title: string, url: string }} data
 * @returns {IssueDraft}
 */
export function buildIssueDraft(data) {
  return {
    title: createIssueTitle(data),
    body: createIssueBody(data),
    labels: REQUIRED_LABELS.map((label) => label.name),
  };
}

/**
 * Result of a dispatch, for logging and testing.
 *
 * @typedef {{ ok: true, action: 'created' | 'deduplicated', shortId: string }} DispatchResult
 */

/**
 * Process a Sentry dispatch payload against a list of existing open issues.
 *
 * This is the pure logic; the workflow wraps it with GitHub API calls.
 *
 * @param {unknown} payload
 * @param {{ body?: string | null }[]} existingOpenIssues
 * @returns {{ ok: true, action: 'created', draft: IssueDraft, shortId: string } | { ok: true, action: 'deduplicated', shortId: string } | { ok: false, reason: string }}
 */
export function processDispatch(payload, existingOpenIssues) {
  const data = parseSentryPayload(payload);
  if (!data) {
    return {
      ok: false,
      reason: 'Payload missing required Sentry issue fields (shortId and title)',
    };
  }

  if (findDuplicate(existingOpenIssues, data.shortId)) {
    return { ok: true, action: 'deduplicated', shortId: data.shortId };
  }

  return { ok: true, action: 'created', draft: buildIssueDraft(data), shortId: data.shortId };
}

// ---------------------------------------------------------------------------
// CLI entry point — used by the GitHub Actions workflow.
// ---------------------------------------------------------------------------

async function ensureLabels(owner, repo, token) {
  for (const label of REQUIRED_LABELS) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/labels/${label.name}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) {
      await fetch(`https://api.github.com/repos/${owner}/${repo}/labels`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        body: JSON.stringify(label),
      });
    } else if (!res.ok) {
      throw new Error(`Failed to check label ${label.name}: ${res.status}`);
    }
  }
}

async function listOpenIssues(owner, repo, token) {
  const issues = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) {
      throw new Error(`Failed to list issues: ${res.status}`);
    }
    const batch = await res.json();
    issues.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page++;
  }
  return issues;
}

async function createIssue(owner, repo, token, draft) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify(draft),
  });
  if (!res.ok) {
    throw new Error(`Failed to create issue: ${res.status}`);
  }
  return res.json();
}

async function main() {
  const payload = JSON.parse(process.env.SENTRY_PAYLOAD ?? '{}');
  const owner = process.env.GITHUB_REPOSITORY?.split('/')[0] ?? '';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';

  if (!owner || !repo || !token) {
    console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
    process.exit(1);
  }

  const existing = await listOpenIssues(owner, repo, token);
  const result = processDispatch(payload, existing);

  if (!result.ok) {
    console.log(`Skipping: ${result.reason}`);
    return;
  }

  if (result.action === 'deduplicated') {
    console.log(`An open issue already tracks Sentry ID ${result.shortId}.`);
    return;
  }

  await ensureLabels(owner, repo, token);
  const issue = await createIssue(owner, repo, token, result.draft);
  console.log(`Created issue #${issue.number}: ${issue.html_url}`);
}

// Run main() only when executed as a script, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
