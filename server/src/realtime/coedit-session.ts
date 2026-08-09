/**
 * Co-editing session manager (M3).
 *
 * Server-authoritative, operation-based co-editing for Docs/Sheets/Boards.
 * Each artifact with at least one connected client has an in-memory
 * `CoEditSession` that holds the canonical content. Clients send granular
 * operations over WS; the session applies them in arrival order
 * (deterministic), broadcasts to all participants, and flushes to DB on
 * save as a single versioned revision.
 *
 * This supersedes the M1 LWW 409 for live co-editors — operations merge
 * instead of rejecting. The 409 path in `artifact-service.ts` remains for
 * stale single-client writes (no active session).
 */

import type { WebSocket } from 'ws';
import { getArtifact, saveArtifactContent } from '../services/artifact-service.js';
import { validateArtifactContent, applyOp, applyOps, diffContent, isCoEditableType } from '@eidolon/shared';
import type {
  CoEditOp,
  DocOp,
  SheetOp,
  BoardOp,
  CoEditServerMsg,
} from '@eidolon/shared';
import { colorForUser } from '@eidolon/shared';
import type { DbInstance } from '../types.js';
import { AppError } from '../middleware/error-handler.js';
import { backgroundWork } from '../services/background-work.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionParticipant {
  ws: WebSocket;
  userId: string;
  name: string;
  color: string;
}

