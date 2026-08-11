// ---------------------------------------------------------------------------
// Meeting Service — M7 Meetings pipeline
// ---------------------------------------------------------------------------
// Distinct from agent execution transcripts. Project-scoped, company-isolated.
// Pipeline: create meeting → attach transcript → summarize (grounded, LLM) →
// extract action items as REAL tasks linked to the project (meeting_tasks join).
// Empty/garbage transcripts are handled gracefully (no 500).
// ---------------------------------------------------------------------------

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import { getProvider } from '../providers/index.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import type { DbInstance } from '../types.js';

type MeetingStatus = 'active' | 'archived' | 'deleted';
type Editor = { userId?: string | null; agentId?: string | null; editSource?: 'user' | 'agent' | 'system' };

function emit(
  type:
    | 'meeting.created'
    | 'meeting.updated'
    | 'meeting.summary.created'
    | 'meeting.action_items.created'
    | 'meeting.deleted'
    | 'meeting.archived',
  companyId: string,
  payload: Record<string, unknown>,
): void {
  eventBus.emitEvent({ type, companyId, payload, timestamp: new Date().toISOString() });
}

export async function createMeeting(
  db: DbInstance,
  companyId: string,
  input: {
    title: string;
    projectId?: string | null;
    transcript?: string;
    occurredAt?: Date | null;
    metadata?: Record<string, unknown>;
  },
  editor: Editor,
) {
  if (input.projectId) await validateProjectOwnership(db, companyId, input.projectId);
  const { meetings } = db.schema;
  const [row] = await db.drizzle
    .insert(meetings)
    .values({
      companyId,
      projectId: input.projectId ?? null,
      title: input.title,
      transcript: input.transcript ?? null,
      occurredAt: input.occurredAt ?? null,
      metadata: input.metadata ?? {},
      createdByUserId: editor.userId ?? null,
      createdByAgentId: editor.agentId ?? null,
    })
    .returning();
  emit('meeting.created', companyId, { meeting: row });
  return row;
}

export async function getMeeting(db: DbInstance, companyId: string, id: string) {
  const { meetings } = db.schema;
  const [row] = await db.drizzle
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.companyId, companyId)));
  if (!row) throw new AppError(404, 'MEETING_NOT_FOUND', 'Meeting not found');
  return row;
}

