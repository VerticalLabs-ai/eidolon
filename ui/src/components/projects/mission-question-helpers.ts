/**
 * Pure helpers shared by the typed Mission question card and its reviewable
 * history. Kept separate from the components so each module stays focused
 * and within the repository's file-size guidance.
 */
import type { MissionQuestionDefinition, MissionHistoryAnswer } from '@/lib/api';

/** Generate a stable idempotency key for one logical answer submission.
 * Retained across recoverable retries so a lost response replays the
 * identical logical command (Normative Boundary 2 / VAL-MODEQ-133). */
export function makeAnswerIdempotencyKey(runId: string, setId: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `answer-${runId}-${setId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A draft value for a single question, keyed by question key. */
export type DraftMap = Record<string, unknown>;

/** Field-level server validation errors keyed by question key. */
export type FieldErrors = Record<string, string>;

/** Coerce a question definition's `default` into the right draft shape. */
export function defaultDraftFor(q: MissionQuestionDefinition): unknown {
  if (q.default === null || q.default === undefined) {
    switch (q.type) {
      case 'multiple_choice':
        return [];
      case 'ordering': {
        const opts = asOptions(q.options);
        return opts.map((o) => o.key);
      }
      default:
        return undefined;
    }
  }
  return q.default;
}

/** Whether a draft value differs from the persisted default. */
export function draftDiffersFromDefault(q: MissionQuestionDefinition, value: unknown): boolean {
  const def = defaultDraftFor(q);
  if (Array.isArray(def) || Array.isArray(value)) {
    const a = Array.isArray(def) ? def : [];
    const b = Array.isArray(value) ? value : [];
    if (a.length !== b.length) {
      return true;
    }
    return a.some((v, i) => v !== b[i]);
  }
  return def !== value;
}

/** Cast an option list to the typed shape. */
export function asOptions(options: unknown[] | null): Array<{ key: string; label: string }> {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .filter(
      (o): o is { key: string; label: string } =>
        typeof o === 'object' &&
        o !== null &&
        typeof (o as { key?: unknown }).key === 'string' &&
        typeof (o as { label?: unknown }).label === 'string',
    )
    .map((o) => ({ key: o.key, label: o.label }));
}

export function asScaleValidation(
  v: Record<string, unknown> | null,
): { min: number; max: number; step?: number; minLabel?: string; maxLabel?: string } | null {
  if (!v || typeof v.min !== 'number' || typeof v.max !== 'number') {
    return null;
  }
  return {
    min: v.min,
    max: v.max,
    step: typeof v.step === 'number' ? v.step : undefined,
    minLabel: typeof v.minLabel === 'string' ? v.minLabel : undefined,
    maxLabel: typeof v.maxLabel === 'string' ? v.maxLabel : undefined,
  };
}

export function asNumberValidation(
  v: Record<string, unknown> | null,
): { min?: number; max?: number; step?: number } | null {
  if (!v) {
    return null;
  }
  return {
    min: typeof v.min === 'number' ? v.min : undefined,
    max: typeof v.max === 'number' ? v.max : undefined,
    step: typeof v.step === 'number' ? v.step : undefined,
  };
}

export function asTextValidation(
  v: Record<string, unknown> | null,
): { minLength?: number; maxLength?: number; pattern?: string } | null {
  if (!v) {
    return null;
  }
  return {
    minLength: typeof v.minLength === 'number' ? v.minLength : undefined,
    maxLength: typeof v.maxLength === 'number' ? v.maxLength : undefined,
    pattern: typeof v.pattern === 'string' ? v.pattern : undefined,
  };
}

export function asChoiceValidation(
  v: Record<string, unknown> | null,
): { minSelections?: number; maxSelections?: number } | null {
  if (!v) {
    return null;
  }
  return {
    minSelections: typeof v.minSelections === 'number' ? v.minSelections : undefined,
    maxSelections: typeof v.maxSelections === 'number' ? v.maxSelections : undefined,
  };
}

/** Format an accepted answer value for read-only history display. For
 * choice/ordering questions, resolve option keys to their human-readable
 * labels using the immutable question definition so the reviewable record
 * is meaningful (VAL-MODEQ-110). */
export function formatAnswerValue(value: unknown, question?: MissionQuestionDefinition): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    if (question && (question.type === 'single_choice' || question.type === 'ordering')) {
      const opts = asOptions(question.options);
      const found = opts.find((o) => o.key === value);
      if (found) {
        return found.label;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (question && (question.type === 'multiple_choice' || question.type === 'ordering')) {
      const opts = asOptions(question.options);
      return value
        .map((v) => {
          const found = opts.find((o) => o.key === v);
          return found ? found.label : formatAnswerValue(v);
        })
        .join(', ');
    }
    return value.map((v) => formatAnswerValue(v)).join(', ');
  }
  if (typeof value === 'object' && value !== null && 'redacted' in value) {
    return 'Restricted';
  }
  return String(value);
}

/** Map a question key to its latest accepted answer in a history entry. */
export function answerForKey(
  answers: MissionHistoryAnswer[],
  questionKey: string,
): MissionHistoryAnswer | undefined {
  let latest: MissionHistoryAnswer | undefined;
  for (const a of answers) {
    if (a.questionKey === questionKey) {
      latest = a;
    }
  }
  return latest;
}

/** Shared input control classes. */
export function controlClasses(hasError: boolean): string {
  return `w-full rounded-lg border bg-surface px-3 py-1.5 text-sm text-text-primary focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none ${
    hasError
      ? 'border-error/40 focus-visible:ring-error/40'
      : 'border-white/[0.1] focus-visible:ring-accent/40'
  }`;
}

/** Map server `ANSWER_VALIDATION_FAILED` details into field-keyed errors.
 * Accepts either string messages or arrays of string messages per key. */
export function mapAnswerValidationDetails(details: unknown): FieldErrors {
  const mapped: FieldErrors = {};
  if (details && typeof details === 'object') {
    for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
      if (typeof v === 'string') {
        mapped[k] = v;
      } else if (Array.isArray(v)) {
        const joined = v.filter((x) => typeof x === 'string').join(' ');
        if (joined) {
          mapped[k] = joined;
        }
      }
    }
  }
  return mapped;
}
