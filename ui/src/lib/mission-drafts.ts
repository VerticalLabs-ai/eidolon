/**
 * Principal-scoped Mission draft storage.
 *
 * Every Mission request, question, revision, rejection, and cancellation
 * draft key includes the authenticated principal plus company/project/
 * thread/run/card version and is stored per tab in `sessionStorage`.
 *
 * Logout, token expiry, account switch, membership removal, or session
 * replacement makes the prior principal's drafts unreadable because the
 * key includes the principal ID. Session end (tab close) clears
 * `sessionStorage` automatically.
 *
 * Draft values never enter analytics, error reporting, logs, URLs,
 * cross-tab broadcasts, or another browser session. `sessionStorage` is
 * per-tab and never transmitted to a server or analytics endpoint.
 *
 * (VAL-MODEQ-121, VAL-MODEQ-149)
 */

/** Draft scopes within the Mission lifecycle. Each scope produces a
 * distinct storage namespace so, e.g., a request draft and a cancellation
 * reason draft do not collide. */
export type MissionDraftScope =
  | 'chat' // legacy Chat unsent message
  | 'mission-request' // Mission composer request text
  | 'mission-mode' // selected Mission mode (auto/fast/deep_work/analyst)
  | 'mission-mode-profile' // selected custom profile ID
  | 'question-answer' // typed question answer draft
  | 'plan-revision' // plan revision feedback draft
  | 'plan-rejection' // plan rejection reason draft
  | 'cancel-reason'; // cancellation reason draft

/** Build a principal-scoped sessionStorage key for a Mission draft.
 *
 * The key always includes the principal ID so a different authenticated
 * user (after logout, account switch, or session replacement) cannot read
 * the prior principal's drafts. Company, project, and thread scope the
 * draft to its conversation context. Run and card version further scope
 * per-run/per-card drafts (question answers, revision feedback, etc.).
 */
export function buildDraftKey(params: {
  principalId: string;
  scope: MissionDraftScope;
  companyId: string;
  projectId: string;
  threadId?: string;
  runId?: string;
  cardVersion?: string | number;
}): string {
  const { principalId, scope, companyId, projectId, threadId, runId, cardVersion } = params;
  const parts = ['mission-draft', principalId, scope, companyId, projectId];
  if (threadId) {
    parts.push(threadId);
  }
  if (runId) {
    parts.push(runId);
  }
  if (cardVersion !== undefined) {
    parts.push(String(cardVersion));
  }
  return parts.join(':');
}

/** Read a draft value from sessionStorage. Returns null if the key is
 * absent, sessionStorage is unavailable, or the stored value is not a
 * string. Never throws. */
export function readDraft(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a draft value to sessionStorage. Never throws. */
export function writeDraft(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage may be unavailable (private mode, quota); ignore.
  }
}

/** Clear a single draft key from sessionStorage. Never throws. */
export function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Clear all draft keys for a given principal. Called on explicit logout
 * or principal change so the prior principal's drafts do not linger in
 * the current tab's sessionStorage. Never throws. */
export function clearPrincipalDrafts(principalId: string): void {
  try {
    const prefix = `mission-draft:${principalId}:`;
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // ignore
  }
}
