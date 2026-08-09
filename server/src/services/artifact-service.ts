import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { ArtifactTypeSchema, validateArtifactContent } from '@eidolon/shared';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import { hasSession, mergeExternalUpdate, updateSessionAfterFlush } from '../realtime/coedit-session.js';
import { validateFolderOwnership } from './folder-service.js';
import { encryptContent, decryptContent } from './content-encryption.js';
import type { DbInstance } from '../types.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import type { z } from 'zod';

type ArtifactType = z.infer<typeof ArtifactTypeSchema>;
type Editor = { userId?: string | null; agentId?: string | null; editSource?: 'user' | 'agent' | 'system' };

type ArtifactRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  folderId: string | null;
  type: ArtifactType;
  title: string;
  content: Record<string, unknown>;
  contentSchemaVersion: number;
  status: 'active' | 'archived' | 'deleted';
  createdByUserId: string | null;
  createdByAgentId: string | null;
  lastEditedByUserId: string | null;
  lastEditedByAgentId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type RevisionRow = {
  id: string;
  artifactId: string;
  version: number;
  content: Record<string, unknown>;
  editedByUserId: string | null;
  editedByAgentId: string | null;
  editSource: 'user' | 'agent' | 'system';
  message: string | null;
  createdAt: Date;
};

function assertContent(type: ArtifactType, content: unknown): void {
  const result = validateArtifactContent(type, content);
  if (!result.success) throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', 'Content does not match the artifact type', result.error.flatten());
}

/** Decrypt the content envelope on an artifact row (returns a new object). */
function decryptArtifact(row: ArtifactRow): ArtifactRow {
  return { ...row, content: decryptContent(row.content) };
}

/** Decrypt the content envelope on a revision row (returns a new object). */
function decryptRevision(row: RevisionRow): RevisionRow {
  return { ...row, content: decryptContent(row.content) };
}

/** Build an actor descriptor for audit-attributed event payloads. */
function actorFromEditor(editor: Editor): { type: 'user' | 'agent' | 'system'; id: string } {
  if (editor.editSource === 'agent' && editor.agentId) return { type: 'agent', id: editor.agentId };
  if (editor.userId) return { type: 'user', id: editor.userId };
  return { type: 'system', id: 'system' };
}

