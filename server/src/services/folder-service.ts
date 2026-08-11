import { and, eq, isNull } from 'drizzle-orm';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import type { DbInstance } from '../types.js';

type Folder = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Postgres SQLSTATE for unique violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Walk an error + its cause chain looking for a Postgres error code
 * (postgres.js may be wrapped by drizzle-orm, so the code can live on a
 * cause). Returns true if a unique-violation (23505) is found.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as Record<string, unknown>;
    if (candidate.code === UNIQUE_VIOLATION) return true;
    current = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

function emitFolder(type: 'folder.created' | 'folder.updated' | 'folder.deleted', companyId: string, folder: unknown) {
  eventBus.emitEvent({ type, companyId, payload: { folder }, timestamp: new Date().toISOString() });
}

/**
 * Validate that a folder belongs to the given company. Returns the folder row
 * or throws 404 when missing / cross-company.
 */
export async function getFolder(db: DbInstance, companyId: string, id: string): Promise<Folder> {
  const [folder] = await db.drizzle.select().from(db.schema.artifactFolders)
    .where(and(eq(db.schema.artifactFolders.id, id), eq(db.schema.artifactFolders.companyId, companyId)));
  if (!folder) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
  return folder as Folder;
}

/**
 * Validate folder ownership without throwing — returns the folder or null.
 * Used to validate an artifact's `folderId` reference (cross-company folders
 * are rejected by callers with 400/403).
 */
export async function findFolder(db: DbInstance, companyId: string, id: string): Promise<Folder | null> {
  const [folder] = await db.drizzle.select().from(db.schema.artifactFolders)
    .where(and(eq(db.schema.artifactFolders.id, id), eq(db.schema.artifactFolders.companyId, companyId)));
  return (folder as Folder) ?? null;
}

/**
 * Validate that `folderId` belongs to `companyId` (and optionally `projectId`).
 * Returns null when folderId is null/undefined (unfiled is valid). Throws
 * FOLDER_INVALID (400) when the folder belongs to another company.
 */
export async function validateFolderOwnership(
  db: DbInstance,
  companyId: string,
  folderId: string | null | undefined,
): Promise<Folder | null> {
  if (folderId === null || folderId === undefined) return null;
  const folder = await findFolder(db, companyId, folderId);
  if (!folder) {
    throw new AppError(400, 'FOLDER_INVALID', 'Folder does not belong to this company');
  }
  return folder;
}

/**
 * Walk up the parent chain from `folderId` to detect whether `candidateId`
 * is an ancestor (used to prevent cycles when reparenting). Returns true if
 * `candidateId` is found in the ancestor chain of `folderId`.
 */
async function isAncestor(db: DbInstance, companyId: string, folderId: string, candidateId: string): Promise<boolean> {
  const f = db.schema.artifactFolders;
  let current: string | null = folderId;
  // Bound the walk to a generous depth to avoid infinite loops on corrupted data.
  for (let depth = 0; depth < 256 && current; depth++) {
    if (current === candidateId) return true;
    const [row] = await db.drizzle.select({ parentId: f.parentId }).from(f)
      .where(and(eq(f.id, current), eq(f.companyId, companyId)));
    if (!row) return false;
    current = row.parentId;
  }
  return false;
}

export async function createFolder(db: DbInstance, companyId: string, input: {
  name: string; projectId?: string | null; parentId?: string | null;
}): Promise<Folder> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'Folder name is required');
  if (name.length > 200) throw new AppError(400, 'VALIDATION_ERROR', 'Folder name must be 200 characters or fewer');

  // Validate project ownership (projectId must belong to companyId).
  await validateProjectOwnership(db, companyId, input.projectId);

  // Validate parent: must belong to the same company; self-reference rejected.
  if (input.parentId) {
    if (input.parentId === undefined) throw new AppError(400, 'VALIDATION_ERROR', 'parentId must be a valid uuid');
    const parent = await getFolder(db, companyId, input.parentId);
    // A child must share the parent's project scope (a project folder cannot
    // nest under a company-level folder and vice versa).
    if ((parent.projectId ?? null) !== (input.projectId ?? null)) {
      throw new AppError(400, 'FOLDER_SCOPE_MISMATCH', 'Child folder must share the parent folder project scope');
    }
  }

  const f = db.schema.artifactFolders;
  let created: Folder;
  try {
    const [row] = await db.drizzle.insert(f).values({
      companyId,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      name,
    }).returning();
    created = row as Folder;
  } catch (err: any) {
    // Unique violation on (company, project, parent, lower(name)).
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'FOLDER_NAME_CONFLICT', 'A folder with that name already exists in this location');
    }
    throw err;
  }
  emitFolder('folder.created', companyId, created);
  return created;
}

export async function listFolders(db: DbInstance, companyId: string, projectId?: string | null): Promise<Folder[]> {
  const f = db.schema.artifactFolders;
  const conditions = [eq(f.companyId, companyId)];
  if (projectId !== undefined) {
    if (projectId === null) {
      conditions.push(isNull(f.projectId));
    } else {
      conditions.push(eq(f.projectId, projectId));
    }
  }
  const rows = await db.drizzle.select().from(f).where(and(...conditions)).orderBy(f.name);
  return rows as Folder[];
}

/**
 * Update a folder: rename and/or reparent. Both are metadata-only operations
 * that do not touch contained artifacts' folderId (VAL-FOLDER-008/016).
 */
