import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateFileBody = z.object({
  name: z.string().min(1).max(255),
  content: z.string().optional(),
  mimeType: z.string().max(100).default('text/plain'),
  agentId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  isDirectory: z.boolean().default(false),
  taskId: z.string().uuid().optional(),
  executionId: z.string().uuid().optional(),
});

const PatchFileBody = z.object({
  name: z.string().min(1).max(255).optional(),
  content: z.string().optional(),
  mimeType: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPath(parentPath: string | null, name: string): string {
  if (!parentPath || parentPath === '/') return `/${name}`;
  return `${parentPath}/${name}`;
}

function getMimeType(name: string, provided?: string): string {
  if (provided && provided !== 'text/plain') return provided;
  const ext = name.split('.').pop()?.toLowerCase();
  const mimeMap: Record<string, string> = {
    ts: 'text/typescript',
    tsx: 'text/typescript',
    js: 'application/javascript',
    jsx: 'application/javascript',
    json: 'application/json',
    md: 'text/markdown',
    html: 'text/html',
    css: 'text/css',
    py: 'text/x-python',
    rs: 'text/x-rust',
    go: 'text/x-go',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    toml: 'text/toml',
    xml: 'text/xml',
    sql: 'text/x-sql',
    sh: 'text/x-shellscript',
    txt: 'text/plain',
    csv: 'text/csv',
    svg: 'image/svg+xml',
  };
  return mimeMap[ext ?? ''] ?? provided ?? 'text/plain';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function filesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { agentFiles } = db.schema;

  // GET / - list all files (optional ?agentId filter)
  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);
    const agentId = req.query.agentId as string | undefined;

    const conditions = [eq(agentFiles.companyId, companyId)];
    if (agentId) {
      conditions.push(eq(agentFiles.agentId, agentId));
    }

    const rows = await db.drizzle
      .select({
        id: agentFiles.id,
        companyId: agentFiles.companyId,
        agentId: agentFiles.agentId,
        name: agentFiles.name,
        path: agentFiles.path,
        mimeType: agentFiles.mimeType,
        sizeBytes: agentFiles.sizeBytes,
        storageType: agentFiles.storageType,
        parentId: agentFiles.parentId,
        isDirectory: agentFiles.isDirectory,
        taskId: agentFiles.taskId,
        executionId: agentFiles.executionId,
        createdAt: agentFiles.createdAt,
        updatedAt: agentFiles.updatedAt,
      })
      .from(agentFiles)
      .where(and(...conditions));

    res.json({ data: rows });
  });

  // GET /:id - get file with content
  router.get('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [file] = await db.drizzle
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.id, id), eq(agentFiles.companyId, companyId)))
      .limit(1);

    if (!file) {
      throw new AppError(404, 'FILE_NOT_FOUND', `File ${id} not found`);
    }

    res.json({ data: file });
  });

  // POST / - create file
  router.post('/', validate(CreateFileBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateFileBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();
    const id = randomUUID();

    // If parentId specified, resolve parent path
    let parentPath: string | null = null;
    if (body.parentId) {
      const [parent] = await db.drizzle
        .select({ path: agentFiles.path, isDirectory: agentFiles.isDirectory })
        .from(agentFiles)
        .where(and(eq(agentFiles.id, body.parentId), eq(agentFiles.companyId, companyId)))
        .limit(1);

      if (!parent) {
        throw new AppError(404, 'PARENT_NOT_FOUND', `Parent folder ${body.parentId} not found`);
      }
      if (!parent.isDirectory) {
        throw new AppError(400, 'PARENT_NOT_DIR', 'Parent is not a directory');
      }
      parentPath = parent.path;
    }

    const filePath = buildPath(parentPath, body.name);
    const content = body.isDirectory ? null : (body.content ?? '');
    const mimeType = body.isDirectory ? 'inode/directory' : getMimeType(body.name, body.mimeType);
    const sizeBytes = content ? new TextEncoder().encode(content).length : 0;

    const [row] = await db.drizzle
      .insert(agentFiles)
      .values({
        id,
        companyId,
        agentId: body.agentId ?? null,
        name: body.name,
        path: filePath,
        mimeType,
        sizeBytes,
        content,
        storageType: 'inline',
        parentId: body.parentId ?? null,
        isDirectory: body.isDirectory,
        taskId: body.taskId ?? null,
        executionId: body.executionId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'file.created',
        entityType: 'file',
        entityId: id,
        name: body.name,
      },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // PATCH /:id - update file content
  router.patch('/:id', validate(PatchFileBody), async (req, res) => {
    const body = req.body as z.infer<typeof PatchFileBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.id, id), eq(agentFiles.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'FILE_NOT_FOUND', `File ${id} not found`);
    }

    const now = new Date();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (body.content !== undefined) {
      updates.content = body.content;
      updates.sizeBytes = new TextEncoder().encode(body.content).length;
    }
    if (body.name !== undefined) {
      updates.name = body.name;
      // Rebuild path with new name
      const parentPath = existing.path.split('/').slice(0, -1).join('/') || '/';
      updates.path = buildPath(parentPath === '' ? null : parentPath, body.name);
    }
    if (body.mimeType !== undefined) {
      updates.mimeType = body.mimeType;
    }

    const [updated] = await db.drizzle
      .update(agentFiles)
      .set(updates)
      .where(eq(agentFiles.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'file.updated',
        entityType: 'file',
        entityId: id,
        name: updated.name,
      },
      timestamp: now.toISOString(),
    });

    res.json({ data: updated });
  });

  // DELETE /:id - delete file
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(agentFiles)
      .where(and(eq(agentFiles.id, id), eq(agentFiles.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'FILE_NOT_FOUND', `File ${id} not found`);
    }

    // If it's a directory, also delete all children
    if (existing.isDirectory) {
      // Delete files whose path starts with the directory path
      const children = await db.drizzle
        .select({ id: agentFiles.id })
        .from(agentFiles)
        .where(eq(agentFiles.parentId, id));

      for (const child of children) {
        await db.drizzle.delete(agentFiles).where(eq(agentFiles.id, child.id));
      }
    }

    await db.drizzle.delete(agentFiles).where(eq(agentFiles.id, id));

    eventBus.emitEvent({
      type: 'activity.logged',
      companyId,
      payload: {
        action: 'file.deleted',
        entityType: 'file',
        entityId: id,
        name: existing.name,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: { id, deleted: true } });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Agent-scoped files router
// ---------------------------------------------------------------------------

export function agentFilesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { agentFiles } = db.schema;

  // GET / - list files for a specific agent
  router.get('/', async (req, res) => {
    const { companyId, agentId } = routeParams(req);

    const rows = await db.drizzle
      .select({
        id: agentFiles.id,
        companyId: agentFiles.companyId,
        agentId: agentFiles.agentId,
        name: agentFiles.name,
        path: agentFiles.path,
        mimeType: agentFiles.mimeType,
        sizeBytes: agentFiles.sizeBytes,
        storageType: agentFiles.storageType,
        parentId: agentFiles.parentId,
        isDirectory: agentFiles.isDirectory,
        taskId: agentFiles.taskId,
        executionId: agentFiles.executionId,
        createdAt: agentFiles.createdAt,
        updatedAt: agentFiles.updatedAt,
      })
      .from(agentFiles)
      .where(
        and(eq(agentFiles.companyId, companyId), eq(agentFiles.agentId, agentId)),
      );

    res.json({ data: rows });
  });

  return router;
}
