import { z } from 'zod';

// ---------------------------------------------------------------------------
// @-mention structured types (M1 agent collaboration)
// ---------------------------------------------------------------------------

export const MentionEntityTypeSchema = z.enum(['agent', 'user', 'artifact']);

export const MentionSchema = z.object({
  entityType: MentionEntityTypeSchema,
  entityId: z.string().min(1),
  label: z.string().min(1).max(255),
  // Optional artifact type carried only for entityType='artifact' mentions,
  // so the UI can render the correct ThreadArtifactCard icon/label without
  // an extra fetch. Ignored for agent/user mentions.
  artifactType: z.string().min(1).optional(),
});

export const MentionsSchema = z.array(MentionSchema).default([]);

export type Mention = z.infer<typeof MentionSchema>;
export type MentionEntityType = z.infer<typeof MentionEntityTypeSchema>;

// ---------------------------------------------------------------------------
// Mentionable entity (for picker UI)
// ---------------------------------------------------------------------------

export const MentionableEntitySchema = z.object({
  entityType: MentionEntityTypeSchema,
  entityId: z.string().min(1),
  label: z.string().min(1).max(255),
  subtitle: z.string().optional(),
  // Artifact type label, only present for entityType='artifact' results.
  artifactType: z.string().min(1).optional(),
});

export type MentionableEntity = z.infer<typeof MentionableEntitySchema>;
