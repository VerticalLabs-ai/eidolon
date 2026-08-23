import { z } from 'zod';

/**
 * Closed, bounded Zod schemas for every Mission question and answer type.
 *
 * (VAL-MODEQ-046–050, VAL-MODEQ-052, VAL-MODEQ-136)
 *
 * Supported question types and their canonical answer shapes:
 * - `boolean`        → `boolean` (false is distinct from unanswered)
 * - `single_choice`  → one listed option key
 * - `multiple_choice`→ unique array of listed option keys within min/max
 * - `text`           → string within min/max code-point length, optional safe pattern
 * - `number`         → finite number within inclusive [min,max] aligned to step
 * - `scale`          → finite number within labelled [min,max] aligned to positive step
 * - `ordering`       → array containing every listed option key exactly once
 *
 * The definition schemas are discriminated unions with `.strict()` per-type
 * validation objects, so unknown types and unknown validation properties are
 * rejected. Every configured default must pass the same answer validator as a
 * submitted answer. This module owns only the closed schema/contract layer;
 * publication, atomic answer submission, cardinality caps, content
 * canonicalization, and persistence are owned by later features.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Count Unicode code points (not UTF-16 code units). */
function codepointCount(s: string): number {
  return [...s].length;
}

function codepointRange(min: number, max: number) {
  return (s: string) => {
    const n = codepointCount(s);
    return n >= min && n <= max;
  };
}

/**
 * Reject Unicode control characters and BiDi override/embedding controls
 * that could cause deceptive rendering or injection. Allows TAB/LF/CR as
 * legitimate formatting characters.
 */
/* eslint-disable no-control-regex, no-misleading-character-class */
const UNSAFE_CODEPOINT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B\u200C\u200D\uFEFF]/;
/* eslint-enable no-control-regex, no-misleading-character-class */

function rejectUnsafeControls(s: string): boolean {
  return !UNSAFE_CODEPOINT_RE.test(s);
}

/**
 * Option/question key: 1–128 printable ASCII characters. Restricted to
 * printable ASCII (0x21–0x7E) so keys are safe for URLs, JSON, and
 * deterministic comparison without normalization ambiguity.
 */
export const QuestionKey = z
  .string()
  .regex(/^[\x21-\x7E]{1,128}$/, 'Key must be 1–128 printable ASCII characters');

/** Question label: 1–500 Unicode code points, no unsafe controls. */
export const QuestionLabel = z
  .string()
  .refine(codepointRange(1, 500), 'Label must be 1–500 Unicode code points')
  .refine(rejectUnsafeControls, 'Label must not contain control or BiDi override characters');

/** Option label: 1–500 Unicode code points, no unsafe controls. */
export const OptionLabel = z
  .string()
  .refine(codepointRange(1, 500), 'Option label must be 1–500 Unicode code points')
  .refine(
    rejectUnsafeControls,
    'Option label must not contain control or BiDi override characters',
  );

/** Help text: 0–2,000 Unicode code points, no unsafe controls. */
export const HelpText = z
  .string()
  .refine(codepointRange(0, 2000), 'Help text must be at most 2,000 Unicode code points')
  .refine(rejectUnsafeControls, 'Help text must not contain control or BiDi override characters')
  .optional();

/** Scale endpoint label: 0–500 Unicode code points, no unsafe controls. */
export const ScaleEndpointLabel = z
  .string()
  .refine(codepointRange(0, 500), 'Scale endpoint label must be at most 500 Unicode code points')
  .refine(
    rejectUnsafeControls,
    'Scale endpoint label must not contain control or BiDi override characters',
  )
  .optional();

/** A listed option for choice/ordering questions. */
export const OptionDefinition = z
  .object({
    key: QuestionKey,
    label: OptionLabel,
  })
  .strict();

/** Finite number (rejects NaN, Infinity, -Infinity). */
const FiniteNumber = z.number().finite('Value must be a finite number');

/** Positive finite number (for step). */
const PositiveFiniteNumber = z
  .number()
  .finite('Step must be a finite number')
  .positive('Step must be positive');

/** Nonnegative integer (for selection bounds / lengths). */
const NonNegInt = z
  .number()
  .int('Value must be an integer')
  .nonnegative('Value must be nonnegative');