export async function updateFolder(db: DbInstance, companyId: string, id: string, input: {
  name?: string; parentId?: string | null;
}): Promise<Folder> {
  const current = await getFolder(db, companyId, id);
  const f = db.schema.artifactFolders;

  const updates: Partial<{ name: string; parentId: string | null; updatedAt: Date }> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new AppError(400, 'VALIDATION_ERROR', 'Folder name is required');
    if (name.length > 200) throw new AppError(400, 'VALIDATION_ERROR', 'Folder name must be 200 characters or fewer');
    updates.name = name;
  }
  if (input.parentId !== undefined) {
    const newParentId = input.parentId;
    // Self-reference rejected.
    if (newParentId === id) {
      throw new AppError(400, 'FOLDER_CYCLE', 'A folder cannot be its own parent');
    }
    if (newParentId === null) {
      // Move to top-level. Project scope is preserved (a project folder stays
      // a project folder; unparenting does not change projectId).
      updates.parentId = null;
    } else {
      const parent = await getFolder(db, companyId, newParentId);
      // Cycle prevention: the new parent must not be a descendant of this folder.
      if (await isAncestor(db, companyId, newParentId, id)) {
        throw new AppError(400, 'FOLDER_CYCLE', 'Cannot move a folder into one of its own descendants');
      }
      // Project scope must match.
      if ((parent.projectId ?? null) !== (current.projectId ?? null)) {
        throw new AppError(400, 'FOLDER_SCOPE_MISMATCH', 'Moved folder must share the parent folder project scope');
      }
      updates.parentId = newParentId;
    }
  }

  if (Object.keys(updates).length === 0) {
    return current;
  }
  updates.updatedAt = new Date();

  let updated: Folder;
  try {
    const [row] = await db.drizzle.update(f).set(updates)
      .where(and(eq(f.id, id), eq(f.companyId, companyId))).returning();
    if (!row) throw new AppError(404, 'FOLDER_NOT_FOUND', 'Folder not found');
    updated = row as Folder;
  } catch (err: any) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, 'FOLDER_NAME_CONFLICT', 'A folder with that name already exists in this location');
    }
    throw err;
  }
  emitFolder('folder.updated', companyId, updated);
  return updated;
}

/**
 * Delete a folder, relocating its children (folders + artifacts) to the
 * deleted folder's parent (or to unfiled/root when the deleted folder is
 * top-level). No artifacts or child folders are deleted (VAL-FOLDER-009/017).
 */
export async function deleteFolder(db: DbInstance, companyId: string, id: string): Promise<void> {
  const current = await getFolder(db, companyId, id);
  const f = db.schema.artifactFolders;
  const a = db.schema.artifacts;
  const grandparentId = current.parentId;

  await db.drizzle.transaction(async (tx) => {
    // Relocate child folders to the grandparent.
    await tx.update(f).set({ parentId: grandparentId })
      .where(and(eq(f.parentId, id), eq(f.companyId, companyId)));
    // Relocate contained artifacts to the grandparent (or unfiled).
    await tx.update(a).set({ folderId: grandparentId })
      .where(and(eq(a.folderId, id), eq(a.companyId, companyId)));
    // Remove the folder row.
    await tx.delete(f).where(and(eq(f.id, id), eq(f.companyId, companyId)));
  });
  emitFolder('folder.deleted', companyId, { id, companyId, parentId: grandparentId });
}

/**
 * Move an artifact into/out of/between folders. A metadata-only operation:
 * does NOT bump `version` or write a revision (moving is not a content edit).
 * VAL-FOLDER-011: content edits preserve folderId; this is the dedicated move
 * path used by PATCH /artifacts/:id when only folderId is supplied.
 */
export async function moveArtifactToFolder(
  db: DbInstance,
  companyId: string,
  id: string,
  folderId: string | null,
): Promise<void> {
  // Validate the artifact belongs to the company (404 otherwise).
  const [artifact] = await db.drizzle.select({ id: db.schema.artifacts.id, projectId: db.schema.artifacts.projectId })
    .from(db.schema.artifacts)
    .where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId)));
  if (!artifact) throw new AppError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not found');

  if (folderId !== null) {
    const folder = await validateFolderOwnership(db, companyId, folderId);
    // The folder's project scope should match the artifact's scope when both
    // are project-scoped. We allow moving a company-level artifact into a
    // company-level folder, and a project artifact into a folder under the
    // same project. Cross-scope moves (project artifact into company folder)
    // are rejected to keep the folder tree coherent with artifact scoping.
    if (folder) {
      const folderProject = folder.projectId ?? null;
      const artifactProject = artifact.projectId ?? null;
      if (folderProject !== artifactProject) {
        throw new AppError(400, 'FOLDER_SCOPE_MISMATCH', 'Artifact and folder must share the same project scope');
      }
    }
  }

  await db.drizzle.update(db.schema.artifacts).set({ folderId, updatedAt: new Date() })
    .where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId)));

  // Emit an artifact.updated event so clients refresh the list/tree.
  const [updated] = await db.drizzle.select().from(db.schema.artifacts)
    .where(and(eq(db.schema.artifacts.id, id), eq(db.schema.artifacts.companyId, companyId)));
  if (updated) {
    eventBus.emitEvent({ type: 'artifact.updated', companyId, payload: { artifact: updated }, timestamp: new Date().toISOString() });
  }
}
