import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface File {
  id: string;
  companyId: string;
  agentId: string | null;
  name: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  content: string | null;
  storageType: string;
  parentId: string | null;
  isDirectory: boolean;
  taskId: string | null;
  executionId: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const FileSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  name: z.string().min(1).max(255),
  path: z.string(),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().min(0),
  content: z.string().nullable(),
  storageType: z.string(),
  parentId: z.string().uuid().nullable(),
  isDirectory: z.boolean(),
  taskId: z.string().uuid().nullable(),
  executionId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateFileInputSchema = z.object({
  name: z.string().min(1).max(255),
  content: z.string().optional(),
  mimeType: z.string().max(100).default('text/plain'),
  agentId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  isDirectory: z.boolean().default(false),
  taskId: z.string().uuid().optional(),
  executionId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().default(null),
});

export type CreateFileInput = z.infer<typeof CreateFileInputSchema>;

export const UpdateFileInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  content: z.string().optional(),
  mimeType: z.string().max(100).optional(),
  projectId: z.string().uuid().nullable().optional(),
});

export type UpdateFileInput = z.infer<typeof UpdateFileInputSchema>;
