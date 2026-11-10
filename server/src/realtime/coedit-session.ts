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
 *
 * Persistence invariants:
 *   - A session is live while it has participants or unsaved changes. It is
 *     removed only once it has neither, so an edit the server acknowledged is
 *     never dropped with the session that holds it.
 *   - Every write a live session makes (explicit save, final flush on leave,
 *     agent update) runs through one per-artifact queue, so each write reads
 *     the version the previous one produced.
 */

import type { WebSocket } from 'ws';
import { getArtifact, saveArtifactContent } from '../services/artifact-service.js';
import {
  validateArtifactContent,
  applyOp,
  applyOps,
  diffContent,
  isCoEditableType,
} from '@eidolon/shared';
import type { CoEditOp, DocOp, SheetOp, BoardOp, CoEditServerMsg } from '@eidolon/shared';
import { colorForUser } from '@eidolon/shared';
import type { DbInstance } from '../types.js';
import { AppError } from '../middleware/error-handler.js';
import logger from '../utils/logger.js';

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
      [
        'test-user',
        {
          ws: {
            readyState: 1,
            OPEN: 1,
            send: () => {},
            close: () => {},
            on: () => {},
            off: () => {},
          } as unknown as WebSocket,
          userId: 'test-user',
          name: 'Tester',
          color: '#fff',
        },
      ],
    ]),
    dirty: false,
  });
}

/**
 * A session is live while someone is connected to it or it holds changes that
 * have not reached the database. The second case covers the final flush after
 * the last participant leaves, and a session kept because that flush failed.
 */
function isLive(session: CoEditSession): boolean {
  return session.participants.size > 0 || session.dirty;
}

/** Remove a session that has no participants and nothing left to save. */
function disposeIfIdle(session: CoEditSession): void {
  if (!isLive(session) && sessions.get(session.artifactId) === session) {
    sessions.delete(session.artifactId);
  }
}

