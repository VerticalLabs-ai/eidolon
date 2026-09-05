/**
 * Principal-scoped Mission draft storage with a bounded lifetime.
 *
 * Every Mission request, question, revision, rejection, and cancellation
 * draft key includes the authenticated principal plus company/project/
 * thread/run/card version and is stored per tab in `sessionStorage`.
 *
 * Drafts survive same-profile reload/navigation for at most 24 hours and
 * are cleared on submit, supersession, terminalization, logout, scope
 * change, explicit discard, or expiry (VAL-CROSS-084). Expiry is enforced
 * on read: an entry older than `DRAFT_TTL_MS` is removed and treated as
 * absent so a stale draft never becomes authority.
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
 * (VAL-MODEQ-121, VAL-MODEQ-149, VAL-CROSS-084)
 */

/** Maximum draft lifetime: 24 hours in milliseconds. A draft older than
 * this is removed on read and never returned to a caller. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Internal stored envelope: the draft value plus the wall-clock time it
 * was written so `readDraft` can enforce the 24-hour TTL. */
interface DraftEnvelope {
  v: string;
  t: number;
}

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

/** Read a draft value from sessionStorage, enforcing the 24-hour TTL.
 *
 * Returns the stored value if present and not expired, otherwise null.
 * An expired entry is removed so it cannot be read again. Legacy plain
 * strings (written before the envelope format) are returned as-is so an
 * in-flight upgrade does not drop drafts, but never re-written without an
 * envelope. Never throws. */
export function readDraft(key: string): string | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  // Envelope format: { v, t }. Fall back to legacy plain-string values so
  // an upgrade in the same tab does not lose drafts mid-session.
  try {
    const parsed = JSON.parse(raw) as Partial<DraftEnvelope>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.t === 'number' &&
      typeof parsed.v === 'string'
    ) {
      if (Date.now() - parsed.t > DRAFT_TTL_MS) {
        // Expired: remove and treat as absent (VAL-CROSS-084 expiry).
        clearDraft(key);
        return null;
      }
      return parsed.v;
    }
  } catch {
    // Not JSON — fall through to legacy handling.
  }
  // Legacy plain string: keep but do not refresh its timestamp. It will
  // be overwritten with an envelope on the next write. Treat as fresh so
  // an in-flight upgrade does not drop a draft written this session.
  return raw;
}

/** Write a draft value to sessionStorage with the current wall-clock time
 * so the 24-hour TTL can be enforced on read. Never throws. */
export function writeDraft(key: string, value: string): void {
  const envelope: DraftEnvelope = { v: value, t: Date.now() };
  try {
    sessionStorage.setItem(key, JSON.stringify(envelope));
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

/** Clear all run-scoped drafts for a given run identity. Used on
 * terminalization so question-answer, plan-revision, plan-rejection, and
 * cancel-reason drafts for a finished/cancelled/failed run do not linger
 * past the run's lifetime (VAL-CROSS-084 terminalization). Never throws. */
export function clearRunDrafts(params: {
  principalId: string;
  companyId: string;
  projectId: string;
  runId: string;
}): void {
  const { principalId, companyId, projectId, runId } = params;
  // Run-scoped drafts carry the runId as a `:`-separated segment after the
  // project segment. Match any key whose principal/company/project prefix
  // matches and which contains the runId as an exact segment.
  const prefix = `mission-draft:${principalId}:`;
  const scopePrefix = `:${companyId}:${projectId}:`;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(prefix)) {
        continue;
      }
      if (key.indexOf(scopePrefix) === -1) {
        continue;
      }
      const segments = key.split(':');
      if (segments.includes(runId)) {
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
