import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  ArtifactTypeSchema,
  ProjectTemplateSnapshotSchema,
  validateArtifactContent,
  formatArtifactValidationIssues,
  summarizeArtifactValidationIssues,
} from '@eidolon/shared';
import type { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import { getArtifact } from './artifact-service.js';
import { encryptContent, decryptContent } from './content-encryption.js';
import type { DbInstance } from '../types.js';

type ArtifactType = z.infer<typeof ArtifactTypeSchema>;
type ProjectTemplateSnapshot = z.infer<typeof ProjectTemplateSnapshotSchema>;

function emit(
  type:
    | 'project_template.created'
    | 'project_template.deleted'
    | 'artifact_template.created'
    | 'artifact_template.deleted',
  companyId: string,
  payload: Record<string, unknown>,
): void {
  eventBus.emitEvent({ type, companyId, payload, timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Project templates
// ---------------------------------------------------------------------------

/**
 * Capture a snapshot of a project's settings, folders, and artifacts at save
 * time. The snapshot is a deep JSON copy — editing the original project after
 * save does not mutate it (VAL-TEMPLATE-004/012).
 */
export async function saveProjectTemplate(
  db: DbInstance,
  companyId: string,
  input: { projectId: string; name: string; description?: string | null; userId?: string | null },
): Promise<unknown> {
  // Validate the source project belongs to the company.
  await validateProjectOwnership(db, companyId, input.projectId);

  const { projects, artifacts, artifactFolders } = db.schema;

  const [project] = await db.drizzle.select().from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found');

  // Capture folders (project-scoped only).
  const folderRows = await db.drizzle.select().from(artifactFolders)
    .where(and(eq(artifactFolders.companyId, companyId), eq(artifactFolders.projectId, input.projectId)));

  // Capture active artifacts in the project.
  const artifactRows = await db.drizzle.select().from(artifacts)
    .where(and(eq(artifacts.companyId, companyId), eq(artifacts.projectId, input.projectId), eq(artifacts.status, 'active')));

  const snapshot: ProjectTemplateSnapshot = {
    settings: {
      name: project.name,
      description: project.description,
      status: project.status,
      repoUrl: project.repoUrl,
    },
    folders: folderRows.map((f) => ({
      originalId: f.id,
      parentId: f.parentId,
      name: f.name,
    })),
    artifacts: artifactRows.map((a) => ({
      type: a.type as ArtifactType,
      title: a.title,
      content: decryptContent(a.content as Record<string, unknown>),
      contentSchemaVersion: a.contentSchemaVersion,
      originalFolderId: a.folderId,
    })),
  };

  // Validate the snapshot structure.
  const parsed = ProjectTemplateSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_TEMPLATE_SNAPSHOT', `Template snapshot failed validation${summarizeArtifactValidationIssues(parsed.error) ? `: ${summarizeArtifactValidationIssues(parsed.error)}` : ''}`, formatArtifactValidationIssues(parsed.error));
  }

  const { projectTemplates } = db.schema;
  const [row] = await db.drizzle.insert(projectTemplates).values({
    companyId,
    name: input.name,
    description: input.description ?? null,
    projectId: input.projectId,
    snapshot: parsed.data as unknown as Record<string, unknown>,
    artifactCount: parsed.data.artifacts.length,
    folderCount: parsed.data.folders.length,
    createdByUserId: input.userId ?? null,
  }).returning();

  emit('project_template.created', companyId, { template: row });
  return row;
}

export async function listProjectTemplates(db: DbInstance, companyId: string): Promise<unknown[]> {
  const { projectTemplates } = db.schema;
  return db.drizzle.select().from(projectTemplates)
    .where(eq(projectTemplates.companyId, companyId))
    .orderBy(projectTemplates.createdAt);
}

export async function getProjectTemplate(db: DbInstance, companyId: string, id: string): Promise<unknown> {
  const { projectTemplates } = db.schema;
  const [row] = await db.drizzle.select().from(projectTemplates)
    .where(and(eq(projectTemplates.id, id), eq(projectTemplates.companyId, companyId)))
    .limit(1);
  if (!row) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Project template not found');
  return row;
}

export async function deleteProjectTemplate(db: DbInstance, companyId: string, id: string): Promise<void> {
  const { projectTemplates } = db.schema;
  const [row] = await db.drizzle.delete(projectTemplates)
    .where(and(eq(projectTemplates.id, id), eq(projectTemplates.companyId, companyId)))
    .returning({ id: projectTemplates.id });
  if (!row) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Project template not found');
  emit('project_template.deleted', companyId, { id });
}

/**
 * Create a new project from a project template. Clones the template's
 * artifacts (with fresh ids) and reproduces the folder structure, placing
 * each cloned artifact into the equivalent cloned folder
 * (VAL-TEMPLATE-002/008). The cloned artifacts are authored by the creating
 * user (VAL-CROSS-013).
 *
 * Idempotency (VAL-TEMPLATE-010): when `idempotencyKey` is supplied, a
 * retry with the same key returns the existing cloned project instead of
 * creating a duplicate. The (companyId, templateId, idempotencyKey) tuple
 * is recorded in `project_template_clones` with a unique index, so even
 * concurrent retries produce exactly one project.
 */
export async function createProjectFromTemplate(
  db: DbInstance,
  companyId: string,
  templateId: string,
  input: { name?: string; description?: string | null; idempotencyKey?: string; userId?: string | null },
): Promise<{ project: unknown; artifacts: unknown[]; folders: unknown[] }> {
  const template = await getProjectTemplate(db, companyId, templateId) as {
    id: string;
    companyId: string;
    snapshot: ProjectTemplateSnapshot;
    artifactCount: number;
    folderCount: number;
  };

  // ── Idempotency check ─────────────────────────────────────────────────
  if (input.idempotencyKey) {
    const { projectTemplateClones, projects } = db.schema;
    const [existing] = await db.drizzle.select().from(projectTemplateClones)
      .where(and(
        eq(projectTemplateClones.companyId, companyId),
        eq(projectTemplateClones.templateId, templateId),
        eq(projectTemplateClones.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    if (existing) {
      // Return the existing cloned project + its artifacts/folders.
      const [project] = await db.drizzle.select().from(projects)
        .where(eq(projects.id, existing.projectId)).limit(1);
      const artifactRows = await db.drizzle.select().from(db.schema.artifacts)
        .where(and(eq(db.schema.artifacts.companyId, companyId), eq(db.schema.artifacts.projectId, existing.projectId), eq(db.schema.artifacts.status, 'active')));
      const folderRows = await db.drizzle.select().from(db.schema.artifactFolders)
        .where(and(eq(db.schema.artifactFolders.companyId, companyId), eq(db.schema.artifactFolders.projectId, existing.projectId)));
      return {
        project,
        artifacts: artifactRows.map((r) => ({ ...r, content: decryptContent(r.content as Record<string, unknown>) })),
        folders: folderRows,
      };
    }
  }

  const snapshot = template.snapshot;
  const settings = snapshot.settings;
  const { projects, artifacts, artifactRevisions, artifactFolders, projectTemplateClones } = db.schema;
  const now = new Date();
  const projectId = randomUUID();
  const userId = input.userId ?? null;

  // Map original folder ids → new folder ids (for artifact placement).
  const folderIdMap = new Map<string, string>();

  const result = await db.drizzle.transaction(async (tx) => {
    // 1. Create the new project with the template's settings (overridden by
    //    the caller's name/description when provided).
    const [project] = await tx.insert(projects).values({
      id: projectId,
      companyId,
      name: input.name ?? settings.name,
      description: input.description ?? settings.description ?? null,
      status: (settings.status as 'planning' | 'active' | 'completed' | 'archived') ?? 'planning',
      repoUrl: settings.repoUrl ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    // 2. Reproduce the folder structure. Folders are inserted top-level
    //    first, then children, in breadth-first order by parentId depth so
    //    every parent exists before its children are inserted.
    const folders = snapshot.folders;
    // Sort: top-level (parentId null) first, then by ancestor depth.
    const sortedFolders = [...folders].sort((a, b) => {
      const aDepth = a.parentId === null ? 0 : 1;
      const bDepth = b.parentId === null ? 0 : 1;
      return aDepth - bDepth;
    });
    // Multiple passes to handle deeper hierarchies (a child's parent may
    // not be inserted until a later pass). Bound by folder count.
    const pending = new Set(sortedFolders);
    for (let pass = 0; pass < folders.length + 1 && pending.size > 0; pass += 1) {
      for (const folder of Array.from(pending)) {
        // Top-level or parent already mapped.
        if (folder.parentId === null || folderIdMap.has(folder.parentId)) {
          const newFolderId = randomUUID();
          await tx.insert(artifactFolders).values({
            id: newFolderId,
            companyId,
            projectId,
            parentId: folder.parentId === null ? null : folderIdMap.get(folder.parentId) ?? null,
            name: folder.name,
          });
          folderIdMap.set(folder.originalId, newFolderId);
          pending.delete(folder);
        }
      }
    }
    // Any folders still pending have a dangling parentId (shouldn't happen
    // with a well-formed snapshot, but handle gracefully by inserting them
    // as top-level).
    for (const folder of Array.from(pending)) {
      const newFolderId = randomUUID();
      await tx.insert(artifactFolders).values({
        id: newFolderId,
        companyId,
        projectId,
        parentId: null,
        name: folder.name,
      });
      folderIdMap.set(folder.originalId, newFolderId);
    }

    // 3. Clone artifacts with fresh ids, mapped to the new folders.
    const createdArtifacts: unknown[] = [];
    for (const artifact of snapshot.artifacts) {
      // Validate content against the type schema (defensive — the snapshot
      // was validated at save time, but guard against schema drift).
      const validation = validateArtifactContent(artifact.type, artifact.content);
      if (!validation.success) {
        throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', `Template artifact content failed validation for type ${artifact.type}${summarizeArtifactValidationIssues(validation.error) ? `: ${summarizeArtifactValidationIssues(validation.error)}` : ''}`, formatArtifactValidationIssues(validation.error));
      }
      const newFolderId = artifact.originalFolderId === null ? null : folderIdMap.get(artifact.originalFolderId) ?? null;
      const clonedContent = encryptContent(artifact.content as Record<string, unknown>);
      const [created] = await tx.insert(artifacts).values({
        companyId,
        projectId,
        folderId: newFolderId,
        type: artifact.type,
        title: artifact.title,
        content: clonedContent,
        contentSchemaVersion: artifact.contentSchemaVersion,
        createdByUserId: userId,
        lastEditedByUserId: userId,
      }).returning();
      await tx.insert(artifactRevisions).values({
        artifactId: created.id,
        version: 1,
        content: clonedContent,
        editedByUserId: userId,
        editSource: 'user',
      });
      createdArtifacts.push(created);
    }

    // 4. Record the idempotency clone (if a key was supplied).
    if (input.idempotencyKey) {
      await tx.insert(projectTemplateClones).values({
        companyId,
        templateId,
        idempotencyKey: input.idempotencyKey,
        projectId,
      });
    }

    return { project, artifacts: createdArtifacts, folders: Array.from(folderIdMap.values()) };
  });

  // Emit artifact.created events for each cloned artifact so subscribed
  // clients refresh. (Emitted after the transaction commits.)
  for (const artifact of result.artifacts as Array<{ id: string; content: Record<string, unknown> }>) {
    eventBus.emitEvent({ type: 'artifact.created', companyId, payload: { artifact: { ...artifact, content: decryptContent(artifact.content) } }, timestamp: new Date().toISOString() });
    eventBus.emitEvent({ type: 'artifact.revision.created', companyId, payload: { artifactId: artifact.id, version: 1, editSource: 'user' }, timestamp: new Date().toISOString() });
  }

  // Re-fetch folders with full rows for the response.
  const folderRows = await db.drizzle.select().from(artifactFolders)
    .where(and(eq(artifactFolders.companyId, companyId), eq(artifactFolders.projectId, projectId)));

  return {
    project: result.project,
    artifacts: (result.artifacts as Array<{ id: string; content: Record<string, unknown> }>).map((r) => ({ ...r, content: decryptContent(r.content) })),
    folders: folderRows,
  };
}

// ---------------------------------------------------------------------------
// Artifact templates
// ---------------------------------------------------------------------------

/**
 * Save an individual artifact as a reusable artifact-type template. Captures
 * the artifact's type + content as a deep JSON copy at save time
 * (VAL-TEMPLATE-005/007/012).
 */
export async function saveArtifactTemplate(
  db: DbInstance,
  companyId: string,
  input: { artifactId: string; name: string; description?: string | null; userId?: string | null },
): Promise<unknown> {
  // Validate the source artifact belongs to the company.
  const artifact = await getArtifact(db, companyId, input.artifactId);

  const { artifactTemplates } = db.schema;
  const [row] = await db.drizzle.insert(artifactTemplates).values({
    companyId,
    name: input.name,
    description: input.description ?? null,
    type: artifact.type as ArtifactType,
    content: artifact.content as Record<string, unknown>,
    contentSchemaVersion: artifact.contentSchemaVersion,
    artifactId: artifact.id,
    createdByUserId: input.userId ?? null,
  }).returning();

  emit('artifact_template.created', companyId, { template: row });
  return row;
}

export async function listArtifactTemplates(db: DbInstance, companyId: string, type?: ArtifactType): Promise<unknown[]> {
  const { artifactTemplates } = db.schema;
  const conditions = [eq(artifactTemplates.companyId, companyId)];
  if (type) conditions.push(eq(artifactTemplates.type, type));
  return db.drizzle.select().from(artifactTemplates)
    .where(and(...conditions))
    .orderBy(artifactTemplates.createdAt);
}

export async function getArtifactTemplate(db: DbInstance, companyId: string, id: string): Promise<unknown> {
  const { artifactTemplates } = db.schema;
  const [row] = await db.drizzle.select().from(artifactTemplates)
    .where(and(eq(artifactTemplates.id, id), eq(artifactTemplates.companyId, companyId)))
    .limit(1);
  if (!row) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Artifact template not found');
  return row;
}

export async function deleteArtifactTemplate(db: DbInstance, companyId: string, id: string): Promise<void> {
  const { artifactTemplates } = db.schema;
  const [row] = await db.drizzle.delete(artifactTemplates)
    .where(and(eq(artifactTemplates.id, id), eq(artifactTemplates.companyId, companyId)))
    .returning({ id: artifactTemplates.id });
  if (!row) throw new AppError(404, 'TEMPLATE_NOT_FOUND', 'Artifact template not found');
  emit('artifact_template.deleted', companyId, { id });
}

/**
 * Create a new artifact from an artifact-type template. Clones the template's
 * content into a new artifact of the same type with a fresh id
 * (VAL-TEMPLATE-006). The new artifact is authored by the creating user.
 */
export async function createArtifactFromTemplate(
  db: DbInstance,
  companyId: string,
  templateId: string,
  input: { projectId?: string | null; folderId?: string | null; title?: string; userId?: string | null },
): Promise<unknown> {
  const template = await getArtifactTemplate(db, companyId, templateId) as {
    id: string;
    companyId: string;
    type: ArtifactType;
    content: Record<string, unknown>;
    contentSchemaVersion: number;
  };

  // Validate content (defensive).
  const validation = validateArtifactContent(template.type, template.content);
  if (!validation.success) {
    throw new AppError(400, 'INVALID_ARTIFACT_CONTENT', `Template content failed validation${summarizeArtifactValidationIssues(validation.error) ? `: ${summarizeArtifactValidationIssues(validation.error)}` : ''}`, formatArtifactValidationIssues(validation.error));
  }

  // Validate project + folder ownership.
  await validateProjectOwnership(db, companyId, input.projectId ?? null);

  const { artifacts, artifactRevisions } = db.schema;
  const userId = input.userId ?? null;
  const now = new Date();

  // Folder scope validation: if folderId is set, the folder must belong to
  // the same company and share the artifact's project scope.
  const resolvedFolderId: string | null = input.folderId ?? null;
  if (resolvedFolderId !== null) {
    const { artifactFolders } = db.schema;
    const [folder] = await db.drizzle.select().from(artifactFolders)
      .where(and(eq(artifactFolders.id, resolvedFolderId), eq(artifactFolders.companyId, companyId)))
      .limit(1);
    if (!folder) throw new AppError(400, 'FOLDER_INVALID', 'Folder does not belong to this company');
    const folderProject = folder.projectId ?? null;
    const artifactProject = input.projectId ?? null;
    if (folderProject !== artifactProject) {
      throw new AppError(400, 'FOLDER_SCOPE_MISMATCH', 'Artifact and folder must share the same project scope');
    }
  }

  const created = await db.drizzle.transaction(async (tx) => {
    const templatedContent = encryptContent(template.content);
    const [artifact] = await tx.insert(artifacts).values({
      companyId,
      projectId: input.projectId ?? null,
      folderId: resolvedFolderId,
      type: template.type,
      title: input.title ?? `Untitled ${template.type}`,
      content: templatedContent,
      contentSchemaVersion: template.contentSchemaVersion,
      createdByUserId: userId,
      lastEditedByUserId: userId,
    }).returning();
    await tx.insert(artifactRevisions).values({
      artifactId: artifact.id,
      version: 1,
      content: templatedContent,
      editedByUserId: userId,
      editSource: 'user',
    });
    return artifact;
  });

  const c = created as { id: string; content: Record<string, unknown> };
  const decrypted = { ...c, content: decryptContent(c.content) };
  eventBus.emitEvent({ type: 'artifact.created', companyId, payload: { artifact: decrypted }, timestamp: now.toISOString() });
  eventBus.emitEvent({ type: 'artifact.revision.created', companyId, payload: { artifactId: c.id, version: 1, editSource: 'user' }, timestamp: now.toISOString() });
  return decrypted;
}