/** Check if a live co-edit session exists for an artifact. */
export function hasSession(artifactId: string): boolean {
  const session = sessions.get(artifactId);
  return session !== undefined && isLive(session);
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
  if (!session || !isLive(session)) {
    return null;
  }
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
 * Returns the merged content, or null if no live session (caller should
 * use the normal PATCH path).
 */
function mergeExternalUpdate(
  artifactId: string,
  incomingContent: Record<string, unknown>,
  editor: {
    userId?: string | null;
    agentId?: string | null;
    editSource?: 'user' | 'agent' | 'system';
  },
): { merged: Record<string, unknown>; ops: CoEditOp[] } | null {
  const session = sessions.get(artifactId);
  if (!session || !isLive(session)) {
    return null;
  }

  const base = session.lastSavedContent;
  const current = session.content;
  const incoming = incomingContent;

  // Guard: if the artifact type does not support op-based co-editing
  // (gallery, dashboard, app, slide_deck, timeline, code), diffContent
  // would produce empty ops and the content change would be silently
  // discarded while the version increments. Fall back to last-write-wins:
  // take the incoming content directly as the merged result.
  if (!isCoEditableType(session.artifactType)) {
    const validation = validateArtifactContent(session.artifactType as any, incoming);
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
  const validation = validateArtifactContent(session.artifactType as any, merged);
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
async function flushSession(
  artifactId: string,
  editor: {
    userId?: string | null;
    agentId?: string | null;
    editSource?: 'user' | 'agent' | 'system';
  },
  title?: string,
): Promise<{ version: number; content: Record<string, unknown> } | null> {
  if (!_db) {
    throw new Error('CoEdit manager not initialized');
  }
  const session = sessions.get(artifactId);
  if (!session) {
    return null;
  }

  if (!session.dirty && title === undefined) {
    return { version: session.version, content: session.content };
  }

  const contentToSave = session.content;

  // Use saveArtifactContent (direct DB save) to bypass the co-edit session
  // check in updateArtifact (avoids recursion). Pass the title so it is
  // persisted in the same transaction as the content.
  const updated = await saveArtifactContent(
    _db,
    session.companyId,
    artifactId,
    contentToSave,
    session.version,
    editor,
    undefined,
    title,
  );

  session.version = updated.version;
  session.lastSavedContent = JSON.parse(JSON.stringify(contentToSave));
  session.dirty = session.content !== contentToSave;

  // Broadcast saved to all participants (include the persisted title so
  // clients can update their cache without a refetch).
  broadcast(session, {
    type: 'coedit.saved',
    artifactId,
    version: updated.version,
    content: contentToSave,
    title: updated.title,
  });

  return { version: updated.version, content: contentToSave };
}

// ---------------------------------------------------------------------------
// Per-session write serialization
//
// Every write a session makes reads `session.version` and then waits on the
// database. Two writes that overlap both read the same version, so the second
// fails its optimistic version check with a spurious 409 — and when that
// second write is the final flush on leave, the edits it carried are gone
// with the session. Writes are therefore queued per artifact: each waits for
// the previous one to finish (and update `session.version`) before it reads
// the session. Independent artifacts still write in parallel.
// ---------------------------------------------------------------------------

const writeQueues = new Map<string, Promise<void>>();

/**
 * Run `write` after every write already queued for the artifact. The returned
 * promise settles with the outcome of `write`; a failure does not break the
 * queue, so the next write still runs and re-reads the session.
 */
function serializeSessionWrite<T>(artifactId: string, write: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(artifactId) ?? Promise.resolve();
  const next = previous.then(write);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(artifactId, settled);
  // Drop the queue entry once it is idle to avoid unbounded growth.
  void settled.then(() => {
    if (writeQueues.get(artifactId) === settled) {
      writeQueues.delete(artifactId);
    }
  });
  return next;
}

/** Flush the session behind any write already in flight for the artifact. */
export function flushSessionSerialized(
  artifactId: string,
  editor: {
    userId?: string | null;
    agentId?: string | null;
    editSource?: 'user' | 'agent' | 'system';
  },
  title?: string,
): Promise<{ version: number; content: Record<string, unknown> } | null> {
  return serializeSessionWrite(artifactId, () => flushSession(artifactId, editor, title));
}

/**
 * Persist an external content change (agent PATCH) through a live session.
 *
 * The change is merged into the session and written by `save` as one queued
 * step, so it cannot overlap a save or final flush for the same artifact.
 * `save` receives the merged content and returns the stored artifact.
 *
 * Resolves to null when no live session exists by the time the step runs; the
 * caller then uses the normal PATCH path.
 */
export function persistExternalUpdate<T extends { version: number; title?: string }>(
  artifactId: string,
  incomingContent: Record<string, unknown>,
  editor: {
    userId?: string | null;
    agentId?: string | null;
    editSource?: 'user' | 'agent' | 'system';
  },
  save: (merged: Record<string, unknown>) => Promise<T>,
): Promise<T | null> {
  return serializeSessionWrite(artifactId, async () => {
    const result = mergeExternalUpdate(artifactId, incomingContent, editor);
    if (!result) {
      return null;
    }
    const updated = await save(result.merged);
    updateSessionAfterFlush(artifactId, updated.version, result.merged, updated.title);
    return updated;
  });
}

/**
 * Record a write made on the session's behalf by `persistExternalUpdate`, so
 * the next write uses the right expected version, and tell participants.
 */
function updateSessionAfterFlush(
  artifactId: string,
  newVersion: number,
  content: Record<string, unknown>,
  title?: string,
): void {
  const session = sessions.get(artifactId);
  if (!session) {
    return;
  }
  session.version = newVersion;
  session.lastSavedContent = JSON.parse(JSON.stringify(content));
  // An operation applied while the write was in flight replaced
  // `session.content`; it is not in what was written and still needs a flush.
  session.dirty = session.content !== content;
  // Broadcast saved to all participants
  broadcast(session, {
    type: 'coedit.saved',
    artifactId,
    version: newVersion,
    content,
    title,
  });
  // A session kept only for its unsaved changes has now handed them off.
  disposeIfIdle(session);
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
  if (!_db) {
    throw new Error('CoEdit manager not initialized');
  }

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
 * `coedit.user.left` to remaining clients.
 *
 * When the last participant leaves, unsaved changes are flushed behind any
 * write already in flight, and the session is removed only if it is then
 * still empty and fully saved. It is kept when someone joined during the
 * flush, and when the flush failed: the unsaved content stays in memory, where
 * the next join, save or agent update picks it up. The one failure that does
 * not keep it is a permanently deleted artifact.
 *
 * Never rejects — a failed final flush is logged, not thrown.
 */
export async function leaveSession(artifactId: string, userId: string): Promise<void> {
  const session = sessions.get(artifactId);
  if (!session) {
    return;
  }

  session.participants.delete(userId);

  // Broadcast user left to remaining participants
  broadcast(session, {
    type: 'coedit.user.left',
    artifactId,
    userId,
  });

  if (session.participants.size > 0) {
    return;
  }

  try {
    // Queued even when the session looks clean: a save still in flight may
    // leave it dirty, and it must finish before the session can be removed.
    await flushSessionSerialized(artifactId, { editSource: 'system' });
  } catch (err) {
    if (err instanceof AppError && err.code === 'ARTIFACT_NOT_FOUND') {
      // Permanently deleted while it was open: there is nothing to save into.
      session.dirty = false;
    } else {
      logger.error(
        { err, artifactId, companyId: session.companyId },
        'Co-edit final flush failed; unsaved changes are kept in memory',
      );
    }
  }
  disposeIfIdle(session);
}

/** Remove a participant by WS connection (on disconnect). */
export async function leaveSessionByWs(artifactId: string, ws: WebSocket): Promise<void> {
  const session = sessions.get(artifactId);
  if (!session) {
    return;
  }
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
export function applyOperation(artifactId: string, op: CoEditOp, userId: string): void {
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
 *
 * Authorization: only session participants may broadcast cursor updates.
 * Without this check, any WS client that knows the artifactId could inject
 * cursor events into an active session (same auth gap class as the
 * `applyOperation` fix). Non-participants are rejected with an error that
 * the WS server surfaces to the sender.
 */
export function broadcastCursor(
  artifactId: string,
  userId: string,
  name: string,
  color: string,
  position: number | { rowId: string; colKey: string } | { cardId: string } | null,
): void {
  const session = sessions.get(artifactId);
  if (!session) {
    return;
  }
  if (!session.participants.has(userId)) {
    throw new Error('Not a participant in this co-edit session');
  }
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
 *
 * Authorization: only session participants may broadcast selection updates
 * (same guard as `broadcastCursor`).
 */
export function broadcastSelection(
  artifactId: string,
  userId: string,
  name: string,
  color: string,
  range: { start: number; end: number } | null,
): void {
  const session = sessions.get(artifactId);
  if (!session) {
    return;
  }
  if (!session.participants.has(userId)) {
    throw new Error('Not a participant in this co-edit session');
  }
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