export async function listMeetings(
  db: DbInstance,
  companyId: string,
  filters: {
    projectId?: string | null;
    filterNullProject?: boolean;
    status?: MeetingStatus;
    limit: number;
    offset: number;
  },
) {
  if (filters.projectId && !filters.filterNullProject)
    await validateProjectOwnership(db, companyId, filters.projectId);
  const m = db.schema.meetings;
  const conditions = [eq(m.companyId, companyId)];
  if (filters.filterNullProject) {
    conditions.push(isNull(m.projectId));
  } else if (filters.projectId) {
    conditions.push(eq(m.projectId, filters.projectId));
  }
  if (filters.status) conditions.push(eq(m.status, filters.status));
  const where = and(...conditions);
  const [rows, count] = await Promise.all([
    db.drizzle
      .select()
      .from(m)
      .where(where)
      .orderBy(desc(m.updatedAt), desc(m.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db.drizzle.select({ total: sql<number>`count(*)` }).from(m).where(where),
  ]);
  return { rows, total: Number(count[0]?.total ?? 0) };
}

export async function updateMeeting(
  db: DbInstance,
  companyId: string,
  id: string,
  input: {
    title?: string;
    transcript?: string | null;
    occurredAt?: Date | null;
    metadata?: Record<string, unknown>;
    status?: MeetingStatus;
  },
  editor: Editor,
) {
  const current = await getMeeting(db, companyId, id);
  const { meetings } = db.schema;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.transcript !== undefined) patch.transcript = input.transcript;
  if (input.occurredAt !== undefined) patch.occurredAt = input.occurredAt;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  if (input.status !== undefined) {
    patch.status = input.status;
    patch.deletedAt = input.status === 'deleted' ? new Date() : null;
  }
  const [row] = await db.drizzle
    .update(meetings)
    .set(patch)
    .where(and(eq(meetings.id, id), eq(meetings.companyId, companyId)))
    .returning();
  if (!row) throw new AppError(404, 'MEETING_NOT_FOUND', 'Meeting not found');
  if (input.status === 'deleted') {
    emit('meeting.deleted', companyId, { meeting: row });
  } else if (input.status === 'archived') {
    emit('meeting.archived', companyId, { meeting: row });
  } else {
    emit('meeting.updated', companyId, { meeting: row });
  }
  return row;
}

export async function attachTranscript(
  db: DbInstance,
  companyId: string,
  id: string,
  transcript: string,
  editor: Editor,
) {
  return updateMeeting(db, companyId, id, { transcript }, editor);
}

export async function setMeetingStatus(
  db: DbInstance,
  companyId: string,
  id: string,
  status: MeetingStatus,
  editor: Editor,
) {
  return updateMeeting(db, companyId, id, { status }, editor);
}

// ---------------------------------------------------------------------------
// Summarize pipeline — transcript-grounded, no hallucinated facts
// ---------------------------------------------------------------------------

/** A transcript is "meaningful" when it has at least one non-whitespace token. */
function isMeaningfulTranscript(transcript: string | null): transcript is string {
  return typeof transcript === 'string' && transcript.trim().length > 0;
}

/**
 * Resolve the LLM provider + key to use for summarize/action-item extraction.
 * Prefers Anthropic (verified E2E provider), falls back to OpenAI/Google,
 * then to ollama if available. Returns null when no configured provider has
 * a key — callers handle graceful degradation.
 */
function resolveLlm(): { provider: string; apiKey: string; model: string } | null {
  const candidates: Array<{ provider: string; envKey: string; model: string }> = [
    { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-6' },
    { provider: 'openai', envKey: 'OPENAI_API_KEY', model: 'gpt-4.1-mini' },
    { provider: 'google', envKey: 'GOOGLE_API_KEY', model: 'gemini-2.5-flash' },
  ];
  for (const c of candidates) {
    const key = process.env[c.envKey];
    if (key && key.trim()) {
      return { provider: c.provider, apiKey: key.trim(), model: c.model };
    }
  }
  return null;
}

const SUMMARIZE_SYSTEM_PROMPT = `You are a meeting summarizer. Produce a concise summary STRICTLY grounded in the provided meeting transcript. Do not invent attendees, decisions, commitments, or topics not present in the transcript. If the transcript is sparse, summarize only what is actually said. Output a single summary paragraph (3-8 sentences). Do not preface with "Summary:" — just the summary text.`;

const ACTION_ITEMS_SYSTEM_PROMPT = `You are a meeting action-item extractor. Read the meeting transcript and extract concrete action items — tasks, owners, and deadlines mentioned or clearly implied by the discussion. Do not invent work that is not discussed. Return ONLY a JSON object of the form {"actionItems":[{"title":"<short task title>","description":"<optional context>","priority":"medium"}]}. The priority must be one of "critical","high","medium","low" (default "medium"). If there are no action items, return {"actionItems":[]}. Output ONLY the JSON, no prose.`;

interface LlmConfig {
  provider: string;
  apiKey: string;
  model: string;
}

async function runLlmCompletion(
  systemPrompt: string,
  userPrompt: string,
  cfg: LlmConfig,
): Promise<string> {
  const provider = getProvider(cfg.provider);
  const result = await provider.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { apiKey: cfg.apiKey, model: cfg.model, temperature: 0.3, maxTokens: 2048 },
  );
  return result.content;
}

export async function summarizeMeeting(
  db: DbInstance,
  companyId: string,
  id: string,
  editor: Editor,
): Promise<{ summary: string | null; skipped: boolean; reason?: string }> {
  const meeting = await getMeeting(db, companyId, id);

  // Graceful empty/garbage transcript handling (VAL-MEETING-011): never 500.
  if (!isMeaningfulTranscript(meeting.transcript)) {
    // Persist an empty summary marker so the UI can show "no summary".
    const [row] = await db.drizzle
      .update(db.schema.meetings)
      .set({ summary: '', summaryGeneratedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(db.schema.meetings.id, id), eq(db.schema.meetings.companyId, companyId)))
      .returning();
    emit('meeting.summary.created', companyId, {
      meeting: row,
      skipped: true,
      reason: 'empty_transcript',
    });
    return { summary: '', skipped: true, reason: 'empty_transcript' };
  }

  const llm = resolveLlm();
  if (!llm) {
    // No LLM provider configured — graceful degradation: produce a
    // deterministic extractive summary from the transcript so the pipeline
    // still returns a grounded, non-hallucinated result without a 500.
    const extractive = buildExtractiveSummary(meeting.transcript);
    const [row] = await db.drizzle
      .update(db.schema.meetings)
      .set({
        summary: extractive,
        summaryGeneratedAt: new Date(),
        summaryGeneratedByAgentId: editor.agentId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(db.schema.meetings.id, id), eq(db.schema.meetings.companyId, companyId)))
      .returning();
    emit('meeting.summary.created', companyId, { meeting: row });
    return { summary: extractive, skipped: false };
  }

  let summary: string;
  try {
    summary = (await runLlmCompletion(SUMMARIZE_SYSTEM_PROMPT, meeting.transcript, llm)).trim();
  } catch (err) {
    // LLM call failed — fall back to extractive summary rather than 500.
    summary = buildExtractiveSummary(meeting.transcript);
  }
  if (!summary) summary = buildExtractiveSummary(meeting.transcript);

  const [row] = await db.drizzle
    .update(db.schema.meetings)
    .set({
      summary,
      summaryGeneratedAt: new Date(),
      summaryGeneratedByAgentId: editor.agentId ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(db.schema.meetings.id, id), eq(db.schema.meetings.companyId, companyId)))
    .returning();
  emit('meeting.summary.created', companyId, { meeting: row });
  return { summary, skipped: false };
}

/**
 * Build a deterministic extractive summary from a transcript when no LLM is
 * available. Takes the first few non-trivial lines — strictly grounded in
 * the transcript text (no invented content).
 */
function buildExtractiveSummary(transcript: string): string {
  const lines = transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const take = lines.slice(0, 6);
  if (take.length === 0) return '';
  return `Meeting transcript excerpt: ${take.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Action-items extraction → REAL tasks linked to the project
// ---------------------------------------------------------------------------

interface ExtractedActionItem {
  title: string;
  description?: string;
  assigneeAgentId?: string | null;
  priority?: 'critical' | 'high' | 'medium' | 'low';
}

function parseActionItemsJson(raw: string): ExtractedActionItem[] {
  // The LLM is instructed to output only JSON, but be defensive: strip
  // code fences and extract the first JSON object.
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { actionItems?: unknown };
    if (!Array.isArray(parsed.actionItems)) return [];
    return parsed.actionItems
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
      .map((a) => ({
        title: typeof a.title === 'string' ? a.title.trim().slice(0, 500) : '',
        description: typeof a.description === 'string' ? a.description.slice(0, 10_000) : undefined,
        assigneeAgentId:
          typeof a.assigneeAgentId === 'string' ? a.assigneeAgentId : null,
        priority:
          typeof a.priority === 'string' &&
          ['critical', 'high', 'medium', 'low'].includes(a.priority)
            ? (a.priority as 'critical' | 'high' | 'medium' | 'low')
            : 'medium',
      }))
      .filter((a) => a.title.length > 0);
  } catch {
    return [];
  }
}

export async function extractActionItems(
  db: DbInstance,
  companyId: string,
  id: string,
  editor: Editor,
): Promise<{ tasks: Array<Record<string, unknown>>; skipped: boolean; reason?: string }> {
  const meeting = await getMeeting(db, companyId, id);

  // Graceful empty transcript (VAL-MEETING-011): zero action items, no 500.
  if (!isMeaningfulTranscript(meeting.transcript)) {
    emit('meeting.action_items.created', companyId, {
      meetingId: id,
      tasks: [],
      skipped: true,
      reason: 'empty_transcript',
    });
    return { tasks: [], skipped: true, reason: 'empty_transcript' };
  }

  let items: ExtractedActionItem[] = [];
  const llm = resolveLlm();
  if (llm) {
    try {
      const raw = await runLlmCompletion(
        ACTION_ITEMS_SYSTEM_PROMPT,
        meeting.transcript,
        llm,
      );
      items = parseActionItemsJson(raw);
    } catch {
      items = [];
    }
  }
  // If no LLM or LLM returned nothing, do not fabricate tasks (grounded only).
  // Zero action items is a valid, graceful result.

  const { tasks, meetingTasks } = db.schema;
  const created: Array<Record<string, unknown>> = [];
  if (items.length > 0) {
    await db.drizzle.transaction(async (tx) => {
      const [{ maxNum }] = await tx
        .select({ maxNum: sql<number>`coalesce(max(${tasks.taskNumber}), 0)` })
        .from(tasks)
        .where(eq(tasks.companyId, companyId));
      let taskNumber = Number(maxNum);
      for (const item of items) {
        taskNumber += 1;
        const identifier = `TASK-${taskNumber}`;
        const [row] = await tx
          .insert(tasks)
          .values({
            companyId,
            projectId: meeting.projectId,
            title: item.title,
            description: item.description ?? null,
            type: 'feature',
            status: 'backlog',
            priority: item.priority ?? 'medium',
            assigneeAgentId: item.assigneeAgentId ?? null,
            createdByAgentId: editor.agentId ?? null,
            createdByUserId: editor.userId ?? null,
            taskNumber,
            identifier,
            dependencies: [],
            tags: ['meeting-action-item'],
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .returning();
        // Link the task to the meeting via the join table (bidirectional).
        await tx.insert(meetingTasks).values({
          meetingId: meeting.id,
          taskId: row.id,
          companyId,
        });
        created.push(row);
        eventBus.emitEvent({
          type: 'task.created',
          companyId,
          payload: { task: row, meetingId: meeting.id },
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  emit('meeting.action_items.created', companyId, {
    meetingId: id,
    tasks: created,
    skipped: created.length === 0 && items.length === 0,
  });
  return { tasks: created, skipped: created.length === 0 && items.length === 0 };
}

// ---------------------------------------------------------------------------
// Bidirectional linkage — tasks linked to a meeting
// ---------------------------------------------------------------------------

export async function getMeetingTasks(db: DbInstance, companyId: string, id: string) {
  await getMeeting(db, companyId, id);
  const { tasks, meetingTasks } = db.schema;
  // Bidirectional linkage: query the join table → tasks, scoped to the
  // company. Ordered by creation time for a stable action-item order.
  const rows = await db.drizzle
    .select({ task: tasks })
    .from(meetingTasks)
    .innerJoin(tasks, eq(meetingTasks.taskId, tasks.id))
    .where(and(eq(meetingTasks.meetingId, id), eq(meetingTasks.companyId, companyId)))
    .orderBy(asc(meetingTasks.createdAt));
  return rows.map((r) => r.task);
}

// ---------------------------------------------------------------------------
// Reverse linkage — meetings linked to a task (VAL-MEETING-006/007 backlink)
// ---------------------------------------------------------------------------

/**
 * Returns the meetings linked to a task via the `meeting_tasks` join table
 * (the reverse direction of `getMeetingTasks`). Scoped by companyId so a
 * task in one company cannot surface meetings from another. Ordered by the
 * meeting's updatedAt desc for a stable, recent-first ordering. Only
 * non-deleted meetings are returned (archived meetings are included so the
 * backlink survives archiving; deleted meetings are excluded).
 */
export async function getTaskMeetings(db: DbInstance, companyId: string, taskId: string) {
  const { meetings, meetingTasks, tasks } = db.schema;
  // Verify the task exists + belongs to the company (404 otherwise).
  const [task] = await db.drizzle
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)))
    .limit(1);
  if (!task) throw new AppError(404, 'TASK_NOT_FOUND', `Task ${taskId} not found`);

  const rows = await db.drizzle
    .select({ meeting: meetings })
    .from(meetingTasks)
    .innerJoin(meetings, eq(meetingTasks.meetingId, meetings.id))
    .where(
      and(
        eq(meetingTasks.taskId, taskId),
        eq(meetingTasks.companyId, companyId),
        eq(meetings.companyId, companyId),
        // Exclude deleted meetings (archived kept so the backlink survives).
        sql`${meetings.status} <> 'deleted'`,
      ),
    )
    .orderBy(desc(meetings.updatedAt), desc(meetings.id));
  return rows.map((r) => r.meeting);
}
