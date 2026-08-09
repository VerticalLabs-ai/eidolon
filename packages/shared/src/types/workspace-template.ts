import { z } from 'zod';
import { ArtifactTypeSchema } from './artifact.js';

/**
 * Folder snapshot captured inside a project template. `originalId` is the
 * source folder's id (used to map folderId references on cloned artifacts to
 * the new folder ids at create-from-template time). `parentId` is the
 * original parent folder id (null = top-level), preserved so the hierarchy
 * can be reproduced.
 */
export const ProjectTemplateFolderSchema = z.object({
  originalId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  name: z.string().min(1),
});

/**
 * Artifact snapshot captured inside a project template. `originalFolderId`
 * is the source folder's id (null = unfiled); at create-from-template time it
 * is mapped to the equivalent cloned folder id. Content is the full
 * save-time snapshot (VAL-TEMPLATE-012).
 */
export const ProjectTemplateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  title: z.string().min(1),
  content: z.unknown(),
  contentSchemaVersion: z.number().int().positive().default(1),
  originalFolderId: z.string().nullable(),
});

/**
 * Project settings snapshot captured inside a project template. These are
 * applied to the new project at create-from-template time
 * (VAL-TEMPLATE-002).
 */
export const ProjectTemplateSettingsSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
  repoUrl: z.string().nullable().optional(),
});

/**
 * Full project template snapshot. Captured at save time and immutable
 * thereafter (editing the original project does not mutate the snapshot —
 * VAL-TEMPLATE-004/012).
 */
export const ProjectTemplateSnapshotSchema = z.object({
  settings: ProjectTemplateSettingsSchema,
  folders: z.array(ProjectTemplateFolderSchema).default([]),
  artifacts: z.array(ProjectTemplateArtifactSchema).default([]),
});

export type ProjectTemplateFolder = z.infer<typeof ProjectTemplateFolderSchema>;
export type ProjectTemplateArtifact = z.infer<typeof ProjectTemplateArtifactSchema>;
export type ProjectTemplateSettings = z.infer<typeof ProjectTemplateSettingsSchema>;
export type ProjectTemplateSnapshot = z.infer<typeof ProjectTemplateSnapshotSchema>;
