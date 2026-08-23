import { and, asc, eq, gt, or, inArray } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * Question and answer history: scoped, bounded, restart-stable reads of
 * the immutable question-set, question-definition, and answer ledgers
 * (VAL-MODEQ-148).
 *
 * The declared `GET .../question-sets?limit=&cursor=` route returns at most
 * 50 sets ordered by `(ordinal ASC, id ASC)` with opaque keyset cursors.
 * Each entry includes immutable definitions, set version/state, accepted
 * answer revision/hash, actor, and timestamps.
 *
 * Role-based read contract:
 * - Owner/admin/member with project content access (`content.create`) may
 *   read safe exact answer values.
 * - Viewers (`company.view` only) receive definitions and sanitized answer
 *   metadata only — answer values are redacted to `{ redacted: true }`.
 * - Agents require an explicit Mission-answer-history scope (checked at the
 *   route layer via actor type).
 *
 * Cross-scope IDs return 404 and never reveal existence. Ordering survives
 * restart because it is derived from persisted `ordinal` and `id` columns.
 */

/** Maximum question sets returned per page (VAL-MODEQ-148). */
export const MAX_QUESTION_SETS_PER_PAGE = 50;

/** A question definition in a history entry. */
export interface QuestionDefinitionEntry {
  id: string;
  questionKey: string;
  order: number;
  type: string;
  label: string;
  help: string | null;
  required: boolean;
  default: unknown;
  options: unknown[] | null;
  validation: Record<string, unknown> | null;
}

/** An accepted answer in a history entry. */
export interface AnswerEntry {
  id: string;
  questionKey: string;
  answerRevision: number;
  /**
   * The canonical validated answer value, or a redacted placeholder
   * `{ redacted: true }` when the caller lacks content access (viewers).
   */
  value: unknown;
  contentHash: string;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

/** A question-set history entry. */
export interface QuestionSetHistoryEntry {
  id: string;
  ordinal: number;
  version: number;
  status: string;
  invalidationReason: string | null;
  promptContextHash: string | null;
  createdAt: string;
  answeredAt: string | null;
  invalidatedAt: string | null;
  questions: QuestionDefinitionEntry[];
  answers: AnswerEntry[];
}

export interface QuestionSetHistoryResult {
  questionSets: QuestionSetHistoryEntry[];
  nextCursor: string | null;
}

export interface QuestionSetHistoryInput {
  companyId: string;
  projectId: string;
  runId: string;
  limit: number;
  cursor?: string;
  /**
   * When true, exact answer values are included. When false (viewers),
   * answer values are redacted to `{ redacted: true }`.
   */
  includeAnswerValues: boolean;
}

/**
 * Decode an opaque keyset cursor for question-set history. The cursor is
 * base64url-encoded JSON `{ o: ordinal, i: id }` anchoring the last row of
 * the previous page. Returns null for an absent cursor. Throws
 * AppError(400) for malformed input.
 */
export function decodeQuestionSetCursor(
  cursor: string | undefined,
): { ordinal: number; id: string } | null {
  if (cursor === undefined || cursor === null || cursor === '') {
    return null;
  }
  let json: string;
  try {
    const normalized = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    json = Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { o?: unknown }).o !== 'number' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
  }
  const obj = parsed as { o: number; i: string };
  return { ordinal: obj.o, id: obj.i };
}

