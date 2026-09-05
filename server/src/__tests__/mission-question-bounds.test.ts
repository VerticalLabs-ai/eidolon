import { describe, expect, it } from 'vitest';
import {
  QuestionDefinition,
  QuestionSet,
  validateAnswer,
} from '../services/mission/question-schema.js';
import {
  MAX_OPTIONS_PER_QUESTION,
  MAX_LABEL_CODEPOINTS,
  MAX_HELP_CODEPOINTS,
  MAX_TEXT_ANSWER_CODEPOINTS,
  MAX_PATTERN_CODEPOINTS,
  MAX_VALIDATION_BYTES,
  MAX_SET_BYTES,
  MAX_ANSWER_BODY_BYTES,
  validatePatternSafety,
  isAlignedToStep,
  normalizeTextNFC,
  countCodePoints,
  measureJsonDepth,
  measureJsonBytes,
  validateQuestionSetBounds,
  validateAnswerBodySize,
  validateValidationJson,
  isSafeText,
} from '../services/mission/question-bounds.js';

/**
 * Question cardinality, content, regex, canonicalization, and default bounds.
 *
 * Covers:
 * - VAL-MODEQ-058: Question card count bound
 * - VAL-MODEQ-060: Question content bounds
 * - VAL-MODEQ-061: Duplicate definitions are invalid
 * - VAL-MODEQ-137: Text patterns are resource safe
 * - VAL-MODEQ-138: Question payloads and rendered content are bounded and inert
 * - VAL-MODEQ-139: Number and text canonicalization is exact
 * - VAL-MODEQ-140: Optional defaults and empty values remain distinct
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeQuestions(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    questionKey: `q${i}`,
    order: i,
    label: `Question ${i}`,
    type: 'boolean',
    required: false,
  }));
}

function expectValidQuestionSet(payload: unknown): void {
  const parsed = QuestionSet.safeParse(payload);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error(`Expected valid but got: ${JSON.stringify(parsed.error.issues)}`);
  }
}

function expectInvalidQuestionSet(payload: unknown, hint?: string): void {
  const parsed = QuestionSet.safeParse(payload);
  expect(parsed.success).toBe(false);
  if (parsed.success && hint) {
    throw new Error(`Expected invalid (${hint}) but parsed successfully`);
  }
}

function makeOptions(n: number): { key: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `opt${i}`,
    label: `Option ${i}`,
  }));
}

/** Repeat a character n times to build a string of exactly n code points. */
function repeatStr(s: string, n: number): string {
  return s.repeat(n);
}

