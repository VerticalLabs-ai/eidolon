import eventBus from './events.js';

// ---------------------------------------------------------------------------
// In-memory per-artifact presence store (M3)
// ---------------------------------------------------------------------------
//
// Presence is ephemeral realtime state (who is viewing / typing an artifact
// right now), so it lives in memory rather than the database. A REST surface
// (routes/presence.ts) mutates this store and emits `presence.*` events on
// the company WS channel via the EventBus. The UI calls the REST endpoints
// on editor mount/unmount/typing and reacts to the WS events for live
// indicators.
//
// Keyed by artifactId → userId so a user joining twice (e.g. two tabs) is
// not double-counted: the second join refreshes `lastActiveAt` rather than
// creating a second entry. A periodic cleanup evicts stale sessions whose
// heartbeat has lapsed, so a client that closes without an explicit leave
// still disappears within a bounded window.
// ---------------------------------------------------------------------------

export interface PresenceEntry {
  userId: string;
  companyId: string;
  artifactId: string;
  projectId: string | null;
  name: string;
  typing: boolean;
  joinedAt: number;
  lastActiveAt: number;
}

export interface PresenceSnapshot {
  userId: string;
  name: string;
  typing: boolean;
}

/** How long a presence entry survives without a heartbeat/refresh (ms). */
const STALE_TTL_MS = 90_000;
/** How often the stale sweep runs (ms). */
const SWEEP_INTERVAL_MS = 15_000;
/** Inactivity window after which typing auto-clears (ms). */
const TYPING_TIMEOUT_MS = 5_000;

/** artifactId → userId → entry */
const store = new Map<string, Map<string, PresenceEntry>>();
/** userId+artifactId → typing-clear timer */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function key(userId: string, artifactId: string): string {
  return `${userId}:${artifactId}`;
}

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepStale, SWEEP_INTERVAL_MS);
  // Unref so the timer never keeps the process alive on its own.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

function emit(
  type: 'presence.join' | 'presence.leave' | 'presence.typing',
  companyId: string,
  payload: Record<string, unknown>,
): void {
  eventBus.emitEvent({ type, companyId, payload, timestamp: new Date().toISOString() });
}

