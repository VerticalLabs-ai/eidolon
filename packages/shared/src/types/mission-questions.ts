/**
 * Mission question type contract — shared client contract.
 *
 * Publishes the closed set of supported Mission question types and their
 * canonical answer value shapes so that API and UI clients can consume the
 * same contract without importing server internals. The server's
 * `question-schema.ts` is the authoritative source; this contract is kept in
 * sync so clients and server agree on the supported types and answer
 * discriminators.
 *
 * (VAL-MODEQ-136) Every question type has a closed schema: unknown types and
 * validation properties are rejected by the server. This contract declares
 * exactly the supported types and their answer value kinds.
 *
 * Schema version 1 is the Phase 1 stable contract.
 */

/** The closed set of supported question types. */
export const QUESTION_TYPES = [
  'boolean',
  'single_choice',
  'multiple_choice',
  'text',
  'number',
  'scale',
  'ordering',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * The canonical answer value kind for each question type. Clients use this to
 * render the correct input control and to perform client-side shape validation
 * before submission. Cross-field validation (option key existence, step
 * alignment, length bounds, ordering completeness) is enforced server-side
 * against the question definition.
 */
export type AnswerValueKind =
  | { type: 'boolean'; value: boolean | undefined }
  | { type: 'single_choice'; value: string | undefined }
  | { type: 'multiple_choice'; value: string[] | undefined }
  | { type: 'text'; value: string | undefined }
  | { type: 'number'; value: number | undefined }
  | { type: 'scale'; value: number | undefined }
  | { type: 'ordering'; value: string[] | undefined };

/** A single option for choice/ordering questions. */
export interface QuestionOption {
  key: string;
  label: string;
}

/** Common fields present on every question definition. */
export interface QuestionDefinitionCommon {
  questionKey: string;
  order: number;
  label: string;
  help?: string;
  required: boolean;
  default?: unknown;
}

/** Per-type validation descriptors (mirrors the server's strict objects). */
/**
 * Boolean questions carry no options or numeric validation. The
 * `validation` field is absent for boolean questions.
 */
export type BooleanValidation = undefined;

export interface ChoiceValidation {
  minSelections?: number;
  maxSelections?: number;
}

export interface TextValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface NumberValidation {
  min?: number;
  max?: number;
  step?: number;
}

export interface ScaleValidation {
  min: number;
  max: number;
  step?: number;
  minLabel?: string;
  maxLabel?: string;
}

/**
 * The complete question definition contract. The `type` field discriminates
 * which optional fields are present:
 * - `boolean`: no `options`, no `validation`
 * - `single_choice`/`ordering`: `options` required, no `validation`
 * - `multiple_choice`: `options` and `validation` (selection bounds)
 * - `text`: `validation` (length/pattern), no `options`
 * - `number`: `validation` (bounds/step), no `options`
 * - `scale`: `validation` (bounds/step/labels), no `options`
 */
export interface QuestionDefinition extends QuestionDefinitionCommon {
  type: QuestionType;
  options?: QuestionOption[];
  validation?:
    ChoiceValidation | TextValidation | NumberValidation | ScaleValidation | BooleanValidation;
}

/** Contract schema version for stable evolution. */
export const QUESTION_CONTRACT_SCHEMA_VERSION = 1;

/** The published Mission question type contract. */
export interface MissionQuestionContract {
  schemaVersion: number;
  types: readonly QuestionType[];
  /**
   * The answer value kind for each question type. Clients use this map to
   * select the correct input control and perform shape validation.
   */
  answerValueKinds: Record<QuestionType, 'boolean' | 'string' | 'string[]' | 'number'>;
}

/**
 * The complete Mission question type contract. Mirrors the server's
 * `SUPPORTED_QUESTION_TYPES` and answer value shapes. When the server schema
 * changes, this contract must be updated in the same commit.
 */
export const MISSION_QUESTION_CONTRACT: MissionQuestionContract = {
  schemaVersion: QUESTION_CONTRACT_SCHEMA_VERSION,
  types: QUESTION_TYPES,
  answerValueKinds: {
    boolean: 'boolean',
    single_choice: 'string',
    multiple_choice: 'string[]',
    text: 'string',
    number: 'number',
    scale: 'number',
    ordering: 'string[]',
  },
};