/** Encode a keyset cursor from the last row of a page. */
export function encodeQuestionSetCursor(ordinal: number, id: string): string {
  const json = JSON.stringify({ o: ordinal, i: id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export class MissionQuestionSetHistoryService {
  constructor(private db: DbInstance) {}

  /**
   * List question-set history for a run, scoped to the given
   * company/project. Returns at most `limit` entries ordered by
   * `(ordinal ASC, id ASC)` with an opaque keyset cursor for the next
   * page. Throws 404 RUN_NOT_FOUND for an absent or cross-scope run id.
   */
  async listQuestionSets(input: QuestionSetHistoryInput): Promise<QuestionSetHistoryResult> {
    const { companyId, projectId, runId, limit, cursor, includeAnswerValues } = input;
    const schema = this.db.schema;

    // 1. Verify the run exists in scope (non-enumerating 404).
    const [run] = await this.db.drizzle
      .select({ id: schema.missionRuns.id })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.id, runId),
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
        ),
      )
      .limit(1);
    if (!run) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    // 2. Build the keyset query.
    const anchor = decodeQuestionSetCursor(cursor);
    const fetchLimit = limit + 1;

    const conditions = [
      eq(schema.runQuestionSets.companyId, companyId),
      eq(schema.runQuestionSets.projectId, projectId),
      eq(schema.runQuestionSets.runId, runId),
    ];
    if (anchor) {
      // Keyset: rows strictly after the anchor in (ordinal ASC, id ASC).
      const cursorCondition = or(
        gt(schema.runQuestionSets.ordinal, anchor.ordinal),
        and(
          eq(schema.runQuestionSets.ordinal, anchor.ordinal),
          gt(schema.runQuestionSets.id, anchor.id),
        ),
      );
      conditions.push(cursorCondition!);
    }

    const setRows = await this.db.drizzle
      .select()
      .from(schema.runQuestionSets)
      .where(and(...conditions))
      .orderBy(asc(schema.runQuestionSets.ordinal), asc(schema.runQuestionSets.id))
      .limit(fetchLimit);

    const hasMore = setRows.length > limit;
    const page = hasMore ? setRows.slice(0, limit) : setRows;

    // 3. Fetch questions and answers for each set in the page.
    // setIds is non-empty here because page is non-empty when we reach
    // this block (fetchLimit = limit + 1 >= 2, and an empty run would
    // return an empty page with hasMore=false).
    const setIds = page.map((s) => s.id);
    const questionsBySet = new Map<string, QuestionDefinitionEntry[]>();
    const answersBySet = new Map<string, AnswerEntry[]>();
    if (setIds.length > 0) {
      const questionRows = await this.db.drizzle
        .select()
        .from(schema.runQuestions)
        .where(
          and(
            eq(schema.runQuestions.companyId, companyId),
            inArray(schema.runQuestions.questionSetId, setIds),
          ),
        )
        .orderBy(asc(schema.runQuestions.order));
      for (const q of questionRows) {
        const arr = questionsBySet.get(q.questionSetId) ?? [];
        arr.push({
          id: q.id,
          questionKey: q.questionKey,
          order: q.order,
          type: q.type,
          label: q.label,
          help: q.help,
          required: q.required === 1,
          default: q.defaultValue,
          options: q.options,
          validation: q.validation,
        });
        questionsBySet.set(q.questionSetId, arr);
      }

      const answerRows = await this.db.drizzle
        .select()
        .from(schema.runQuestionAnswers)
        .where(
          and(
            eq(schema.runQuestionAnswers.companyId, companyId),
            inArray(schema.runQuestionAnswers.questionSetId, setIds),
          ),
        )
        .orderBy(
          asc(schema.runQuestionAnswers.questionKey),
          asc(schema.runQuestionAnswers.answerRevision),
        );
      for (const a of answerRows) {
        const arr = answersBySet.get(a.questionSetId) ?? [];
        arr.push({
          id: a.id,
          questionKey: a.questionKey,
          answerRevision: a.answerRevision,
          value: includeAnswerValues ? a.value : { redacted: true },
          contentHash: a.contentHash,
          actorType: a.actorType,
          actorId: a.actorId,
          createdAt: a.createdAt.toISOString(),
        });
        answersBySet.set(a.questionSetId, arr);
      }
    }

    const questionSets: QuestionSetHistoryEntry[] = page.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      version: s.version,
      status: s.status,
      invalidationReason: s.invalidationReason,
      promptContextHash: s.promptContextHash,
      createdAt: s.createdAt.toISOString(),
      answeredAt: s.answeredAt ? s.answeredAt.toISOString() : null,
      invalidatedAt: s.invalidatedAt ? s.invalidatedAt.toISOString() : null,
      questions: questionsBySet.get(s.id) ?? [],
      answers: answersBySet.get(s.id) ?? [],
    }));

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeQuestionSetCursor(last.ordinal, last.id);
    }

    return { questionSets, nextCursor };
  }
}
