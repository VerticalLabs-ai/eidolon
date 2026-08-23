import { describe, expect, it } from 'vitest';
import {
  QuestionDefinition,
  QuestionSet,
  QuestionType,
  SUPPORTED_QUESTION_TYPES,
  isSupportedQuestionType,
  validateAnswer,
  type QuestionDefinition as QuestionDefinitionType,
} from '../services/mission/question-schema.js';
import { MISSION_QUESTION_CONTRACT, QUESTION_TYPES } from '@eidolon/shared';

/**
 * Closed question/answer schemas for every supported type.
 *
 * Covers:
 * - VAL-MODEQ-046: Boolean questions
 * - VAL-MODEQ-047: Single-choice questions
 * - VAL-MODEQ-048: Multiple-choice questions
 * - VAL-MODEQ-049: Text questions
 * - VAL-MODEQ-050: Number questions
 * - VAL-MODEQ-052: Ordering questions
 * - VAL-MODEQ-136: Every question type has a closed schema
 */

/** Helper: build a minimal valid base question and override fields. */
function baseQuestion(
  overrides: Record<string, unknown> & { type: string },
): Record<string, unknown> {
  return {
    questionKey: 'q1',
    order: 0,
    label: 'Question one',
    required: false,
    ...overrides,
  };
}