interface CoEditSession {
  artifactId: string;
  companyId: string;
  /** Canonical merged content (type-specific JSON). */
  content: Record<string, unknown>;
  /** Artifact type (document | sheet | board). */
  artifactType: string;
  /** Current DB version (last flushed). */
  version: number;
  /** Content snapshot at the last save flush (for three-way merge on agent PATCH). */
  lastSavedContent: Record<string, unknown>;
  /** Connected participants keyed by userId. */
  participants: Map<string, SessionParticipant>;
  /** Whether the session has unsaved changes (ops applied since last flush). */
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// Singleton manager
// ---------------------------------------------------------------------------

let _db: DbInstance | null = null;
const sessions = new Map<string, CoEditSession>();

/** Initialize the manager with a DB instance (called during app startup). */
export function initCoEditManager(db: DbInstance): void {
  _db = db;
}

/** Test helper: reset all sessions. */
export function __resetCoEditSessions(): void {
  sessions.clear();
}

/**
 * Test helper: inject a session for an artifact, bypassing the
 * `isCoEditableType` guard in `joinSession`. Used to test the
 * `mergeExternalUpdate` last-write-wins fallback for non-co-editable types
 * (gallery/dashboard/app) when a session somehow exists.
 */
export function __injectSessionForTest(
  artifactId: string,
  companyId: string,
  artifactType: string,
  content: Record<string, unknown>,
  version: number,
): void {
  sessions.set(artifactId, {
    artifactId,
    companyId,
    content: JSON.parse(JSON.stringify(content)),
    artifactType,
    version,
    lastSavedContent: JSON.parse(JSON.stringify(content)),
    participants: new Map([
      ['test-user', { ws: { readyState: 1, OPEN: 1, send: () => {}, close: () => {}, on: () => {}, off: () => {} } as unknown as WebSocket, userId: 'test-user', name: 'Tester', color: '#fff' }],
    ]),
    dirty: false,
  });
}

/** Check if an active co-edit session exists for an artifact. */
export function hasSession(artifactId: string): boolean {
  return sessions.has(artifactId) && sessions.get(artifactId)!.participants.size > 0;
}

/**
 * Get the current session content for an artifact (or null if no session).
 * Used by `updateArtifact` to route agent PATCHes through the session.
 */
export function getSessionContent(artifactId: string): {
  content: Record<string, unknown>;
  version: number;
  artifactType: string;
  lastSavedContent: Record<string, unknown>;
} | null {
  const session = sessions.get(artifactId);
  if (!session || session.participants.size === 0) return null;
  return {
    content: session.content,
    version: session.version,
    artifactType: session.artifactType,
    lastSavedContent: session.lastSavedContent,
  };
}

/**
 * Apply external content change (agent PATCH) through an active session.
 * Performs a three-way merge: base = lastSavedContent, local = incoming
 * agent content, remote = current session content. The merged result
 * preserves both the agent's changes and any in-progress user edits.
 *
 * Returns the merged content, or null if no active session (caller should
 * use the normal PATCH path).
 */
export function mergeExternalUpdate(
  artifactId: string,
  incomingContent: Record<string, unknown>,
  editor: { userId?: string | null; agentId?: string | null; editSource?: 'user' | 'agent' | 'system' },
): { merged: Record<string, unknown>; ops: CoEditOp[] } | null {
  const session = sessions.get(artifactId);
  if (!session || session.participants.size === 0) return null;

  const base = session.lastSavedContent;
  const current = session.content;
  const incoming = incomingContent;

  // Guard: if the artifact type does not support op-based co-editing
  // (gallery, dashboard, app, slide_deck, timeline, code), diffContent
  // would produce empty ops and the content change would be silently
  // discarded while the version increments. Fall back to last-write-wins:
  // take the incoming content directly as the merged result.
  if (!isCoEditableType(session.artifactType)) {
    const validation = validateArtifactContent(
      session.artifactType as any,
      incoming,
    );
    if (!validation.success) {
      throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', 'Merged content is invalid');
    }
    session.content = JSON.parse(JSON.stringify(incoming));
    session.dirty = true;
    return { merged: session.content, ops: [] };
  }

  // Compute ops: diff(base, incoming) → agent's changes
  const agentOps = diffContent(session.artifactType, base, incoming);
  // Apply agent ops on top of current session state (which has user edits)
  const merged = applyOps(session.artifactType, current, agentOps);

  // Validate merged content
  const validation = validateArtifactContent(
    session.artifactType as any,
    merged,
  );
  if (!validation.success) {
    throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', 'Merged content is invalid');
  }

  session.content = merged;
  session.dirty = true;

  // Broadcast agent ops to all participants
  for (const op of agentOps) {
    broadcast(session, {
      type: 'coedit.op.broadcast',
      artifactId,
      op,
      userId: editor.agentId ?? editor.userId ?? 'agent',
    });
  }

  return { merged, ops: agentOps };
}

/**
 * Flush the session content to the DB as a new versioned revision.
 * Called on explicit save or on last-participant-leave.
 */
export async function flushSession(
  artifactId: string,
  editor: { userId?: string | null; agentId?: string | null; editSource?: 'user' | 'agent' | 'system' },
  title?: string,
): Promise<{ version: number; content: Record<string, unknown> } | null> {
  if (!_db) throw new Error('CoEdit manager not initialized');
  const session = sessions.get(artifactId);
  if (!session) return null;

  if (!session.dirty && title === undefined) {
    return { version: session.version, content: session.content };
  }

  // Use saveArtifactContent (direct DB save) to bypass the co-edit session
  // check in updateArtifact (avoids recursion). Pass the title so it is
  // persisted in the same transaction as the content.
  const updated = await saveArtifactContent(
    _db,
    session.companyId,
    artifactId,
    session.content,
    session.version,
    editor,
    undefined,
    title,
  );

  session.version = updated.version;
  session.lastSavedContent = JSON.parse(JSON.stringify(session.content));
  session.dirty = false;

  // Broadcast saved to all participants (include the persisted title so
  // clients can update their cache without a refetch).
  broadcast(session, {
    type: 'coedit.saved',
    artifactId,
    version: updated.version,
    content: session.content,
    title: updated.title,
  });

  return { version: updated.version, content: session.content };
}

// ---------------------------------------------------------------------------
// Per-session save serialization
//
// Two rapid coedit.save messages could race on session.version: both read
// the same version, the first save bumps it, and the second save's
// optimistic version check fails with a spurious 409. Serialize saves per
// session so each flush waits for the previous one to complete (and update
// session.version) before reading the session state and calling
// saveArtifactContent. The queue is per-artifact so independent artifacts
// save in parallel.
// ---------------------------------------------------------------------------

const flushQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize a flush behind any in-flight flush for the same artifact.
 * Returns a promise that resolves once this flush completes. Errors do not
 * break the chain — a failed flush still allows the next save to proceed
 * (it will re-read session.version and retry).
 */
export function flushSessionSerialized(
  artifactId: string,
  editor: { userId?: string | null; agentId?: string | null; editSource?: 'user' | 'agent' | 'system' },
  title?: string,
): Promise<{ version: number; content: Record<string, unknown> } | null> {
  const prev = flushQueues.get(artifactId) ?? Promise.resolve();
  const next = prev.then(
    () => flushSession(artifactId, editor, title),
    // If the previous flush failed, proceed anyway — the next flush will
    // re-read session.version and retry with the current state.
    () => flushSession(artifactId, editor, title),
  );
  // Keep the queue chain clean: don't let errors break subsequent saves.
  const settled = next.then(undefined, () => null);
  flushQueues.set(artifactId, settled);
  // Clean up the queue entry once settled to avoid unbounded growth.
  void settled.finally(() => {
    if (flushQueues.get(artifactId) === settled) {
      flushQueues.delete(artifactId);
    }
  });
  return next;
}

/**
 * Update session metadata after a flush that was performed externally
 * (e.g. by updateArtifact routing through the session). Keeps the session's
 * version + lastSavedContent in sync so subsequent flushes use the correct
 * expected version.
 */
export function updateSessionAfterFlush(
  artifactId: string,
  newVersion: number,
  content: Record<string, unknown>,
  title?: string,
): void {
  const session = sessions.get(artifactId);
  if (!session) return;
  session.version = newVersion;
  session.lastSavedContent = JSON.parse(JSON.stringify(content));
  session.dirty = false;
  // Broadcast saved to all participants
  broadcast(session, {
    type: 'coedit.saved',
    artifactId,
    version: newVersion,
    content,
    title,
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle (called from WS server)
// ---------------------------------------------------------------------------

/**
 * Join a co-edit session. Creates the session if it doesn't exist (loading
 * the artifact from DB). Sends the current state back to the joining client.
 */
export async function joinSession(
  artifactId: string,
  companyId: string,
  userId: string,
  name: string,
  ws: WebSocket,
): Promise<void> {
  if (!_db) throw new Error('CoEdit manager not initialized');

  let session = sessions.get(artifactId);
  if (!session) {
    // Load artifact from DB to initialize the session
    const artifact = await getArtifact(_db, companyId, artifactId);
    // Guard: refuse to create a co-edit session for non-co-editable types.
    // M5 types (gallery, dashboard, app) and other non-listed types do not
    // have granular op handlers; a session would cause content changes to
    // be silently discarded by mergeExternalUpdate's empty-op diff. They
    // save via the standard LWW REST PATCH path instead.
    if (!isCoEditableType(artifact.type)) {
      sendTo(ws, {
        type: 'coedit.error',
        artifactId,
        message: `Artifact type "${artifact.type}" does not support co-editing`,
      });
      return;
    }
    session = {
      artifactId,
      companyId,
      content: JSON.parse(JSON.stringify(artifact.content)),
      artifactType: artifact.type,
      version: artifact.version,
      lastSavedContent: JSON.parse(JSON.stringify(artifact.content)),
      participants: new Map(),
      dirty: false,
    };
    sessions.set(artifactId, session);
  }

  const color = colorForUser(userId);
  session.participants.set(userId, { ws, userId, name, color });

  // Send joined message with current state
  const participants = Array.from(session.participants.values())
    .filter((p) => p.userId !== userId)
    .map((p) => ({ userId: p.userId, name: p.name, color: p.color }));

  sendTo(ws, {
    type: 'coedit.joined',
    artifactId,
    content: session.content,
    version: session.version,
    participants,
  });
}

/**
 * Leave a co-edit session. Removes the participant and broadcasts
 * `coedit.user.left` to remaining clients. If the last participant leaves,
 * flushes any dirty state and destroys the session.
 */
export async function leaveSession(
  artifactId: string,
  userId: string,
): Promise<void> {
  const session = sessions.get(artifactId);
  if (!session) return;

  session.participants.delete(userId);

  // Broadcast user left to remaining participants
  broadcast(session, {
    type: 'coedit.user.left',
    artifactId,
    userId,
  });

  // If no participants remain, flush and destroy
  if (session.participants.size === 0) {
    if (session.dirty) {
      try {
        await flushSession(artifactId, { editSource: 'system' });
      } catch {
        // Best-effort flush on leave; don't crash
      }
    }
    sessions.delete(artifactId);
  }
}

/** Remove a participant by WS connection (on disconnect). */
export async function leaveSessionByWs(
  artifactId: string,
  ws: WebSocket,
): Promise<void> {
  const session = sessions.get(artifactId);
  if (!session) return;
  for (const [userId, participant] of session.participants) {
    if (participant.ws === ws) {
      await leaveSession(artifactId, userId);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Operation handling
// ---------------------------------------------------------------------------

/**
 * Apply an operation from a client. The op is applied to the canonical
 * session state, acknowledged to the sender, and broadcast to all other
 * participants.
 */
export function applyOperation(
  artifactId: string,
  op: CoEditOp,
  userId: string,
): void {
  const session = sessions.get(artifactId);
  if (!session) {
    throw new Error('No active co-edit session for artifact ' + artifactId);
  }

  // Authorization: only session participants may apply operations. Without
  // this check, any WS client that knows the artifactId could inject ops
  // into an active session.
  if (!session.participants.has(userId)) {
    throw new Error('Not a participant in this co-edit session');
  }

  // Apply the op to the canonical state
  session.content = applyOp(session.artifactType, session.content, op);
  session.dirty = true;

  // Ack to sender
  const sender = session.participants.get(userId);
  if (sender) {
    sendTo(sender.ws, {
      type: 'coedit.op.ack',
      artifactId,
      opId: op.opId,
      version: session.version,
    });
  }

  // Broadcast to all OTHER participants
  for (const [pid, participant] of session.participants) {
    if (pid !== userId) {
      sendTo(participant.ws, {
        type: 'coedit.op.broadcast',
        artifactId,
        op,
        userId,
      });
    }
  }
}

/**
 * Broadcast a cursor update to all other participants.
 */
export function broadcastCursor(
  artifactId: string,
  userId: string,
  name: string,
  color: string,
  position: number | { rowId: string; colKey: string } | { cardId: string } | null,
): void {
  const session = sessions.get(artifactId);
  if (!session) return;
  for (const [pid, participant] of session.participants) {
    if (pid !== userId) {
      sendTo(participant.ws, {
        type: 'coedit.cursor.broadcast',
        artifactId,
        userId,
        name,
        color,
        position,
      });
    }
  }
}

/**
 * Broadcast a selection update to all other participants.
 */
export function broadcastSelection(
  artifactId: string,
  userId: string,
  name: string,
  color: string,
  range: { start: number; end: number } | null,
): void {
  const session = sessions.get(artifactId);
  if (!session) return;
  for (const [pid, participant] of session.participants) {
    if (pid !== userId) {
      sendTo(participant.ws, {
        type: 'coedit.selection.broadcast',
        artifactId,
        userId,
        name,
        color,
        range,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendTo(ws: WebSocket, msg: CoEditServerMsg): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(session: CoEditSession, msg: CoEditServerMsg): void {
  for (const participant of session.participants.values()) {
    sendTo(participant.ws, msg);
  }
}