// ---------------------------------------------------------------------------
// Question type discriminator
// ---------------------------------------------------------------------------

export const QuestionType = z.enum([
  'boolean',
  'single_choice',
  'multiple_choice',
  'text',
  'number',
  'scale',
  'ordering',
]);

export type QuestionTypeValue = z.infer<typeof QuestionType>;

// ---------------------------------------------------------------------------
// Per-type definition schemas (plain strict objects for discriminated union)
// ---------------------------------------------------------------------------

/**
 * Common fields present on every question definition. `required` defaults to
 * false; `default` is validated against the answer validator when present.
 * These are merged into each per-type schema via `.extend()` so the
 * discriminated union operates on full ZodObjects.
 */
const CommonQuestionFields = {
  questionKey: QuestionKey,
  order: z.number().int().nonnegative(),
  label: QuestionLabel,
  help: HelpText,
  required: z.boolean().default(false),
  default: z.unknown().optional(),
};

/** Boolean question definition. No options or numeric validation. */
const BooleanQuestionDef = z
  .object({
    type: z.literal('boolean'),
    options: z.undefined().optional(),
    validation: z.undefined().optional(),
  })
  .strict()
  .extend(CommonQuestionFields);

/** Single-choice question definition. Requires ≥ 2 listed options. */
const SingleChoiceQuestionDef = z
  .object({
    type: z.literal('single_choice'),
    options: z.array(OptionDefinition).min(2, 'Single-choice requires at least 2 options'),
    validation: z.undefined().optional(),
  })
  .strict()
  .extend(CommonQuestionFields);

/** Multiple-choice question definition with selection bounds. */
const MultipleChoiceQuestionDef = z
  .object({
    type: z.literal('multiple_choice'),
    options: z.array(OptionDefinition).min(2, 'Multiple-choice requires at least 2 options'),
    validation: z
      .object({
        minSelections: NonNegInt.optional(),
        maxSelections: NonNegInt.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .extend(CommonQuestionFields);

/** Text question definition with min/max code-point length and optional pattern. */
const TextQuestionDef = z
  .object({
    type: z.literal('text'),
    options: z.undefined().optional(),
    validation: z
      .object({
        minLength: NonNegInt.optional(),
        maxLength: NonNegInt.optional(),
        pattern: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .extend(CommonQuestionFields);

/** Number question definition with finite ordered bounds and positive step. */
const NumberQuestionDef = z
  .object({
    type: z.literal('number'),
    options: z.undefined().optional(),
    validation: z
      .object({
        min: FiniteNumber.optional(),
        max: FiniteNumber.optional(),
        step: PositiveFiniteNumber.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .extend(CommonQuestionFields);

/** Scale question definition with finite bounds, positive step, labels. */
const ScaleQuestionDef = z
  .object({
    type: z.literal('scale'),
    options: z.undefined().optional(),
    validation: z
      .object({
        min: FiniteNumber,
        max: FiniteNumber,
        step: PositiveFiniteNumber.optional(),
        minLabel: ScaleEndpointLabel,
        maxLabel: ScaleEndpointLabel,
      })
      .strict()
      .optional(),
  })
  .strict()
  .extend(CommonQuestionFields);

/** Ordering question definition. Requires ≥ 2 listed options. */
const OrderingQuestionDef = z
  .object({
    type: z.literal('ordering'),
    options: z.array(OptionDefinition).min(2, 'Ordering requires at least 2 options'),
    validation: z.undefined().optional(),
  })
  .strict()
  .extend(CommonQuestionFields);

/** Per-type definition union (discriminated by `type`). */
const TypeSpecificDef = z.discriminatedUnion('type', [
  BooleanQuestionDef,
  SingleChoiceQuestionDef,
  MultipleChoiceQuestionDef,
  TextQuestionDef,
  NumberQuestionDef,
  ScaleQuestionDef,
  OrderingQuestionDef,
]);

/**
 * Cross-field definition invariants per type. Extracted so the top-level
 * superRefine stays within cyclomatic-complexity limits.
 */

/** Validate unique option keys for choice/ordering definitions. */
function validateUniqueOptionKeys(options: { key: string }[], ctx: z.RefinementCtx): void {
  const keys = options.map((o) => o.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: 'Option keys must be unique',
    });
  }
}

/** Validate multiple-choice selection bounds are coherent and within options. */
function validateMultipleChoiceBounds(
  validation: { minSelections?: number; maxSelections?: number } | undefined,
  optionCount: number,
  ctx: z.RefinementCtx,
): void {
  const min = validation?.minSelections ?? 0;
  const max = validation?.maxSelections ?? optionCount;
  if (min > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validation', 'minSelections'],
      message: 'minSelections must not exceed maxSelections',
    });
  }
  if (max > optionCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validation', 'maxSelections'],
      message: 'maxSelections must not exceed the number of options',
    });
  }
  if (min > optionCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validation', 'minSelections'],
      message: 'minSelections must not exceed the number of options',
    });
  }
}

/** Validate text length bounds and pattern compilability. */
function validateTextDefinition(
  validation: { minLength?: number; maxLength?: number; pattern?: string } | undefined,
  ctx: z.RefinementCtx,
): void {
  const min = validation?.minLength ?? 0;
  const max = validation?.maxLength ?? 20_000;
  if (min > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validation', 'minLength'],
      message: 'minLength must not exceed maxLength',
    });
  }
  if (validation?.pattern !== undefined) {
    try {
      new RegExp(validation.pattern);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validation', 'pattern'],
        message: 'pattern must compile to a valid RegExp',
      });
    }
  }
}