function emit(type: 'artifact.created' | 'artifact.updated' | 'artifact.revision.created' | 'artifact.deleted' | 'artifact.archived', companyId: string, artifact: unknown, editor?: Editor) {
  // Broadcast decrypted content over the WS bus so realtime clients receive
  // readable content (the stored row carries the encryption envelope).
  const a = artifact as Record<string, unknown> | undefined;
  const safeArtifact = a && typeof a === 'object' && 'content' in a && a.content !== undefined
    ? { ...a, content: decryptContent(a.content as Record<string, unknown>) }
    : a;
  eventBus.emitEvent({
    type, companyId,
    payload: editor ? { artifact: safeArtifact, actor: actorFromEditor(editor) } : { artifact: safeArtifact },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Direct DB save: writes content + revision row without the co-edit session
 * check or optimistic version check. Used by `flushSession` to persist the
 * co-edit session's merged content. The caller is responsible for ensuring
 * the content is valid and the version is correct.
 */
export async function saveArtifactContent(
  db: DbInstance,
  companyId: string,
  id: string,
  content: Record<string, unknown>,
  expectedVersion: number,
  editor: Editor,
  message?: string,
  title?: string,
) {
  const current = await getArtifact(db, companyId, id);
  assertContent(current.type, content);
  const encryptedContent = encryptContent(content);
  const updated = await db.drizzle.transaction(async (tx) => {
    const [row] = await tx.update(db.schema.artifacts).set({
      content: encryptedContent,
      ...(title !== undefined ? { title } : {}),
      version: current.version + 1,
      updatedAt: new Date(),
      lastEditedByUserId: editor.userId ?? null,
      lastEditedByAgentId: editor.agentId ?? null,
    }).where(and(
      eq(db.schema.artifacts.id, id),
      eq(db.schema.artifacts.companyId, companyId),
      eq(db.schema.artifacts.version, expectedVersion),
    )).returning();
    if (!row) {
      throw new AppError(409, 'ARTIFACT_VERSION_CONFLICT', 'Artifact was updated by another client', { current: await getArtifact(db, companyId, id) });
    }
    await tx.insert(db.schema.artifactRevisions).values({
      artifactId: id, version: row.version, content: encryptedContent,
      editedByUserId: editor.userId ?? null, editedByAgentId: editor.agentId ?? null,
      editSource: editor.editSource ?? 'user', message: message ?? null,
    });
    return row;
  });
  emit('artifact.updated', companyId, updated, editor);
  emit('artifact.revision.created', companyId, { artifactId: id, version: updated.version, editSource: editor.editSource ?? 'user', actor: actorFromEditor(editor) });
  return decryptArtifact(updated);
}

export async function createArtifact(db: DbInstance, companyId: string, input: {
  type: ArtifactType; title: string; content: unknown; projectId?: string | null; folderId?: string | null;
}, editor: Editor) {
  assertContent(input.type, input.content);
  const project = await validateProjectOwnership(db, companyId, input.projectId);
  if (project) {
    const [projectRow] = await db.drizzle.select({ status: db.schema.projects.status }).from(db.schema.projects)
      .where(and(eq(db.schema.projects.id, project.id), eq(db.schema.projects.companyId, companyId)));
    if (projectRow?.status === 'archived') throw new AppError(409, 'PROJECT_ARCHIVED', 'Archived projects cannot receive new artifacts');
  }
  // Validate folder ownership (folder must belong to companyId) and scope match.
  if (input.folderId) {
    const folder = await validateFolderOwnership(db, companyId, input.folderId);
    if (folder) {
      const folderProject = folder.projectId ?? null;
      const artifactProject = input.projectId ?? null;
      if (folderProject !== artifactProject) {
        throw new AppError(400, 'FOLDER_SCOPE_MISMATCH', 'Artifact and folder must share the same project scope');
      }
    }
  }
  const { artifacts, artifactRevisions } = db.schema;
  const encryptedContent = encryptContent(input.content as Record<string, unknown>);
  const created = await db.drizzle.transaction(async (tx) => {
    const [artifact] = await tx.insert(artifacts).values({
      companyId, projectId: input.projectId ?? null, folderId: input.folderId ?? null,
      type: input.type, title: input.title, content: encryptedContent,
      createdByUserId: editor.userId ?? null, createdByAgentId: editor.agentId ?? null,
      lastEditedByUserId: editor.userId ?? null, lastEditedByAgentId: editor.agentId ?? null,
    }).returning();
    await tx.insert(artifactRevisions).values({
      artifactId: artifact.id, version: 1, content: encryptedContent,
      editedByUserId: editor.userId ?? null, editedByAgentId: editor.agentId ?? null,
      editSource: editor.editSource ?? 'user',
    });
    return artifact;
  });
  emit('artifact.created', companyId, created, editor);
  emit('artifact.revision.created', companyId, { artifactId: created.id, version: 1, editSource: editor.editSource ?? 'user', actor: actorFromEditor(editor) });
  return decryptArtifact(created);
}

export async function getArtifact(db: DbInstance, companyId: string, id: string) {
  const [artifact] = await db.drizzle.select().from(db.schema.artifacts)
    .where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId)));
  if (!artifact) throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found');
  return decryptArtifact(artifact as ArtifactRow);
}

export async function listArtifacts(db: DbInstance, companyId: string, filters: {
  projectId?: string | null; filterNullProject?: boolean; type?: ArtifactType; status?: 'active' | 'archived' | 'deleted'; folderId?: string; filterNullFolder?: boolean;
  limit: number; offset: number;
  sort?: 'updatedAt' | 'title' | 'type' | 'createdAt';
  order?: 'asc' | 'desc';
}) {
  if (filters.projectId && !filters.filterNullProject) await validateProjectOwnership(db, companyId, filters.projectId);
  const a = db.schema.artifacts;
  const conditions = [eq(a.companyId, companyId)];
  if (filters.filterNullProject) {
    conditions.push(isNull(a.projectId));
  } else if (filters.projectId) {
    conditions.push(eq(a.projectId, filters.projectId));
  }
  if (filters.type) conditions.push(eq(a.type, filters.type));
  if (filters.status) conditions.push(eq(a.status, filters.status));
  if (filters.filterNullFolder) {
    conditions.push(isNull(a.folderId));
  } else if (filters.folderId) {
    conditions.push(eq(a.folderId, filters.folderId));
  }
  const where = and(...conditions);

  // Build order clause from sort/order params.
  // Default: updatedAt desc. Tie-breaker: id desc (stable, deterministic).
  const sortCol = filters.sort === 'title' ? a.title
    : filters.sort === 'type' ? a.type
    : filters.sort === 'createdAt' ? a.createdAt
    : a.updatedAt;
  const orderDir = filters.order === 'asc' ? asc : desc;
  const [rows, count] = await Promise.all([
    db.drizzle.select().from(a).where(where).orderBy(orderDir(sortCol), desc(a.id)).limit(filters.limit).offset(filters.offset),
    db.drizzle.select({ total: sql<number>`count(*)` }).from(a).where(where),
  ]);
  return { rows: (rows as ArtifactRow[]).map(decryptArtifact), total: Number(count[0]?.total ?? 0) };
}

