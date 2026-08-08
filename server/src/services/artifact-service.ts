import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { ArtifactTypeSchema, validateArtifactContent } from '@eidolon/shared';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import type { z } from 'zod';

type ArtifactType = z.infer<typeof ArtifactTypeSchema>;
type Editor = { userId?: string | null; agentId?: string | null; editSource?: 'user' | 'agent' | 'system' };

function assertContent(type: ArtifactType, content: unknown): void {
  const result = validateArtifactContent(type, content);
  if (!result.success) throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', 'Content does not match the artifact type', result.error.flatten());
}

function emit(type: 'artifact.created' | 'artifact.updated' | 'artifact.revision.created' | 'artifact.deleted' | 'artifact.archived', companyId: string, artifact: unknown) {
  eventBus.emitEvent({ type, companyId, payload: { artifact }, timestamp: new Date().toISOString() });
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
  const { artifacts, artifactRevisions } = db.schema;
  const created = await db.drizzle.transaction(async (tx) => {
    const [artifact] = await tx.insert(artifacts).values({
      companyId, projectId: input.projectId ?? null, folderId: input.folderId ?? null,
      type: input.type, title: input.title, content: input.content as Record<string, unknown>,
      createdByUserId: editor.userId ?? null, createdByAgentId: editor.agentId ?? null,
      lastEditedByUserId: editor.userId ?? null, lastEditedByAgentId: editor.agentId ?? null,
    }).returning();
    await tx.insert(artifactRevisions).values({
      artifactId: artifact.id, version: 1, content: input.content as Record<string, unknown>,
      editedByUserId: editor.userId ?? null, editedByAgentId: editor.agentId ?? null,
      editSource: editor.editSource ?? 'user',
    });
    return artifact;
  });
  emit('artifact.created', companyId, created);
  emit('artifact.revision.created', companyId, { artifactId: created.id, version: 1, editSource: editor.editSource ?? 'user' });
  return created;
}

export async function getArtifact(db: DbInstance, companyId: string, id: string) {
  const [artifact] = await db.drizzle.select().from(db.schema.artifacts)
    .where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId)));
  if (!artifact) throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found');
  return artifact;
}

export async function listArtifacts(db: DbInstance, companyId: string, filters: {
  projectId?: string | null; filterNullProject?: boolean; type?: ArtifactType; status?: 'active' | 'archived' | 'deleted'; folderId?: string;
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
  if (filters.folderId) conditions.push(eq(a.folderId, filters.folderId));
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
  return { rows, total: Number(count[0]?.total ?? 0) };
}

export async function updateArtifact(db: DbInstance, companyId: string, id: string, input: {
  version?: number; title?: string; content?: unknown; projectId?: string | null; message?: string;
  status?: 'deleted' | 'archived' | 'active';
}, editor: Editor) {
  const current = await getArtifact(db, companyId, id);
  const version = input.version;
  if (version === undefined) throw new AppError(400, 'VERSION_REQUIRED', 'version is required for artifact updates');
  if (version !== current.version) throw new AppError(409, 'ARTIFACT_VERSION_CONFLICT', 'Artifact was updated by another client', { current: current });
  if (input.content !== undefined) assertContent(current.type, input.content);
  if (input.projectId !== undefined) await validateProjectOwnership(db, companyId, input.projectId);
  const nextContent = input.content ?? current.content;
  const updated = await db.drizzle.transaction(async (tx) => {
    const [row] = await tx.update(db.schema.artifacts).set({
      title: input.title ?? current.title, content: nextContent as Record<string, unknown>,
      projectId: input.projectId === undefined ? current.projectId : input.projectId,
      version: current.version + 1, updatedAt: new Date(),
      ...(input.status !== undefined ? { status: input.status, deletedAt: input.status === 'deleted' ? new Date() : null } : {}),
      lastEditedByUserId: editor.userId ?? null, lastEditedByAgentId: editor.agentId ?? null,
    }).where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId), eq(db.schema.artifacts.version, version))).returning();
    if (!row) throw new AppError(409, 'ARTIFACT_VERSION_CONFLICT', 'Artifact was updated by another client', { current: await getArtifact(db, companyId, id) });
    await tx.insert(db.schema.artifactRevisions).values({
      artifactId: id, version: row.version, content: nextContent as Record<string, unknown>,
      editedByUserId: editor.userId ?? null, editedByAgentId: editor.agentId ?? null,
      editSource: editor.editSource ?? 'user', message: input.message ?? null,
    });
    return row;
  });
  emit('artifact.updated', companyId, updated);
  emit('artifact.revision.created', companyId, { artifactId: id, version: updated.version, editSource: editor.editSource ?? 'user' });
  return updated;
}

export async function setArtifactStatus(db: DbInstance, companyId: string, id: string, status: 'deleted' | 'archived' | 'active', editor: Editor) {
  const current = await getArtifact(db, companyId, id);
  const updated = await updateArtifact(db, companyId, id, {
    version: current.version, content: current.content, message: `status:${status}`, status,
  }, editor);
  emit(status === 'deleted' ? 'artifact.deleted' : status === 'archived' ? 'artifact.archived' : 'artifact.updated', companyId, updated);
  return updated;
}

export async function listRevisions(db: DbInstance, companyId: string, id: string) {
  await getArtifact(db, companyId, id);
  return db.drizzle.select().from(db.schema.artifactRevisions).where(eq(db.schema.artifactRevisions.artifactId, id))
    .orderBy(asc(db.schema.artifactRevisions.version));
}

export async function getRevision(db: DbInstance, companyId: string, id: string, version: number) {
  await getArtifact(db, companyId, id);
  const [revision] = await db.drizzle.select().from(db.schema.artifactRevisions)
    .where(and(eq(db.schema.artifactRevisions.artifactId, id), eq(db.schema.artifactRevisions.version, version)));
  if (!revision) throw new AppError(404, 'REVISION_NOT_FOUND', 'Revision not found');
  return revision;
}