/** Validate number definition ordered bounds. */
function validateNumberDefinition(
  validation: { min?: number; max?: number; step?: number } | undefined,
  ctx: z.RefinementCtx,
): void {
  const min = validation?.min;
  const max = validation?.max;
  if (min !== undefined && max !== undefined && min > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validation', 'min'],
      message: 'min must not exceed max',
    });
  }
}

/** Validate scale definition strictly-ordered bounds. */
function validateScaleDefinition(
  validation: { min: number; max: number } | undefined,
  ctx: z.RefinementCtx,
): void {
  if (validation !== undefined && validation.min >= validation.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validation', 'min'],
      message: 'scale min must be strictly less than max',
    });
  }
}

/** Dispatch cross-field definition validation by question type. */
function validateDefinitionCrossField(def: QuestionDefinition, ctx: z.RefinementCtx): void {
  switch (def.type) {
    case 'single_choice':
    case 'ordering': {
      validateUniqueOptionKeys(def.options, ctx);
      break;
    }
    case 'multiple_choice': {
      validateUniqueOptionKeys(def.options, ctx);
      validateMultipleChoiceBounds(def.validation, def.options.length, ctx);
      break;
    }
    case 'text': {
      validateTextDefinition(def.validation, ctx);
      break;
    }
    case 'number': {
      validateNumberDefinition(def.validation, ctx);
      break;
    }
    case 'scale': {
      validateScaleDefinition(def.validation, ctx);
      break;
    }
    case 'boolean':
    default:
      break;
  }
}

/**
 * Complete closed question definition schema.
 *
 * Discriminated by `type`; per-type validation objects are strict so unknown
 * validation properties are rejected. Cross-field definition invariants
 * (unique option keys, coherent selection bounds, ordered bounds, positive
 * step, scale strict ordering) and the default-passes-answer-validator rule
 * are enforced in the final superRefine (VAL-MODEQ-136).
 */
export const QuestionDefinition = TypeSpecificDef.superRefine((def, ctx) => {
  validateDefinitionCrossField(def, ctx);

  // Every default must pass the same answer validator (VAL-MODEQ-136).
  if (def.default !== undefined) {
    const result = validateAnswer(def, def.default);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: `default must pass the answer validator: ${result.error}`,
      });
    }
  }
});

export type QuestionDefinition = z.infer<typeof QuestionDefinition>;

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

/** Floating-point tolerance for step alignment. */
const STEP_EPSILON = 1e-9;

/** True when `v` is aligned to `step` from `min` within tolerance. */
function alignedToStep(v: number, min: number, step: number): boolean {
  const quotient = (v - min) / step;
  const rounded = Math.round(quotient);
  return Math.abs(quotient - rounded) <= STEP_EPSILON;
}

export interface AnswerValidationResult {
  success: boolean;
  /** Present when `success` is false. */
  error?: string;
  /** The validated, canonical answer value when `success` is true. */
  value?: unknown;
}