export async function updateArtifact(db: DbInstance, companyId: string, id: string, input: {
  version?: number; title?: string; content?: unknown; projectId?: string | null; message?: string;
  status?: 'deleted' | 'archived' | 'active';
}, editor: Editor) {
  const current = await getArtifact(db, companyId, id);

  // ── Co-edit session integration (M3) ──────────────────────────────────
  // When an active co-edit session exists for this artifact, route content
  // updates through the session (merge, no 409). This supersedes the M1 LWW
  // 409 for live co-editors. The 409 path below remains for stale
  // single-client writes (no active session).
  if (input.content !== undefined && hasSession(id)) {
    const result = mergeExternalUpdate(id, input.content as Record<string, unknown>, editor);
    if (result) {
      // The session merged the content. Flush to DB directly via
      // saveArtifactContent (bypasses the co-edit check to avoid recursion).
      const sessionContent = result.merged;
      const updated = await saveArtifactContent(db, companyId, id, sessionContent, current.version, editor, input.message);
      // Update the session's version + lastSavedContent to reflect the flush
      updateSessionAfterFlush(id, updated.version, sessionContent, input.title ?? updated.title);
      if (input.title !== undefined && updated.title !== input.title) {
        const [titleUpdated] = await db.drizzle.update(db.schema.artifacts).set({
          title: input.title, updatedAt: new Date(),
        }).where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId))).returning();
        if (titleUpdated) {
          emit('artifact.updated', companyId, titleUpdated, editor);
          return decryptArtifact(titleUpdated as ArtifactRow);
        }
      }
      return updated;
    }
  }

  // ── Standard optimistic version check (M1 path) ──────────────────────
  const version = input.version;
  if (version === undefined) throw new AppError(400, 'VERSION_REQUIRED', 'version is required for artifact updates');
  if (version !== current.version) throw new AppError(409, 'ARTIFACT_VERSION_CONFLICT', 'Artifact was updated by another client', { current: current });
  if (input.content !== undefined) assertContent(current.type, input.content);
  if (input.projectId !== undefined) await validateProjectOwnership(db, companyId, input.projectId);
  // `current.content` is already decrypted (from getArtifact). When content
  // is supplied, encrypt it for storage; when only title/status changes,
  // re-encrypt the (decrypted) current content to keep at-rest ciphertext.
  const plaintextContent = input.content !== undefined ? (input.content as Record<string, unknown>) : current.content;
  const storedContent = encryptContent(plaintextContent);
  const updated = await db.drizzle.transaction(async (tx) => {
    const [row] = await tx.update(db.schema.artifacts).set({
      title: input.title ?? current.title, content: storedContent,
      projectId: input.projectId === undefined ? current.projectId : input.projectId,
      version: current.version + 1, updatedAt: new Date(),
      ...(input.status !== undefined ? { status: input.status, deletedAt: input.status === 'deleted' ? new Date() : null } : {}),
      lastEditedByUserId: editor.userId ?? null, lastEditedByAgentId: editor.agentId ?? null,
    }).where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId), eq(db.schema.artifacts.version, version))).returning();
    if (!row) throw new AppError(409, 'ARTIFACT_VERSION_CONFLICT', 'Artifact was updated by another client', { current: await getArtifact(db, companyId, id) });
    await tx.insert(db.schema.artifactRevisions).values({
      artifactId: id, version: row.version, content: storedContent,
      editedByUserId: editor.userId ?? null, editedByAgentId: editor.agentId ?? null,
      editSource: editor.editSource ?? 'user', message: input.message ?? null,
    });
    return row;
  });
  emit('artifact.updated', companyId, updated, editor);
  emit('artifact.revision.created', companyId, { artifactId: id, version: updated.version, editSource: editor.editSource ?? 'user', actor: actorFromEditor(editor) });
  return decryptArtifact(updated as ArtifactRow);
}

