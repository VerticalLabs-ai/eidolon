import { z } from 'zod';

// ---------------------------------------------------------------------------
// M7 — Meetings shared Zod schemas
// ---------------------------------------------------------------------------
// A meeting is a first-class entity distinct from agent execution transcripts.
// It is project-scoped + company-isolated, carries a transcript, a
// transcript-grounded summary, and action items that become real tasks.

export const MeetingStatusSchema = z.enum(['active', 'archived', 'deleted']);
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;

export const MeetingSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  projectId: z.string().nullable(),
  title: z.string(),
  transcript: z.string().nullable(),
  summary: z.string().nullable(),
  summaryGeneratedAt: z.string().nullable(),
  summaryGeneratedByAgentId: z.string().nullable(),
  occurredAt: z.string().nullable(),
  status: MeetingStatusSchema,
  createdByUserId: z.string().nullable(),
  createdByAgentId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
export type Meeting = z.infer<typeof MeetingSchema>;

export const CreateMeetingBodySchema = z.object({
  title: z.string().trim().min(1).max(500),
  projectId: z.string().uuid().nullable().optional(),
  transcript: z.string().max(500_000).optional(),
  occurredAt: z.coerce.date().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateMeetingBody = z.infer<typeof CreateMeetingBodySchema>;

export const UpdateMeetingBodySchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  transcript: z.string().max(500_000).nullable().optional(),
  occurredAt: z.coerce.date().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: MeetingStatusSchema.optional(),
});
export type UpdateMeetingBody = z.infer<typeof UpdateMeetingBodySchema>;

export const AttachTranscriptBodySchema = z.object({
  transcript: z.string().max(500_000),
});
export type AttachTranscriptBody = z.infer<typeof AttachTranscriptBodySchema>;

export const MeetingListQuerySchema = z.object({
  projectId: z.union([z.string().uuid(), z.literal('null')]).optional(),
  unscoped: z.coerce.boolean().optional(),
  status: MeetingStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type MeetingListQuery = z.infer<typeof MeetingListQuerySchema>;

// ---------------------------------------------------------------------------
// Action item (extracted from transcript → becomes a real task)
// ---------------------------------------------------------------------------

export const ActionItemSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

/** Shape returned by the LLM action-item extraction (parsed from JSON). */
export const ActionItemsResultSchema = z.object({
  actionItems: z.array(ActionItemSchema),
});
export type ActionItemsResult = z.infer<typeof ActionItemsResultSchema>;