/** Helper: expect a definition to parse successfully. */
function expectValid(payload: unknown): QuestionDefinitionType {
  const parsed = QuestionDefinition.safeParse(payload);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error(`Expected valid but got: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** Helper: expect a definition to be rejected. */
function expectInvalid(payload: unknown, hint?: string): void {
  const parsed = QuestionDefinition.safeParse(payload);
  expect(parsed.success).toBe(false);
  if (parsed.success && hint) {
    throw new Error(`Expected invalid (${hint}) but parsed successfully`);
  }
}

/** Helper: expect validateAnswer to succeed. */
function expectAnswerValid(question: QuestionDefinitionType, raw: unknown): void {
  const result = validateAnswer(question, raw);
  expect(result.success).toBe(true);
}

/** Helper: expect validateAnswer to fail. */
function expectAnswerInvalid(question: QuestionDefinitionType, raw: unknown, hint?: string): void {
  const result = validateAnswer(question, raw);
  expect(result.success).toBe(false);
  if (result.success && hint) {
    throw new Error(`Expected answer invalid (${hint}) but it was valid`);
  }
}

// ---------------------------------------------------------------------------
// VAL-MODEQ-136: Every question type has a closed schema
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-136: closed schema for every question type', () => {
  it('exposes exactly the seven supported question types', () => {
    expect(SUPPORTED_QUESTION_TYPES).toEqual([
      'boolean',
      'single_choice',
      'multiple_choice',
      'text',
      'number',
      'scale',
      'ordering',
    ]);
    expect(isSupportedQuestionType('boolean')).toBe(true);
    expect(isSupportedQuestionType('unknown')).toBe(false);
  });

  it('rejects unknown question types', () => {
    expectInvalid(baseQuestion({ type: 'dropdown' }), 'unknown type');
    expectInvalid(baseQuestion({ type: 'rating' }), 'unknown type');
    expectInvalid(baseQuestion({ type: '' }), 'empty type');
  });

  it('rejects unknown validation properties on every type', () => {
    expectInvalid(
      baseQuestion({ type: 'boolean', validation: { min: 0 } }),
      'boolean with validation',
    );
    expectInvalid(
      baseQuestion({ type: 'boolean', options: [{ key: 'a', label: 'A' }] }),
      'boolean with options',
    );
    expectInvalid(
      {
        ...baseQuestion({ type: 'single_choice' }),
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
        validation: { minSelections: 1 },
      },
      'single_choice with validation',
    );
    expectInvalid(
      {
        ...baseQuestion({ type: 'multiple_choice' }),
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
        validation: { minLength: 1 },
      },
      'multiple_choice with unknown validation property',
    );
    expectInvalid(
      baseQuestion({ type: 'text', validation: { minSelections: 1 } }),
      'text with unknown validation property',
    );
    expectInvalid(
      baseQuestion({ type: 'number', validation: { minLength: 1 } }),
      'number with unknown validation property',
    );
    expectInvalid(
      baseQuestion({ type: 'scale', validation: { minSelections: 1 } }),
      'scale with unknown validation property',
    );
    expectInvalid(
      {
        ...baseQuestion({ type: 'ordering' }),
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
        validation: { min: 0 },
      },
      'ordering with validation',
    );
  });

  it('rejects number definitions with non-finite or unordered bounds', () => {
    expectInvalid(baseQuestion({ type: 'number', validation: { min: NaN } }), 'NaN min');
    expectInvalid(baseQuestion({ type: 'number', validation: { min: Infinity } }), 'Infinity min');
    expectInvalid(
      baseQuestion({ type: 'number', validation: { max: -Infinity } }),
      '-Infinity max',
    );
    expectInvalid(baseQuestion({ type: 'number', validation: { min: 10, max: 5 } }), 'min > max');
  });

  it('requires positive step on number/scale definitions', () => {
    expectInvalid(baseQuestion({ type: 'number', validation: { step: 0 } }), 'zero step');
    expectInvalid(baseQuestion({ type: 'number', validation: { step: -1 } }), 'negative step');
    expectInvalid(baseQuestion({ type: 'number', validation: { step: NaN } }), 'NaN step');
    expectInvalid(
      baseQuestion({ type: 'scale', validation: { min: 0, max: 10, step: 0 } }),
      'scale zero step',
    );
  });

  it('requires scale bounds to be strictly ordered', () => {
    expectInvalid(
      baseQuestion({ type: 'scale', validation: { min: 5, max: 5 } }),
      'scale min == max',
    );
    expectInvalid(
      baseQuestion({ type: 'scale', validation: { min: 10, max: 5 } }),
      'scale min > max',
    );
    expectValid(baseQuestion({ type: 'scale', validation: { min: 0, max: 10, step: 1 } }));
  });

  it('requires multiple-choice selection bounds to be coherent and within option count', () => {
    const opts = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
    ];
    expectInvalid(
      {
        ...baseQuestion({ type: 'multiple_choice' }),
        options: opts,
        validation: { minSelections: -1 },
      },
      'negative minSelections',
    );
    expectInvalid(
      {
        ...baseQuestion({ type: 'multiple_choice' }),
        options: opts,
        validation: { minSelections: 2, maxSelections: 1 },
      },
      'min > max',
    );
    expectInvalid(
      {
        ...baseQuestion({ type: 'multiple_choice' }),
        options: opts,
        validation: { maxSelections: 5 },
      },
      'maxSelections > options count',
    );
    expectInvalid(
      {
        ...baseQuestion({ type: 'multiple_choice' }),
        options: opts,
        validation: { minSelections: 5 },
      },
      'minSelections > options count',
    );
    expectValid({
      ...baseQuestion({ type: 'multiple_choice' }),
      options: opts,
      validation: { minSelections: 0, maxSelections: 3 },
    });
    expectValid({
      ...baseQuestion({ type: 'multiple_choice' }),
      options: opts,
      validation: { minSelections: 1, maxSelections: 2 },
    });
  });

  it('requires ordering definitions to list unique option keys', () => {
    expectInvalid(
      {
        ...baseQuestion({ type: 'ordering' }),
        options: [
          { key: 'a', label: 'A' },
          { key: 'a', label: 'A duplicate' },
        ],
      },
      'duplicate option keys',
    );
  });

  it('requires every default to pass the same answer validator', () => {
    expectInvalid(baseQuestion({ type: 'boolean', default: 'yes' }), 'boolean default not boolean');
    expectInvalid(
      {
        ...baseQuestion({ type: 'single_choice' }),
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
        default: 'c',
      },
      'single_choice default unknown key',
    );
    expectInvalid(
      baseQuestion({ type: 'number', validation: { min: 0, max: 10, step: 2 }, default: 3 }),
      'number default step mismatch',
    );
    expectInvalid(
      baseQuestion({ type: 'number', validation: { min: 0, max: 10 }, default: 11 }),
      'number default out of range',
    );
    expectInvalid(
      baseQuestion({ type: 'text', validation: { minLength: 5 }, default: 'hi' }),
      'text default too short',
    );
    // Valid defaults
    expectValid(baseQuestion({ type: 'boolean', default: false }));
    expectValid({
      ...baseQuestion({ type: 'single_choice' }),
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      default: 'a',
    });
    expectValid(
      baseQuestion({ type: 'number', validation: { min: 0, max: 10, step: 2 }, default: 4 }),
    );
  });

  it('publishes a shared generated contract matching the server types', () => {
    expect(MISSION_QUESTION_CONTRACT.schemaVersion).toBe(1);
    expect([...QUESTION_TYPES]).toEqual([...SUPPORTED_QUESTION_TYPES]);
    expect(MISSION_QUESTION_CONTRACT.types).toEqual(SUPPORTED_QUESTION_TYPES);
    for (const t of SUPPORTED_QUESTION_TYPES) {
      expect(MISSION_QUESTION_CONTRACT.answerValueKinds[t]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-046: Boolean questions
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-046: boolean questions', () => {
  const requiredQ = expectValid(baseQuestion({ type: 'boolean', required: true }));
  const optionalQ = expectValid(baseQuestion({ type: 'boolean', required: false }));

  it('accepts true and false', () => {
    expectAnswerValid(requiredQ, true);
    expectAnswerValid(requiredQ, false);
    expectAnswerValid(optionalQ, true);
    expectAnswerValid(optionalQ, false);
  });

  it('distinguishes false from unanswered', () => {
    const falseResult = validateAnswer(requiredQ, false);
    expect(falseResult.success).toBe(true);
    expect(falseResult.value).toBe(false);

    const unanswered = validateAnswer(requiredQ, undefined);
    expect(unanswered.success).toBe(false);
  });

  it('rejects strings, numbers, null, and omitted required values', () => {
    expectAnswerInvalid(requiredQ, 'true', 'string');
    expectAnswerInvalid(requiredQ, 'false', 'string');
    expectAnswerInvalid(requiredQ, 1, 'number');
    expectAnswerInvalid(requiredQ, 0, 'number');
    expectAnswerInvalid(requiredQ, null, 'null');
    expectAnswerInvalid(requiredQ, undefined, 'omitted required');
  });

  it('accepts omitted optional boolean', () => {
    expectAnswerValid(optionalQ, undefined);
    const result = validateAnswer(optionalQ, undefined);
    expect(result.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-047: Single-choice questions
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-047: single-choice questions', () => {
  const q = expectValid({
    ...baseQuestion({ type: 'single_choice', required: true }),
    options: [
      { key: 'red', label: 'Red' },
      { key: 'green', label: 'Green' },
      { key: 'blue', label: 'Blue' },
    ],
  });

  it('accepts exactly one listed option key', () => {
    expectAnswerValid(q, 'red');
    expectAnswerValid(q, 'green');
    expectAnswerValid(q, 'blue');
  });

  it('rejects labels instead of keys', () => {
    expectAnswerInvalid(q, 'Red', 'label not key');
    expectAnswerInvalid(q, 'Green', 'label not key');
  });

  it('rejects unknown keys', () => {
    expectAnswerInvalid(q, 'yellow', 'unknown key');
    expectAnswerInvalid(q, '', 'empty key');
  });

  it('rejects multiple keys', () => {
    expectAnswerInvalid(q, ['red', 'green'], 'array');
    expectAnswerInvalid(q, 'red,green', 'comma string');
  });

  it('rejects missing required answers and non-strings', () => {
    expectAnswerInvalid(q, undefined, 'omitted required');
    expectAnswerInvalid(q, null, 'null');
    expectAnswerInvalid(q, 42, 'number');
    expectAnswerInvalid(q, true, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-048: Multiple-choice questions
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-048: multiple-choice questions', () => {
  const q = expectValid({
    ...baseQuestion({ type: 'multiple_choice', required: true }),
    options: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
      { key: 'c', label: 'C' },
      { key: 'd', label: 'D' },
    ],
    validation: { minSelections: 1, maxSelections: 3 },
  });

  it('accepts boundary-value arrays within min/max', () => {
    expectAnswerValid(q, ['a']); // min boundary
    expectAnswerValid(q, ['a', 'b', 'c']); // max boundary
    expectAnswerValid(q, ['a', 'b']);
  });

  it('rejects duplicate option keys', () => {
    expectAnswerInvalid(q, ['a', 'a'], 'duplicate');
    expectAnswerInvalid(q, ['a', 'b', 'a'], 'duplicate');
  });

  it('rejects unknown option keys', () => {
    expectAnswerInvalid(q, ['a', 'z'], 'unknown key');
    expectAnswerInvalid(q, ['x'], 'unknown key');
  });

  it('rejects too-few and too-many selections', () => {
    expectAnswerInvalid(q, [], 'too few (below min)');
    expectAnswerInvalid(q, ['a', 'b', 'c', 'd'], 'too many (above max)');
  });

  it('rejects non-array answers', () => {
    expectAnswerInvalid(q, 'a', 'string');
    expectAnswerInvalid(q, 'a,b', 'comma string');
    expectAnswerInvalid(q, { a: true }, 'object');
    expectAnswerInvalid(q, 42, 'number');
    expectAnswerInvalid(q, undefined, 'omitted required');
  });

  it('defaults bounds to 0..options.length when validation omitted', () => {
    const q2 = expectValid({
      ...baseQuestion({ type: 'multiple_choice', required: false }),
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
    });
    expectAnswerValid(q2, []);
    expectAnswerValid(q2, ['a', 'b']);
    expectAnswerInvalid(q2, ['a', 'b', 'c'], 'exceeds options count');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-049: Text questions
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-049: text questions', () => {
  const q = expectValid({
    ...baseQuestion({ type: 'text', required: true }),
    validation: { minLength: 3, maxLength: 10, pattern: '^[a-z]+$' },
  });

  it('accepts boundary strings satisfying length and pattern', () => {
    expectAnswerValid(q, 'abc'); // min boundary
    expectAnswerValid(q, 'abcdefghij'); // max boundary
    expectAnswerValid(q, 'hello');
  });

  it('rejects empty when minLength requires content', () => {
    expectAnswerInvalid(q, '', 'empty below minLength');
  });

  it('rejects too-short strings', () => {
    expectAnswerInvalid(q, 'ab', 'below minLength');
    expectAnswerInvalid(q, 'a', 'below minLength');
  });

  it('rejects too-long strings', () => {
    expectAnswerInvalid(q, 'abcdefghijk', 'above maxLength');
  });

  it('rejects pattern mismatches', () => {
    expectAnswerInvalid(q, 'abc1', 'pattern mismatch');
    expectAnswerInvalid(q, 'Abc', 'pattern mismatch (uppercase)');
    expectAnswerInvalid(q, 'ab c', 'pattern mismatch (space)');
  });

  it('rejects non-strings', () => {
    expectAnswerInvalid(q, 42, 'number');
    expectAnswerInvalid(q, true, 'boolean');
    expectAnswerInvalid(q, ['abc'], 'array');
    expectAnswerInvalid(q, null, 'null');
    expectAnswerInvalid(q, undefined, 'omitted required');
  });

  it('counts Unicode code points, not UTF-16 code units', () => {
    const q2 = expectValid({
      ...baseQuestion({ type: 'text', required: true }),
      validation: { maxLength: 3 },
    });
    // '𝓐𝓑𝓒' is 3 code points but 6 UTF-16 code units.
    expectAnswerValid(q2, '𝓐𝓑𝓒');
    expectAnswerInvalid(q2, '𝓐𝓑𝓒𝓓', '4 code points exceeds maxLength 3');
  });

  it('accepts omitted optional text', () => {
    const opt = expectValid({
      ...baseQuestion({ type: 'text', required: false }),
      validation: { minLength: 1 },
    });
    expectAnswerValid(opt, undefined);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-050: Number questions
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-050: number questions', () => {
  const q = expectValid({
    ...baseQuestion({ type: 'number', required: true }),
    validation: { min: 0, max: 10, step: 2 },
  });

  it('accepts min, max, and step-aligned values', () => {
    expectAnswerValid(q, 0); // min
    expectAnswerValid(q, 10); // max
    expectAnswerValid(q, 2);
    expectAnswerValid(q, 4);
    expectAnswerValid(q, 6);
    expectAnswerValid(q, 8);
  });

  it('rejects numeric strings', () => {
    expectAnswerInvalid(q, '4', 'numeric string');
    expectAnswerInvalid(q, '10', 'numeric string');
    expectAnswerInvalid(q, '0', 'numeric string');
  });

  it('rejects NaN and infinity equivalents', () => {
    expectAnswerInvalid(q, NaN, 'NaN');
    expectAnswerInvalid(q, Infinity, 'Infinity');
    expectAnswerInvalid(q, -Infinity, '-Infinity');
  });

  it('rejects out-of-range values', () => {
    expectAnswerInvalid(q, -1, 'below min');
    expectAnswerInvalid(q, 11, 'above max');
    expectAnswerInvalid(q, -0.5, 'below min');
  });

  it('rejects step mismatches', () => {
    expectAnswerInvalid(q, 1, 'step mismatch');
    expectAnswerInvalid(q, 3, 'step mismatch');
    expectAnswerInvalid(q, 5, 'step mismatch');
    expectAnswerInvalid(q, 7, 'step mismatch');
    expectAnswerInvalid(q, 9, 'step mismatch');
  });

  it('rejects non-numbers', () => {
    expectAnswerInvalid(q, true, 'boolean');
    expectAnswerInvalid(q, '4', 'string');
    expectAnswerInvalid(q, [4], 'array');
    expectAnswerInvalid(q, null, 'null');
    expectAnswerInvalid(q, undefined, 'omitted required');
  });

  it('handles decimal steps with tolerance', () => {
    const q2 = expectValid({
      ...baseQuestion({ type: 'number', required: false }),
      validation: { min: 0, max: 1, step: 0.1 },
    });
    expectAnswerValid(q2, 0);
    expectAnswerValid(q2, 0.1);
    expectAnswerValid(q2, 0.5);
    expectAnswerValid(q2, 1);
    expectAnswerInvalid(q2, 0.05, 'step mismatch');
    expectAnswerInvalid(q2, 0.25, 'step mismatch');
  });

  it('applies unbounded defaults when bounds omitted', () => {
    const q2 = expectValid({
      ...baseQuestion({ type: 'number', required: false }),
    });
    expectAnswerValid(q2, 42);
    expectAnswerValid(q2, -1000);
    expectAnswerValid(q2, 3.14159);
    expectAnswerInvalid(q2, NaN, 'NaN');
    expectAnswerInvalid(q2, Infinity, 'Infinity');
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-052: Ordering questions
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-052: ordering questions', () => {
  const q = expectValid({
    ...baseQuestion({ type: 'ordering', required: true }),
    options: [
      { key: 'first', label: 'First' },
      { key: 'second', label: 'Second' },
      { key: 'third', label: 'Third' },
    ],
  });

  it('accepts a complete ordering containing each key exactly once', () => {
    expectAnswerValid(q, ['first', 'second', 'third']);
    expectAnswerValid(q, ['third', 'first', 'second']);
    expectAnswerValid(q, ['second', 'third', 'first']);
  });

  it('rejects omissions', () => {
    expectAnswerInvalid(q, ['first', 'second'], 'omission');
    expectAnswerInvalid(q, ['first'], 'omission');
    expectAnswerInvalid(q, [], 'omission');
  });

  it('rejects duplicates', () => {
    expectAnswerInvalid(q, ['first', 'first', 'second'], 'duplicate');
    expectAnswerInvalid(q, ['first', 'second', 'first'], 'duplicate');
  });

  it('rejects unknown keys', () => {
    expectAnswerInvalid(q, ['first', 'second', 'fourth'], 'unknown key');
    expectAnswerInvalid(q, ['first', 'second', 'third', 'fourth'], 'unknown key');
  });

  it('rejects extra keys beyond the listed options', () => {
    expectAnswerInvalid(q, ['first', 'second', 'third', 'third'], 'extra duplicate');
  });

  it('rejects non-array answers', () => {
    expectAnswerInvalid(q, 'first', 'string');
    expectAnswerInvalid(q, 'first,second,third', 'comma string');
    expectAnswerInvalid(q, { first: 1 }, 'object');
    expectAnswerInvalid(q, 123, 'number');
    expectAnswerInvalid(q, true, 'boolean');
    expectAnswerInvalid(q, null, 'null');
    expectAnswerInvalid(q, undefined, 'omitted required');
  });

  it('rejects non-string items in the array', () => {
    expectAnswerInvalid(q, ['first', 2, 'third'], 'non-string item');
    expectAnswerInvalid(q, [1, 2, 3], 'numeric items');
  });
});

// ---------------------------------------------------------------------------
// Scale questions (closed schema, VAL-MODEQ-136 + VAL-MODEQ-051 backend)
// ---------------------------------------------------------------------------

describe('scale questions (closed schema)', () => {
  it('accepts a valid scale definition with labels and step', () => {
    expectValid(
      baseQuestion({
        type: 'scale',
        validation: { min: 1, max: 5, step: 1, minLabel: 'Low', maxLabel: 'High' },
      }),
    );
  });

  it('accepts a scale definition without optional labels/step', () => {
    expectValid(baseQuestion({ type: 'scale', validation: { min: 0, max: 100 } }));
  });

  it('rejects scale definitions missing bounds', () => {
    expectInvalid(baseQuestion({ type: 'scale', validation: { min: 0 } }), 'missing max');
    expectInvalid(baseQuestion({ type: 'scale', validation: { max: 10 } }), 'missing min');
  });

  it('validates scale answers with bounds and step', () => {
    const q = expectValid(
      baseQuestion({
        type: 'scale',
        required: true,
        validation: { min: 1, max: 5, step: 1, minLabel: 'Low', maxLabel: 'High' },
      }),
    );
    expectAnswerValid(q, 1);
    expectAnswerValid(q, 3);
    expectAnswerValid(q, 5);
    expectAnswerInvalid(q, 0, 'below min');
    expectAnswerInvalid(q, 6, 'above max');
    expectAnswerInvalid(q, 2.5, 'step mismatch');
    expectAnswerInvalid(q, '3', 'numeric string');
  });
});

// ---------------------------------------------------------------------------
// Question set schema
// ---------------------------------------------------------------------------

describe('QuestionSet schema', () => {
  it('accepts an ordered set with unique keys', () => {
    const set = QuestionSet.safeParse([
      { ...baseQuestion({ type: 'boolean', questionKey: 'q1' }) },
      {
        ...baseQuestion({ type: 'text', questionKey: 'q2' }),
        validation: { minLength: 1 },
      },
    ]);
    expect(set.success).toBe(true);
  });

  it('rejects duplicate question keys within a set', () => {
    const set = QuestionSet.safeParse([
      { ...baseQuestion({ type: 'boolean', questionKey: 'q1' }) },
      { ...baseQuestion({ type: 'boolean', questionKey: 'q1' }) },
    ]);
    expect(set.success).toBe(false);
  });

  it('rejects an empty set', () => {
    const set = QuestionSet.safeParse([]);
    expect(set.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QuestionType enum
// ---------------------------------------------------------------------------

describe('QuestionType enum', () => {
  it('parses each supported type', () => {
    for (const t of SUPPORTED_QUESTION_TYPES) {
      expect(QuestionType.safeParse(t).success).toBe(true);
    }
  });

  it('rejects unsupported types', () => {
    expect(QuestionType.safeParse('dropdown').success).toBe(false);
    expect(QuestionType.safeParse('').success).toBe(false);
    expect(QuestionType.safeParse(42).success).toBe(false);
  });
});