/**
 * Validate a raw answer value against a closed question definition.
 *
 * This is the single answer validator used for both submitted answers and
 * configured defaults (VAL-MODEQ-136). It enforces the canonical value shape
 * for every supported type:
 *
 * - `boolean`: rejects strings, numbers, null; false is valid and distinct
 *   from omitted/undefined.
 * - `single_choice`: exactly one listed option key; rejects labels, unknown
 *   keys, multiple keys, non-strings.
 * - `multiple_choice`: unique array of listed option keys within min/max.
 * - `text`: string within min/max code-point length, optional pattern.
 * - `number`/`scale`: finite number within [min,max] aligned to step; rejects
 *   numeric strings, NaN/infinity, out-of-range, step mismatches.
 * - `ordering`: array containing every listed option key exactly once.
 *
 * `undefined` is treated as "not answered"; required questions reject it.
 */
export function validateAnswer(question: QuestionDefinition, raw: unknown): AnswerValidationResult {
  if (raw === undefined || raw === null) {
    if (question.required) {
      return { success: false, error: 'answer is required' };
    }
    // Optional and omitted: valid (no value).
    return { success: true, value: undefined };
  }

  switch (question.type) {
    case 'boolean':
      return validateBooleanAnswer(raw);
    case 'single_choice':
      return validateSingleChoiceAnswer(raw, question.options);
    case 'multiple_choice':
      return validateMultipleChoiceAnswer(raw, question.options, question.validation);
    case 'text':
      return validateTextAnswer(raw, question.validation);
    case 'number':
      return validateNumberAnswer(raw, question.validation);
    case 'scale':
      return validateNumberAnswer(raw, question.validation);
    case 'ordering':
      return validateOrderingAnswer(raw, question.options);
    default:
      // Exhaustive guard: unknown types are rejected by the definition schema.
      return { success: false, error: 'unsupported question type' };
  }
}

/** Boolean answer: true or false; rejects every other shape. */
function validateBooleanAnswer(raw: unknown): AnswerValidationResult {
  if (typeof raw !== 'boolean') {
    return { success: false, error: 'boolean answer must be true or false' };
  }
  return { success: true, value: raw };
}

/** Single-choice answer: exactly one listed option key. */
function validateSingleChoiceAnswer(
  raw: unknown,
  options: { key: string }[],
): AnswerValidationResult {
  if (typeof raw !== 'string') {
    return { success: false, error: 'single-choice answer must be a string option key' };
  }
  if (!options.some((o) => o.key === raw)) {
    return { success: false, error: 'single-choice answer must be a listed option key' };
  }
  return { success: true, value: raw };
}

/** Multiple-choice answer: unique array of listed option keys within bounds. */
function validateMultipleChoiceAnswer(
  raw: unknown,
  options: { key: string }[],
  validation: { minSelections?: number; maxSelections?: number } | undefined,
): AnswerValidationResult {
  if (!Array.isArray(raw)) {
    return { success: false, error: 'multiple-choice answer must be an array' };
  }
  const keySet = new Set(options.map((o) => o.key));
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { success: false, error: 'multiple-choice answer must contain only option keys' };
    }
    if (!keySet.has(item)) {
      return { success: false, error: 'multiple-choice answer contains an unknown option key' };
    }
  }
  if (new Set(raw as string[]).size !== raw.length) {
    return { success: false, error: 'multiple-choice answer must contain unique option keys' };
  }
  const min = validation?.minSelections ?? 0;
  const max = validation?.maxSelections ?? options.length;
  if (raw.length < min) {
    return {
      success: false,
      error: `multiple-choice answer must select at least ${min} options`,
    };
  }
  if (raw.length > max) {
    return {
      success: false,
      error: `multiple-choice answer must select at most ${max} options`,
    };
  }
  return { success: true, value: raw };
}

/** Text answer: string within min/max code-point length, optional pattern. */
function validateTextAnswer(
  raw: unknown,
  validation: { minLength?: number; maxLength?: number; pattern?: string } | undefined,
): AnswerValidationResult {
  if (typeof raw !== 'string') {
    return { success: false, error: 'text answer must be a string' };
  }
  const min = validation?.minLength ?? 0;
  const max = validation?.maxLength ?? 20_000;
  const len = codepointCount(raw);
  if (len < min) {
    return { success: false, error: `text answer must be at least ${min} code points` };
  }
  if (len > max) {
    return { success: false, error: `text answer must be at most ${max} code points` };
  }
  if (validation?.pattern !== undefined) {
    try {
      if (!new RegExp(validation.pattern).test(raw)) {
        return { success: false, error: 'text answer does not match the required pattern' };
      }
    } catch {
      return { success: false, error: 'text pattern is invalid' };
    }
  }
  return { success: true, value: raw };
}