// ---------------------------------------------------------------------------
// VAL-MODEQ-058: Question card count bound
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-058: Question card count bound', () => {
  it('accepts a set with exactly 12 questions (exact cap)', () => {
    expectValidQuestionSet(makeQuestions(12));
  });

  it('rejects a set with 13 questions (one over cap)', () => {
    expectInvalidQuestionSet(makeQuestions(13), '13 questions exceeds cap of 12');
  });

  it('accepts a set with 1 question (minimum)', () => {
    expectValidQuestionSet(makeQuestions(1));
  });

  it('rejects an empty set', () => {
    expectInvalidQuestionSet([], 'empty set');
  });

  it('validateQuestionSetBounds rejects oversized sets without truncation', () => {
    const oversized = makeQuestions(13);
    const result = validateQuestionSetBounds(oversized);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // The set is not truncated — all 13 questions remain.
    expect(oversized.length).toBe(13);
  });

  it('validateQuestionSetBounds accepts a set at the exact cap', () => {
    const result = validateQuestionSetBounds(makeQuestions(12));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-060: Question content bounds
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-060: Question content bounds', () => {
  it('accepts a label at exactly 500 code points and rejects 501', () => {
    const valid = baseQuestion({
      type: 'boolean',
      label: repeatStr('a', MAX_LABEL_CODEPOINTS),
    });
    const invalid = baseQuestion({
      type: 'boolean',
      label: repeatStr('a', MAX_LABEL_CODEPOINTS + 1),
    });
    expect(QuestionDefinition.safeParse(valid).success).toBe(true);
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('accepts help text at exactly 2000 code points and rejects 2001', () => {
    const valid = baseQuestion({
      type: 'boolean',
      help: repeatStr('h', MAX_HELP_CODEPOINTS),
    });
    const invalid = baseQuestion({
      type: 'boolean',
      help: repeatStr('h', MAX_HELP_CODEPOINTS + 1),
    });
    expect(QuestionDefinition.safeParse(valid).success).toBe(true);
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('accepts exactly 50 options and rejects 51', () => {
    const valid = baseQuestion({
      type: 'single_choice',
      options: makeOptions(MAX_OPTIONS_PER_QUESTION),
    });
    const invalid = baseQuestion({
      type: 'single_choice',
      options: makeOptions(MAX_OPTIONS_PER_QUESTION + 1),
    });
    expect(QuestionDefinition.safeParse(valid).success).toBe(true);
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects 51 options on multiple_choice and ordering too', () => {
    for (const type of ['multiple_choice', 'ordering'] as const) {
      const invalid = baseQuestion({
        type,
        options: makeOptions(MAX_OPTIONS_PER_QUESTION + 1),
      });
      expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
    }
  });

  it('accepts a text answer at exactly 20000 code points and rejects 20001', () => {
    const question = QuestionDefinition.safeParse(baseQuestion({ type: 'text' }));
    if (!question.success) {
      throw new Error('failed to parse text question');
    }
    const valid = validateAnswer(question.data, repeatStr('x', MAX_TEXT_ANSWER_CODEPOINTS));
    expect(valid.success).toBe(true);
    const invalid = validateAnswer(question.data, repeatStr('x', MAX_TEXT_ANSWER_CODEPOINTS + 1));
    expect(invalid.success).toBe(false);
  });

  it('rejects a text definition with maxLength above 20000', () => {
    const invalid = baseQuestion({
      type: 'text',
      validation: { maxLength: MAX_TEXT_ANSWER_CODEPOINTS + 1 },
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('accepts a text definition with maxLength at exactly 20000', () => {
    const valid = baseQuestion({
      type: 'text',
      validation: { maxLength: MAX_TEXT_ANSWER_CODEPOINTS },
    });
    expect(QuestionDefinition.safeParse(valid).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-061: Duplicate definitions are invalid
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-061: Duplicate definitions are invalid', () => {
  it('rejects a set with duplicate question keys', () => {
    const set = [
      { questionKey: 'dup', order: 0, label: 'First', type: 'boolean', required: false },
      { questionKey: 'dup', order: 1, label: 'Second', type: 'boolean', required: false },
    ];
    expectInvalidQuestionSet(set, 'duplicate question keys');
  });

  it('rejects single_choice with duplicate option keys', () => {
    const invalid = baseQuestion({
      type: 'single_choice',
      options: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'A again' },
      ],
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects multiple_choice with duplicate option keys', () => {
    const invalid = baseQuestion({
      type: 'multiple_choice',
      options: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'A again' },
        { key: 'b', label: 'B' },
      ],
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects ordering with duplicate option keys', () => {
    const invalid = baseQuestion({
      type: 'ordering',
      options: [
        { key: 'a', label: 'A' },
        { key: 'a', label: 'A again' },
      ],
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects an invalid default that does not pass the answer validator', () => {
    // boolean question with a string default
    const invalid = baseQuestion({
      type: 'boolean',
      default: 'true',
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);

    // single_choice with an unlisted default key
    const invalid2 = baseQuestion({
      type: 'single_choice',
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      default: 'c',
    });
    expect(QuestionDefinition.safeParse(invalid2).success).toBe(false);

    // number with out-of-range default
    const invalid3 = baseQuestion({
      type: 'number',
      validation: { min: 0, max: 10 },
      default: 20,
    });
    expect(QuestionDefinition.safeParse(invalid3).success).toBe(false);
  });

  it('rejects validation rules incompatible with the question type', () => {
    // boolean with validation properties
    expect(
      QuestionDefinition.safeParse(baseQuestion({ type: 'boolean', validation: { min: 0 } }))
        .success,
    ).toBe(false);

    // text with choice validation properties
    expect(
      QuestionDefinition.safeParse(baseQuestion({ type: 'text', validation: { minSelections: 1 } }))
        .success,
    ).toBe(false);

    // ordering with number validation
    expect(
      QuestionDefinition.safeParse(
        baseQuestion({
          type: 'ordering',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          validation: { min: 0 },
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts a valid default that passes the answer validator', () => {
    const valid = baseQuestion({
      type: 'boolean',
      default: false,
    });
    expect(QuestionDefinition.safeParse(valid).success).toBe(true);

    const valid2 = baseQuestion({
      type: 'single_choice',
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      default: 'a',
    });
    expect(QuestionDefinition.safeParse(valid2).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-137: Text patterns are resource safe
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-137: Text patterns are resource safe', () => {
  it('accepts a pattern at exactly 256 code points', () => {
    const pattern = repeatStr('a', MAX_PATTERN_CODEPOINTS);
    const result = validatePatternSafety(pattern);
    expect(result.safe).toBe(true);
  });

  it('rejects a pattern at 257 code points (one over)', () => {
    const pattern = repeatStr('a', MAX_PATTERN_CODEPOINTS + 1);
    const result = validatePatternSafety(pattern);
    expect(result.safe).toBe(false);
  });

  it('accepts a pattern at exactly 1024 UTF-8 bytes', () => {
    // 256 four-byte emoji (U+1F600) = 256 code points, 1024 UTF-8 bytes.
    const pattern = repeatStr('\u{1F600}', MAX_PATTERN_CODEPOINTS);
    const result = validatePatternSafety(pattern);
    expect(result.safe).toBe(true);
  });

  it('rejects a pattern exceeding 1024 UTF-8 bytes via code point check', () => {
    // Since max code points is 256 and max UTF-8 bytes per char is 4,
    // 256 x 4 = 1024 is the maximum possible byte count at 256 code points.
    // A pattern with 257 code points is rejected by the code-point check first.
    const pattern = repeatStr('a', MAX_PATTERN_CODEPOINTS + 1);
    const result = validatePatternSafety(pattern);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('code points');
  });

  it('rejects patterns with backreferences', () => {
    expect(validatePatternSafety('(a)\\1').safe).toBe(false);
    expect(validatePatternSafety('(a)(b)\\2').safe).toBe(false);
  });

  it('rejects patterns with named backreferences', () => {
    expect(validatePatternSafety('(?<name>a)\\k<name>').safe).toBe(false);
  });

  it('rejects patterns with lookaheads', () => {
    expect(validatePatternSafety('a(?=b)').safe).toBe(false);
    expect(validatePatternSafety('a(?!b)').safe).toBe(false);
  });

  it('rejects patterns with lookbehinds', () => {
    expect(validatePatternSafety('(?<=a)b').safe).toBe(false);
    expect(validatePatternSafety('(?<!a)b').safe).toBe(false);
  });

  it('rejects patterns with named capture groups', () => {
    expect(validatePatternSafety('(?<name>a)').safe).toBe(false);
  });

  it('rejects patterns with nested quantifiers (catastrophic backtracking)', () => {
    expect(validatePatternSafety('(a+)+').safe).toBe(false);
    expect(validatePatternSafety('(a*)*').safe).toBe(false);
    expect(validatePatternSafety('(a+)*').safe).toBe(false);
    expect(validatePatternSafety('(a*)+').safe).toBe(false);
    expect(validatePatternSafety('(a?)+').safe).toBe(false);
  });

  it('rejects patterns that do not compile', () => {
    expect(validatePatternSafety('[').safe).toBe(false);
    expect(validatePatternSafety('(a').safe).toBe(false);
    expect(validatePatternSafety('*').safe).toBe(false);
  });

  it('accepts safe, simple patterns', () => {
    expect(validatePatternSafety('^[a-z]+$').safe).toBe(true);
    expect(validatePatternSafety('\\d{1,3}').safe).toBe(true);
    expect(validatePatternSafety('hello|world').safe).toBe(true);
    expect(validatePatternSafety('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}').safe).toBe(
      true,
    );
  });

  it('rejects backreferences in safe pattern through QuestionDefinition', () => {
    const invalid = baseQuestion({
      type: 'text',
      validation: { pattern: '(a)\\1' },
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects nested quantifiers through QuestionDefinition', () => {
    const invalid = baseQuestion({
      type: 'text',
      validation: { pattern: '(a+)+' },
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('accepts a safe pattern through QuestionDefinition', () => {
    const valid = baseQuestion({
      type: 'text',
      validation: { pattern: '^[a-z]+$' },
    });
    expect(QuestionDefinition.safeParse(valid).success).toBe(true);
  });

  it('validates a 20000-code-point text answer within 50 ms', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'text', validation: { pattern: '^[a-z]+$' } }),
    );
    if (!question.success) {
      throw new Error('failed to parse text question');
    }
    const longAnswer = repeatStr('a', 20_000);

    const start = performance.now();
    const result = validateAnswer(question.data, longAnswer);
    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-138: Question payloads and rendered content are bounded and inert
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-138: Question payloads bounded and inert', () => {
  it('rejects validation JSON with depth exceeding 6', () => {
    // Build a validation object with depth 7.
    let obj: Record<string, unknown> = { value: 'x' };
    for (let i = 0; i < 6; i++) {
      obj = { nested: obj };
    }
    // obj has depth 7
    expect(measureJsonDepth(obj)).toBe(7);
    const result = validateValidationJson(obj);
    expect(result.valid).toBe(false);
  });

  it('accepts validation JSON at depth exactly 6', () => {
    let obj: Record<string, unknown> = { value: 'x' };
    for (let i = 0; i < 5; i++) {
      obj = { nested: obj };
    }
    expect(measureJsonDepth(obj)).toBe(6);
    const result = validateValidationJson(obj);
    expect(result.valid).toBe(true);
  });

  it('rejects validation JSON exceeding 16384 bytes', () => {
    // Build a string that makes the JSON exceed 16384 bytes.
    const bigString = repeatStr('x', MAX_VALIDATION_BYTES + 100);
    const result = validateValidationJson({ pattern: bigString });
    expect(result.valid).toBe(false);
  });

  it('accepts validation JSON at exactly 16384 bytes boundary', () => {
    // Craft a JSON that is close to the limit. {"pattern":"xxx..."}
    // The overhead of {"pattern":""} is 14 bytes. So string of 16370 = 16384.
    const exactStr = repeatStr('a', MAX_VALIDATION_BYTES - 14);
    const obj = { pattern: exactStr };
    expect(measureJsonBytes(obj)).toBe(MAX_VALIDATION_BYTES);
    const result = validateValidationJson(obj);
    expect(result.valid).toBe(true);
  });

  it('rejects a question set exceeding 131072 bytes', () => {
    // Build a set of 12 questions with large labels to exceed 131072 bytes.
    // Each question with a 12000-char label → ~12060 bytes each × 12 = ~144720 bytes
    const questions = Array.from({ length: 12 }, (_, i) => ({
      questionKey: `q${i}`,
      order: i,
      label: repeatStr('L', 12000),
      type: 'boolean',
      required: false,
    }));
    const totalBytes = measureJsonBytes(questions);
    expect(totalBytes).toBeGreaterThan(MAX_SET_BYTES);
    const result = validateQuestionSetBounds(questions);
    expect(result.valid).toBe(false);
  });

  it('rejects an answer body exceeding 65536 bytes', () => {
    const bigBody = { answers: { q1: repeatStr('x', MAX_ANSWER_BODY_BYTES + 100) } };
    const result = validateAnswerBodySize(bigBody);
    expect(result.valid).toBe(false);
  });

  it('accepts an answer body within 65536 bytes', () => {
    const body = { answers: { q1: 'hello' } };
    const result = validateAnswerBodySize(body);
    expect(result.valid).toBe(true);
  });

  it('rejects C0 control characters (except TAB/LF/CR) in labels', () => {
    const invalid = baseQuestion({
      type: 'boolean',
      label: 'Bad\u0001Label',
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects C1 control characters in labels', () => {
    const invalid = baseQuestion({
      type: 'boolean',
      label: 'Bad\u0080Label',
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects BiDi override characters in labels', () => {
    const invalid = baseQuestion({
      type: 'boolean',
      label: 'Bad\u202ELabel',
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects BiDi isolate characters in help text', () => {
    const invalid = baseQuestion({
      type: 'boolean',
      help: 'Bad\u2066Text',
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('allows TAB, LF, and CR in text answers', () => {
    // TAB/LF/CR are legitimate formatting characters.
    expect(isSafeText('hello\tworld')).toBe(true);
    expect(isSafeText('line1\nline2')).toBe(true);
    expect(isSafeText('line1\r\nline2')).toBe(true);
  });

  it('rejects zero-width and BOM characters', () => {
    expect(isSafeText('a\u200Bb')).toBe(false);
    expect(isSafeText('a\uFEFFb')).toBe(false);
  });

  it('accepts question and option keys of 1–128 printable ASCII', () => {
    // 1 char
    const min = baseQuestion({
      type: 'single_choice',
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
    });
    expect(QuestionDefinition.safeParse(min).success).toBe(true);

    // 128 chars
    const max = baseQuestion({
      type: 'single_choice',
      options: [
        { key: repeatStr('k', 128), label: 'A' },
        { key: 'b', label: 'B' },
      ],
    });
    expect(QuestionDefinition.safeParse(max).success).toBe(true);
  });

  it('rejects question keys over 128 characters', () => {
    const invalid = baseQuestion({
      type: 'boolean',
      questionKey: repeatStr('k', 129),
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });

  it('rejects empty question keys', () => {
    const invalid = baseQuestion({
      type: 'boolean',
      questionKey: '',
    });
    expect(QuestionDefinition.safeParse(invalid).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-139: Number and text canonicalization is exact
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-139: Number and text canonicalization is exact', () => {
  // --- NFC normalization ---

  it('normalizes decomposed Unicode to NFC (composed form)', () => {
    // é decomposed: U+0065 + U+0301 → composed: U+00E9
    const decomposed = 'e\u0301';
    const composed = '\u00E9';
    expect(normalizeTextNFC(decomposed)).toBe(composed);
  });

  it('preserves already-NFC text unchanged', () => {
    const text = 'Hello, World!';
    expect(normalizeTextNFC(text)).toBe(text);
  });

  it('does not trim leading or trailing whitespace', () => {
    const text = '  hello  ';
    expect(normalizeTextNFC(text)).toBe('  hello  ');
  });

  it('returns NFC-normalized text from validateAnswer', () => {
    const question = QuestionDefinition.safeParse(baseQuestion({ type: 'text' }));
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, 'e\u0301');
    expect(result.success).toBe(true);
    expect(result.value).toBe('\u00E9');
  });

  // --- Code-point length counting ---

  it('counts Unicode code points, not UTF-16 code units', () => {
    // 🎉 is U+1F389, a single code point but 2 UTF-16 code units.
    expect(countCodePoints('🎉')).toBe(1);
    expect(countCodePoints('🎉🎉')).toBe(2);
    expect('🎉'.length).toBe(2); // UTF-16 code units
  });

  it('enforces text maxLength in code points, not UTF-16 code units', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'text', validation: { maxLength: 1 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    // 1 code point (emoji) should be accepted with maxLength=1
    const result = validateAnswer(question.data, '🎉');
    expect(result.success).toBe(true);
    // 2 code points should be rejected
    const result2 = validateAnswer(question.data, '🎉🎉');
    expect(result2.success).toBe(false);
  });

  // --- Exact decimal step alignment ---

  it('correctly aligns 0.3 to step 0.1 from min 0 (float-inexact case)', () => {
    // In floating point: (0.3 - 0) / 0.1 = 2.9999999999999996, NOT 3.
    // Exact decimal: 3 / 10 ÷ 1 / 10 = 3. This should be aligned.
    expect(isAlignedToStep(0, 0.1, 0.3)).toBe(true);
  });

  it('correctly aligns 0.2 to step 0.1 from min 0', () => {
    expect(isAlignedToStep(0, 0.1, 0.2)).toBe(true);
  });

  it('correctly rejects 0.25 for step 0.1 from min 0', () => {
    expect(isAlignedToStep(0, 0.1, 0.25)).toBe(false);
  });

  it('aligns integer steps correctly', () => {
    expect(isAlignedToStep(0, 1, 5)).toBe(true);
    expect(isAlignedToStep(0, 1, 5.5)).toBe(false);
    expect(isAlignedToStep(0, 2, 6)).toBe(true);
    expect(isAlignedToStep(0, 2, 7)).toBe(false);
  });

  it('aligns from a nonzero min', () => {
    expect(isAlignedToStep(1, 0.5, 2.5)).toBe(true);
    expect(isAlignedToStep(1, 0.5, 2.3)).toBe(false);
  });

  it('handles negative numbers', () => {
    expect(isAlignedToStep(-1, 1, 3)).toBe(true);
    expect(isAlignedToStep(-1, 0.5, -0.5)).toBe(true);
  });

  it('validates number answers with exact decimal step alignment through validateAnswer', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'number', validation: { min: 0, max: 1, step: 0.1 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }

    // 0.3 should be accepted (exact decimal: 3/10 ÷ 1/10 = 3)
    expect(validateAnswer(question.data, 0.3).success).toBe(true);
    // 0.25 should be rejected
    expect(validateAnswer(question.data, 0.25).success).toBe(false);
    // 0.7 should be accepted
    expect(validateAnswer(question.data, 0.7).success).toBe(true);
  });

  // --- Boundary vectors shared between client and server ---

  it('accepts and rejects identical text boundary vectors', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'text', validation: { minLength: 2, maxLength: 5 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }

    // Exact boundaries
    expect(validateAnswer(question.data, 'ab').success).toBe(true); // minLength=2
    expect(validateAnswer(question.data, 'abcde').success).toBe(true); // maxLength=5
    // One over / one under
    expect(validateAnswer(question.data, 'a').success).toBe(false); // < minLength
    expect(validateAnswer(question.data, 'abcdef').success).toBe(false); // > maxLength
  });

  it('accepts and rejects identical number boundary vectors', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'number', validation: { min: 0, max: 10, step: 2 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }

    // Exact boundaries
    expect(validateAnswer(question.data, 0).success).toBe(true); // min
    expect(validateAnswer(question.data, 10).success).toBe(true); // max
    expect(validateAnswer(question.data, 4).success).toBe(true); // aligned
    // One over / one under / misaligned
    expect(validateAnswer(question.data, -0.001).success).toBe(false); // < min
    expect(validateAnswer(question.data, 10.001).success).toBe(false); // > max
    expect(validateAnswer(question.data, 3).success).toBe(false); // not aligned
  });
});

// ---------------------------------------------------------------------------
// VAL-MODEQ-140: Optional defaults and empty values remain distinct
// ---------------------------------------------------------------------------

describe('VAL-MODEQ-140: Optional defaults and empty values remain distinct', () => {
  // --- Omitted optional creates no answer ---

  it('omitted optional boolean creates no answer (undefined)', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'boolean', required: false }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, undefined);
    expect(result.success).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('omitted optional number creates no answer (undefined)', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'number', required: false }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, undefined);
    expect(result.success).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it('omitted optional text creates no answer (undefined)', () => {
    const question = QuestionDefinition.safeParse(baseQuestion({ type: 'text', required: false }));
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, undefined);
    expect(result.success).toBe(true);
    expect(result.value).toBeUndefined();
  });

  // --- false and zero are real values, distinct from omitted ---

  it('false is a real value, distinct from omitted', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'boolean', required: false }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const omittedResult = validateAnswer(question.data, undefined);
    const falseResult = validateAnswer(question.data, false);
    expect(omittedResult.success).toBe(true);
    expect(falseResult.success).toBe(true);
    expect(omittedResult.value).toBeUndefined();
    expect(falseResult.value).toBe(false);
    expect(falseResult.value).not.toBe(omittedResult.value);
  });

  it('zero is a real value, distinct from omitted', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'number', required: false, validation: { min: -5, max: 5 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const omittedResult = validateAnswer(question.data, undefined);
    const zeroResult = validateAnswer(question.data, 0);
    expect(omittedResult.success).toBe(true);
    expect(zeroResult.success).toBe(true);
    expect(omittedResult.value).toBeUndefined();
    expect(zeroResult.value).toBe(0);
    expect(zeroResult.value).not.toBe(omittedResult.value);
  });

  // --- Empty string/array are explicit values, accepted only when constraints permit ---

  it('empty string is accepted when minLength is 0', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'text', required: false, validation: { minLength: 0, maxLength: 10 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, '');
    expect(result.success).toBe(true);
    expect(result.value).toBe('');
  });

  it('empty string is rejected when minLength is 1', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'text', required: false, validation: { minLength: 1, maxLength: 10 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, '');
    expect(result.success).toBe(false);
  });

  it('empty array is accepted when minSelections is 0', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({
        type: 'multiple_choice',
        required: false,
        options: makeOptions(3),
        validation: { minSelections: 0, maxSelections: 3 },
      }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, []);
    expect(result.success).toBe(true);
    expect(result.value).toEqual([]);
  });

  it('empty array is rejected when minSelections is 1', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({
        type: 'multiple_choice',
        required: false,
        options: makeOptions(3),
        validation: { minSelections: 1, maxSelections: 3 },
      }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const result = validateAnswer(question.data, []);
    expect(result.success).toBe(false);
  });

  it('empty string is distinct from omitted for optional text', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({ type: 'text', required: false, validation: { minLength: 0 } }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const omitted = validateAnswer(question.data, undefined);
    const empty = validateAnswer(question.data, '');
    expect(omitted.value).toBeUndefined();
    expect(empty.value).toBe('');
    expect(omitted.value).not.toBe(empty.value);
  });

  it('empty array is distinct from omitted for optional multiple_choice', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({
        type: 'multiple_choice',
        required: false,
        options: makeOptions(3),
        validation: { minSelections: 0 },
      }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }
    const omitted = validateAnswer(question.data, undefined);
    const empty = validateAnswer(question.data, []);
    expect(omitted.value).toBeUndefined();
    expect(empty.value).toEqual([]);
    expect(omitted.value).not.toBe(empty.value);
  });

  // --- Configured default becomes answer only when explicitly submitted ---

  it('a configured default passes the answer validator (can be an answer when submitted)', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({
        type: 'boolean',
        required: false,
        default: true,
      }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }

    // The default value itself is a valid answer when explicitly submitted.
    const result = validateAnswer(question.data, true);
    expect(result.success).toBe(true);
    expect(result.value).toBe(true);
  });

  it('omitting an optional question with a default still creates no answer', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({
        type: 'boolean',
        required: false,
        default: true,
      }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }

    // Omitting → no answer, even though a default is configured.
    const omitted = validateAnswer(question.data, undefined);
    expect(omitted.success).toBe(true);
    expect(omitted.value).toBeUndefined();
  });

  it('a configured default that is false is distinct from omission', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({
        type: 'boolean',
        required: false,
        default: false,
      }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }

    // Omitting → undefined. Submitting false → false. Distinct.
    const omitted = validateAnswer(question.data, undefined);
    const submittedFalse = validateAnswer(question.data, false);
    expect(omitted.value).toBeUndefined();
    expect(submittedFalse.value).toBe(false);
  });

  it('a configured default that is zero is distinct from omission', () => {
    const question = QuestionDefinition.safeParse(
      baseQuestion({
        type: 'number',
        required: false,
        validation: { min: 0, max: 10 },
        default: 0,
      }),
    );
    if (!question.success) {
      throw new Error('failed to parse');
    }

    const omitted = validateAnswer(question.data, undefined);
    const submittedZero = validateAnswer(question.data, 0);
    expect(omitted.value).toBeUndefined();
    expect(submittedZero.value).toBe(0);
  });
});

// Ambiguous alternatives can backtrack exponentially without an inner quantifier.
it.each(['^(a|aa)+$', '^(a|a?)+$', '^((a|aa)){30}$'])(
  'rejects ambiguous quantified group %s',
  (pattern) => {
    expect(validatePatternSafety(pattern).safe).toBe(false);
  },
);