/** Remove an entry from the store, returning it (or null) so callers can emit. */
function removeEntry(artifactId: string, userId: string): PresenceEntry | null {
  const artifactMap = store.get(artifactId);
  if (!artifactMap) return null;
  const entry = artifactMap.get(userId);
  if (!entry) return null;
  artifactMap.delete(userId);
  if (artifactMap.size === 0) store.delete(artifactId);
  // Clear any pending typing timer for this user+artifact.
  const tk = key(userId, artifactId);
  const timer = typingTimers.get(tk);
  if (timer) {
    clearTimeout(timer);
    typingTimers.delete(tk);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record (or refresh) a user viewing an artifact. Returns true when this is a
 * NEW join (so the caller can emit `presence.join`), false when it is a
 * heartbeat refresh of an existing session.
 */
export function joinPresence(input: {
  userId: string;
  companyId: string;
  artifactId: string;
  projectId: string | null;
  name: string;
}): boolean {
  ensureSweep();
  let artifactMap = store.get(input.artifactId);
  if (!artifactMap) {
    artifactMap = new Map();
    store.set(input.artifactId, artifactMap);
  }
  const existing = artifactMap.get(input.userId);
  const now = Date.now();
  if (existing) {
    // Heartbeat refresh — keep typing state, bump activity.
    existing.lastActiveAt = now;
    existing.projectId = input.projectId;
    existing.name = input.name || existing.name;
    return false;
  }
  const entry: PresenceEntry = {
    userId: input.userId,
    companyId: input.companyId,
    artifactId: input.artifactId,
    projectId: input.projectId,
    name: input.name,
    typing: false,
    joinedAt: now,
    lastActiveAt: now,
  };
  artifactMap.set(input.userId, entry);
  return true;
}

/**
 * Remove a user from an artifact's presence. Returns the removed entry (or
 * null if the user was not present) so the caller can emit `presence.leave`.
 */
export function leavePresence(artifactId: string, userId: string): PresenceEntry | null {
  return removeEntry(artifactId, userId);
}

/**
 * Set or refresh typing state for a user on an artifact. Returns:
 *  - 'started' when typing transitioned from not-typing to typing
 *  - 'continued' when typing was already active (heartbeat refresh)
 *  - 'cleared' when `typing=false` cleared an active typing state
 *  - 'noop' when there was nothing to change (user not present, or already
 *    not-typing)
 */
export function setTyping(
  artifactId: string,
  userId: string,
  typing: boolean,
): 'started' | 'continued' | 'cleared' | 'noop' {
  const artifactMap = store.get(artifactId);
  if (!artifactMap) return 'noop';
  const entry = artifactMap.get(userId);
  if (!entry) return 'noop';

  const tk = key(userId, artifactId);
  entry.lastActiveAt = Date.now();

  if (typing) {
    const wasTyping = entry.typing;
    entry.typing = true;
    // (Re)arm the auto-clear timer.
    const existing = typingTimers.get(tk);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      typingTimers.delete(tk);
      const map = store.get(artifactId);
      const e = map?.get(userId);
      if (e && e.typing) {
        e.typing = false;
        emit('presence.typing', e.companyId, {
          artifactId: e.artifactId,
          userId: e.userId,
          name: e.name,
          typing: false,
        });
      }
    }, TYPING_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    typingTimers.set(tk, timer);
    return wasTyping ? 'continued' : 'started';
  }

  // typing === false
  const wasTyping = entry.typing;
  entry.typing = false;
  const existing = typingTimers.get(tk);
  if (existing) {
    clearTimeout(existing);
    typingTimers.delete(tk);
  }
  return wasTyping ? 'cleared' : 'noop';
}

/** Current presence list for an artifact (excludes the caller when desired). */
export function getArtifactPresence(artifactId: string): PresenceSnapshot[] {
  const artifactMap = store.get(artifactId);
  if (!artifactMap) return [];
  return Array.from(artifactMap.values()).map((e) => ({
    userId: e.userId,
    name: e.name,
    typing: e.typing,
  }));
}

/**
 * Aggregated presence across all artifacts in a project (for VAL-CROSS-014).
 * Returns one entry per distinct user currently viewing any artifact in the
 * project, with the set of artifactIds they are viewing.
 */
export interface ProjectPresenceEntry {
  userId: string;
  name: string;
  artifactIds: string[];
  typing: boolean;
}

export function getProjectPresence(
  companyId: string,
  projectId: string,
): ProjectPresenceEntry[] {
  const byUser = new Map<string, ProjectPresenceEntry>();
  for (const artifactMap of store.values()) {
    for (const entry of artifactMap.values()) {
      if (entry.companyId !== companyId) continue;
      if (entry.projectId !== projectId) continue;
      const existing = byUser.get(entry.userId);
      if (existing) {
        if (!existing.artifactIds.includes(entry.artifactId)) {
          existing.artifactIds.push(entry.artifactId);
        }
        existing.typing = existing.typing || entry.typing;
      } else {
        byUser.set(entry.userId, {
          userId: entry.userId,
          name: entry.name,
          artifactIds: [entry.artifactId],
          typing: entry.typing,
        });
      }
    }
  }
  return Array.from(byUser.values());
}

/** Remove all presence for a company (used when a company is deleted). */
export function clearCompanyPresence(companyId: string): number {
  let removed = 0;
  for (const [artifactId, artifactMap] of store) {
    for (const entry of Array.from(artifactMap.values())) {
      if (entry.companyId === companyId) {
        removeEntry(artifactId, entry.userId);
        removed++;
      }
    }
  }
  return removed;
}

/** Evict sessions whose heartbeat has lapsed. Emits leave events for them. */
function sweepStale(): void {
  const now = Date.now();
  for (const [artifactId, artifactMap] of store) {
    for (const entry of Array.from(artifactMap.values())) {
      if (now - entry.lastActiveAt > STALE_TTL_MS) {
        const removed = removeEntry(artifactId, entry.userId);
        if (removed) {
          emit('presence.leave', removed.companyId, {
            artifactId: removed.artifactId,
            userId: removed.userId,
            name: removed.name,
          });
        }
      }
    }
  }
}

/** Test helper: reset the store entirely (called between tests). */
export function __resetPresenceStore(): void {
  store.clear();
  for (const timer of typingTimers.values()) clearTimeout(timer);
  typingTimers.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
