import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MessageType = {
  TaskUpdate: 'task_update',
  Request: 'request',
  Response: 'response',
  Escalation: 'escalation',
  Notification: 'notification',
  Report: 'report',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const MessageTypeEnum = z.enum([
  'task_update',
  'request',
  'response',
  'escalation',
  'notification',
  'report',
]);

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  type: MessageType;
  subject: string;
  content: string;
  metadata: Record<string, unknown>;
  threadId: string | null;
  parentMessageId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const MessageSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  fromAgentId: z.string().uuid(),
  toAgentId: z.string().uuid(),
  type: MessageTypeEnum,
  subject: z.string().min(1).max(500),
  content: z.string().min(1).max(100_000),
  metadata: z.record(z.unknown()).default({}),
  threadId: z.string().uuid().nullable(),
  parentMessageId: z.string().uuid().nullable(),
  readAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateMessageInputSchema = z.object({
  companyId: z.string().uuid(),
  fromAgentId: z.string().uuid(),
  toAgentId: z.string().uuid(),
  type: MessageTypeEnum,
  subject: z.string().min(1).max(500),
  content: z.string().min(1).max(100_000),
  metadata: z.record(z.unknown()).default({}),
  threadId: z.string().uuid().nullable().default(null),
  parentMessageId: z.string().uuid().nullable().default(null),
});

export type CreateMessageInput = z.infer<typeof CreateMessageInputSchema>;