/** Number/scale answer: finite number within [min,max] aligned to step. */
function validateNumberAnswer(
  raw: unknown,
  validation: { min?: number; max?: number; step?: number } | undefined,
): AnswerValidationResult {
  if (typeof raw !== 'number') {
    return { success: false, error: 'number answer must be a finite number' };
  }
  if (!Number.isFinite(raw)) {
    return { success: false, error: 'number answer must be finite' };
  }
  const min = validation?.min ?? Number.NEGATIVE_INFINITY;
  const max = validation?.max ?? Number.POSITIVE_INFINITY;
  if (raw < min) {
    return { success: false, error: `number answer must be at least ${min}` };
  }
  if (raw > max) {
    return { success: false, error: `number answer must be at most ${max}` };
  }
  if (validation?.step !== undefined) {
    const base = validation.min ?? 0;
    if (!alignedToStep(raw, base, validation.step)) {
      return {
        success: false,
        error: `number answer must be aligned to step ${validation.step}`,
      };
    }
  }
  return { success: true, value: raw };
}

/** Ordering answer: array containing every listed option key exactly once. */
function validateOrderingAnswer(raw: unknown, options: { key: string }[]): AnswerValidationResult {
  if (!Array.isArray(raw)) {
    return { success: false, error: 'ordering answer must be an array' };
  }
  const keySet = new Set(options.map((o) => o.key));
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { success: false, error: 'ordering answer must contain only option keys' };
    }
    if (!keySet.has(item)) {
      return { success: false, error: 'ordering answer contains an unknown option key' };
    }
  }
  if (new Set(raw as string[]).size !== raw.length) {
    return {
      success: false,
      error: 'ordering answer must not contain duplicate option keys',
    };
  }
  if (raw.length !== options.length) {
    return {
      success: false,
      error: 'ordering answer must contain every option key exactly once',
    };
  }
  return { success: true, value: raw };
}

// ---------------------------------------------------------------------------
// Answer value schema (raw-shape validation without cross-field checks)
// ---------------------------------------------------------------------------

/**
 * Raw answer-value shape schema. Used to validate the structural shape of an
 * answer payload before cross-field validation via `validateAnswer`.
 * Cross-field rules (option key existence, step alignment, length bounds,
 * ordering completeness) are enforced by `validateAnswer` against a question
 * definition.
 */
export const AnswerValue = z.union([
  z.boolean(),
  z.string(),
  z.number().finite(),
  z.array(z.string()),
]);

export type AnswerValue = z.infer<typeof AnswerValue>;

// ---------------------------------------------------------------------------
// Question set schema (ordered collection of question definitions)
// ---------------------------------------------------------------------------

/**
 * A question set: an ordered collection of question definitions with unique
 * question keys. Cardinality/content caps are owned by the bounds feature
 * (m2-f08); this schema enforces only the closed per-question shape and key
 * uniqueness.
 */
export const QuestionSet = z
  .array(QuestionDefinition)
  .min(1, 'A question set must contain at least one question')
  .superRefine((questions, ctx) => {
    const keys = questions.map((q) => q.questionKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'question keys must be unique within a set',
      });
    }
  });

export type QuestionSet = z.infer<typeof QuestionSet>;

// ---------------------------------------------------------------------------
// Closed-schema introspection (for tests and contract publication)
// ---------------------------------------------------------------------------

/** The stable list of supported question types. */
export const SUPPORTED_QUESTION_TYPES: readonly QuestionTypeValue[] = [
  'boolean',
  'single_choice',
  'multiple_choice',
  'text',
  'number',
  'scale',
  'ordering',
] as const;

/** True when `type` is a supported question type. */
export function isSupportedQuestionType(type: string): type is QuestionTypeValue {
  return (SUPPORTED_QUESTION_TYPES as readonly string[]).includes(type);
}