export async function setArtifactStatus(db: DbInstance, companyId: string, id: string, status: 'deleted' | 'archived' | 'active', editor: Editor) {
  const current = await getArtifact(db, companyId, id);
  const updated = await updateArtifact(db, companyId, id, {
    version: current.version, content: current.content, message: `status:${status}`, status,
  }, editor);
  emit(status === 'deleted' ? 'artifact.deleted' : status === 'archived' ? 'artifact.archived' : 'artifact.updated', companyId, { ...updated, status }, editor);
  return updated;
}

export async function listRevisions(db: DbInstance, companyId: string, id: string) {
  await getArtifact(db, companyId, id);
  const rows = await db.drizzle.select().from(db.schema.artifactRevisions).where(eq(db.schema.artifactRevisions.artifactId, id))
    .orderBy(asc(db.schema.artifactRevisions.version));
  return (rows as RevisionRow[]).map(decryptRevision);
}

export async function getRevision(db: DbInstance, companyId: string, id: string, version: number) {
  await getArtifact(db, companyId, id);
  const [revision] = await db.drizzle.select().from(db.schema.artifactRevisions)
    .where(and(eq(db.schema.artifactRevisions.artifactId, id), eq(db.schema.artifactRevisions.version, version)));
  if (!revision) throw new AppError(404, 'REVISION_NOT_FOUND', 'Revision not found');
  return decryptRevision(revision as RevisionRow);
}

/**
 * Permanently (hard) delete an artifact and all its revisions (M8 step-up
 * gated sensitive operation). Unlike the soft-delete `setArtifactStatus`,
 * this removes the row and its revision history entirely. The caller MUST
 * have verified step-up re-authentication (`artifact_permanent_delete`
 * scope) before invoking this.
 */
export async function permanentlyDeleteArtifact(
  db: DbInstance,
  companyId: string,
  id: string,
): Promise<{ id: string; permanent: true }> {
  const current = await getArtifact(db, companyId, id);
  // Revisions cascade-delete via the FK ON DELETE cascade.
  await db.drizzle
    .delete(db.schema.artifacts)
    .where(
      and(
        eq(db.schema.artifacts.id, id),
        eq(db.schema.artifacts.companyId, companyId),
      ),
    );
  emit('artifact.deleted', companyId, { ...current, permanent: true });
  return { id, permanent: true };
}

/**
 * Transfer ownership of an artifact to another project (or to company-level
 * via projectId=null) within the same company (M8 step-up gated sensitive
 * operation). The caller MUST have verified step-up re-authentication
 * (`artifact_transfer` scope) before invoking this.
 */
export async function transferArtifactOwnership(
  db: DbInstance,
  companyId: string,
  id: string,
  input: { projectId: string | null },
  editor: Editor,
): Promise<unknown> {
  const current = await getArtifact(db, companyId, id);
  if (input.projectId !== null) {
    await validateProjectOwnership(db, companyId, input.projectId);
  }
  const updated = await db.drizzle.transaction(async (tx) => {
    const [row] = await tx
      .update(db.schema.artifacts)
      .set({
        projectId: input.projectId,
        version: current.version + 1,
        updatedAt: new Date(),
        lastEditedByUserId: editor.userId ?? null,
        lastEditedByAgentId: editor.agentId ?? null,
      })
      .where(
        and(
          eq(db.schema.artifacts.id, id),
          eq(db.schema.artifacts.companyId, companyId),
          eq(db.schema.artifacts.version, current.version),
        ),
      )
      .returning();
    if (!row) {
      throw new AppError(
        409,
        'ARTIFACT_VERSION_CONFLICT',
        'Artifact was updated by another client',
        { current: await getArtifact(db, companyId, id) },
      );
    }
    await tx.insert(db.schema.artifactRevisions).values({
      artifactId: id,
      version: row.version,
      content: encryptContent(current.content),
      editedByUserId: editor.userId ?? null,
      editedByAgentId: editor.agentId ?? null,
      editSource: editor.editSource ?? 'user',
      message: `ownership transfer → projectId=${input.projectId ?? 'null'}`,
    });
    return row;
  });
  emit('artifact.updated', companyId, updated, editor);
  emit('artifact.revision.created', companyId, {
    artifactId: id,
    version: (updated as any).version,
    editSource: editor.editSource ?? 'user',
    actor: actorFromEditor(editor),
  });
  return decryptArtifact(updated as ArtifactRow);
}
