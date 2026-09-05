/**
 * Question bounds, canonicalization, and default enforcement.
 *
 * (VAL-MODEQ-058, VAL-MODEQ-060, VAL-MODEQ-061, VAL-MODEQ-137,
 *  VAL-MODEQ-138, VAL-MODEQ-139, VAL-MODEQ-140)
 *
 * This module owns:
 * - **Cardinality caps (058):** Max 12 questions per set. An oversized set
 *   is rejected and may be regenerated only within bounded internal retry; it
 *   is never silently truncated.
 * - **Content caps (060):** Label ≤500, help ≤2000, options ≤50, text answers
 *   ≤20000 Unicode code points.
 * - **Resource-safe patterns (137):** A text pattern is at most 256 Unicode
 *   code points and 1024 UTF-8 bytes, compiles before persistence, and uses a
 *   safe linear-time subset that rejects backreferences, lookarounds,
 *   recursion, and catastrophic forms.
 * - **Payload bounds (138):** Validation JSON depth ≤6 and ≤16384 canonical
 *   UTF-8 bytes; one set ≤131072 bytes; one complete answer body ≤65536
 *   bytes. C0/C1 controls (except newline/tab) and all bidi-control
 *   characters are rejected before storage.
 * - **Canonicalization (139):** Text is stored exactly as submitted after
 *   Unicode NFC normalization without implicit trimming; length limits count
 *   Unicode code points; decimal step alignment uses exact decimal arithmetic
 *   from the JSON number.
 * - **Optional defaults (140):** Omitted optional values create no answer;
 *   false and zero are real values; empty string/array are explicit values
 *   accepted only when constraints permit; a configured default becomes an
 *   answer only when included in explicit submission.
 */

// ---------------------------------------------------------------------------
// Bounds constants
// ---------------------------------------------------------------------------

/** Maximum number of questions in a single question set. */
export const MAX_QUESTIONS_PER_SET = 12;

/** Maximum number of options in a single choice/ordering question. */
export const MAX_OPTIONS_PER_QUESTION = 50;

/** Maximum Unicode code points in a question or option label. */
export const MAX_LABEL_CODEPOINTS = 500;

/** Maximum Unicode code points in help text. */
export const MAX_HELP_CODEPOINTS = 2000;

/** Maximum Unicode code points in an accepted text answer. */
export const MAX_TEXT_ANSWER_CODEPOINTS = 20_000;

/** Maximum Unicode code points in a text validation pattern. */
export const MAX_PATTERN_CODEPOINTS = 256;

/** Maximum UTF-8 bytes in a text validation pattern. */
export const MAX_PATTERN_UTF8_BYTES = 1024;

/** Maximum nesting depth of a validation JSON object. */
export const MAX_VALIDATION_DEPTH = 6;

/** Maximum canonical UTF-8 bytes of a validation JSON object. */
export const MAX_VALIDATION_BYTES = 16_384;

/** Maximum canonical UTF-8 bytes of a complete question set. */
export const MAX_SET_BYTES = 131_072;

/** Maximum canonical UTF-8 bytes of a complete answer submission body. */
export const MAX_ANSWER_BODY_BYTES = 65_536;

// ---------------------------------------------------------------------------
// Code-point and byte measurement
// ---------------------------------------------------------------------------

/** Count Unicode code points (not UTF-16 code units). */
export function countCodePoints(s: string): number {
  return [...s].length;
}

/** Measure the UTF-8 byte length of a string. */
export function utf8ByteLength(s: string): number {
  return Buffer.from(s, 'utf8').length;
}

/**
 * Measure the nesting depth of a JSON value. Scalars and arrays have depth 0.
 * Objects have depth 1 + max(depth of values).
 */
export function measureJsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 0;
    }
    return Math.max(...value.map(measureJsonDepth));
  }
  const values = Object.values(value as Record<string, unknown>);
  if (values.length === 0) {
    return 1;
  }
  return 1 + Math.max(...values.map(measureJsonDepth));
}

/** Measure the canonical UTF-8 byte length of a JSON-serializable value. */
export function measureJsonBytes(value: unknown): number {
  return Buffer.from(JSON.stringify(value), 'utf8').length;
}

// ---------------------------------------------------------------------------
// Resource-safe text pattern validation (VAL-MODEQ-137)
// ---------------------------------------------------------------------------

export interface PatternSafetyResult {
  safe: boolean;
  /** Present when `safe` is false. */
  reason?: string;
}

/**
 * Validate that a text pattern is resource-safe.
 *
 * A safe pattern:
 * - Is at most 256 Unicode code points and 1024 UTF-8 bytes.
 * - Compiles to a valid RegExp.
 * - Does not use backreferences (`\1`–`\9`, `\k<name>`).
 * - Does not use lookarounds (`(?=`, `(?!`, `(?<=`, `(?<!`).
 * - Does not use recursion (`(?R)`, `(?0)`–`(?9)`).
 * - Does not use named capture groups (which enable backreferences).
 * - Does not contain nested quantifiers that cause catastrophic backtracking.
 */
export function validatePatternSafety(pattern: string): PatternSafetyResult {
  // 1. Code-point count.
  const cp = countCodePoints(pattern);
  if (cp > MAX_PATTERN_CODEPOINTS) {
    return {
      safe: false,
      reason: `pattern exceeds ${MAX_PATTERN_CODEPOINTS} Unicode code points (${cp})`,
    };
  }

  // 2. UTF-8 byte count.
  const bytes = utf8ByteLength(pattern);
  if (bytes > MAX_PATTERN_UTF8_BYTES) {
    return {
      safe: false,
      reason: `pattern exceeds ${MAX_PATTERN_UTF8_BYTES} UTF-8 bytes (${bytes})`,
    };
  }

  // 3. Compiles.
  try {
    new RegExp(pattern);
  } catch (e) {
    return {
      safe: false,
      reason: `pattern does not compile: ${(e as Error).message}`,
    };
  }

  // 4. Reject backreferences, lookarounds, recursion, named groups.
  const unsafeFeature = detectUnsafeRegexFeatures(pattern);
  if (unsafeFeature) {
    return { safe: false, reason: unsafeFeature };
  }

  // 5. Reject catastrophic backtracking (nested quantifiers).
  if (hasNestedQuantifiers(pattern)) {
    return {
      safe: false,
      reason: 'pattern contains nested quantifiers that may cause catastrophic backtracking',
    };
  }

  return { safe: true };
}

/**
 * Detect backreferences, lookarounds, recursion, and named capture groups
 * outside of character classes.
 */
function detectUnsafeRegexFeatures(pattern: string): string | null {
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    // Skip character classes: [...]
    if (ch === '[') {
      i = skipCharClass(pattern, i);
      continue;
    }

    // Skip escaped characters and check for backreferences.
    if (ch === '\\') {
      const next = pattern[i + 1];
      const backrefResult = checkBackreference(next);
      if (backrefResult) {
        return backrefResult;
      }
      i += 2;
      continue;
    }

    // Check for group prefixes: (?...
    if (ch === '(' && pattern[i + 1] === '?') {
      const groupResult = checkGroupPrefix(pattern, i);
      if (groupResult) {
        return groupResult;
      }
    }

    i++;
  }

  return null;
}

/** Skip past a character class `[...]`, handling nested escapes. */
function skipCharClass(pattern: string, start: number): number {
  let i = start + 1;
  const len = pattern.length;
  while (i < len) {
    if (pattern[i] === '\\') {
      i += 2;
    } else if (pattern[i] === ']') {
      return i + 1;
    } else {
      i++;
    }
  }
  return i;
}

/** Check if an escaped character is a backreference. */
function checkBackreference(next: string | undefined): string | null {
  if (next !== undefined && next >= '1' && next <= '9') {
    return `backreference \\${next} is not allowed in safe patterns`;
  }
  if (next === 'k') {
    return 'named backreference \\k<...> is not allowed in safe patterns';
  }
  return null;
}

/** Check if a `(?` group prefix is an unsafe feature. */
function checkGroupPrefix(pattern: string, i: number): string | null {
  const afterQ = pattern[i + 2];
  // Lookahead: (?= or (?!
  if (afterQ === '=' || afterQ === '!') {
    return `lookahead (?${afterQ}...) is not allowed in safe patterns`;
  }
  // Lookbehind or named group: (?<...
  if (afterQ === '<' && pattern[i + 3] !== undefined) {
    const afterLt = pattern[i + 3];
    if (afterLt === '=' || afterLt === '!') {
      return `lookbehind (?<${afterLt}...) is not allowed in safe patterns`;
    }
    return 'named capture group (?<name>...) is not allowed in safe patterns';
  }
  // Recursion / subexpression: (?R), (?0), (?1)-(?9)
  if (afterQ === 'R' || (afterQ !== undefined && afterQ >= '0' && afterQ <= '9')) {
    return `recursion/subexpression reference (?${afterQ}) is not allowed in safe patterns`;
  }
  return null;
}

/**
 * Detect nested quantifiers that may cause catastrophic backtracking.
 *
 * A nested quantifier is a quantifier (+, *, ?, {n,m}) inside a group that is
 * itself quantified. For example: `(a+)+`, `(a*)*`, `(a+)*`, `(a?)+`.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  let i = 0;
  const len = pattern.length;

  // Stack: each entry tracks whether the group at that depth contains a
  // quantifier.
  const stack: boolean[] = [];

  while (i < len) {
    const ch = pattern[i];

    if (ch === '[') {
      i = skipCharClass(pattern, i);
      continue;
    }

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === '(') {
      stack.push(false);
      i = skipGroupPrefix(pattern, i + 1);
      continue;
    }

    if (ch === ')' && stack.length > 0) {
      const groupHasQuantifier = stack.pop()!;
      i++;
      // Quantified groups can hide ambiguous alternatives as well as nested
      // quantifiers. Accept repetition only on individual atoms/classes.
      if (
        i < len &&
        (isQuantifierChar(pattern[i]) || tryConsumeBraceQuantifier(pattern, i).consumed)
      ) {
        return true;
      }
      if (groupHasQuantifier) {
        markGroupHasQuantifier(stack);
      }
      continue;
    }

    // Simple quantifiers: +, *, ?
    if (isQuantifierChar(ch)) {
      markGroupHasQuantifier(stack);
      i++;
      if (i < len && (pattern[i] === '?' || pattern[i] === '+')) {
        i++;
      }
      continue;
    }

    // Brace quantifier: {n}, {n,}, {n,m}
    const braceResult = tryConsumeBraceQuantifier(pattern, i);
    if (braceResult.consumed) {
      markGroupHasQuantifier(stack);
      i = braceResult.nextIndex;
      continue;
    }

    i++;
  }

  return false;
}

/** Skip a non-capturing/lookahead group prefix after `(`. Returns new index. */
function skipGroupPrefix(pattern: string, i: number): number {
  if (i < pattern.length && pattern[i] === '?') {
    i++;
    if (i < pattern.length && pattern[i] === '<') {
      i++;
    }
  }
  return i;
}

/** Mark the current (innermost) group as containing a quantifier. */
function markGroupHasQuantifier(stack: boolean[]): void {
  if (stack.length > 0) {
    stack[stack.length - 1] = true;
  }
}

/** Try to consume a `{n}`, `{n,}`, or `{n,m}` brace quantifier. */
function tryConsumeBraceQuantifier(
  pattern: string,
  i: number,
): { consumed: boolean; nextIndex: number } {
  if (pattern[i] !== '{') {
    return { consumed: false, nextIndex: i };
  }
  const closeIdx = pattern.indexOf('}', i);
  if (closeIdx === -1) {
    return { consumed: false, nextIndex: i + 1 };
  }
  const inner = pattern.slice(i + 1, closeIdx);
  if (/^\d+(,\d*)?$/.test(inner)) {
    return { consumed: true, nextIndex: closeIdx + 1 };
  }
  return { consumed: false, nextIndex: i + 1 };
}

/** True if `ch` is a simple quantifier character. */
function isQuantifierChar(ch: string): boolean {
  return ch === '+' || ch === '*' || ch === '?';
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic for step alignment (VAL-MODEQ-139)
// ---------------------------------------------------------------------------

interface ExactDecimal {
  /** Integer significand (value = int / 10^scale). */
  int: bigint;
  /** Number of decimal places. */
  scale: number;
}

/**
 * Parse a JavaScript number (originating from a JSON number) into an exact
 * decimal representation. Uses `String(n)` which produces the shortest
 * decimal representation that round-trips to the same double, matching the
 * user's intended JSON value.
 */
function parseExactDecimal(n: number): ExactDecimal {
  if (!Number.isFinite(n)) {
    return { int: 0n, scale: 0 };
  }
  const str = String(n);
  const negative = str.startsWith('-');
  const absStr = negative ? str.slice(1) : str;

  // Handle scientific notation.
  const eIndex = absStr.indexOf('e');
  if (eIndex !== -1 || absStr.indexOf('E') !== -1) {
    const [mantissa, expStr] = absStr.split(/[eE]/);
    const exp = parseInt(expStr, 10);
    const [intPart, decPart] = mantissa.split('.');
    const digits = (intPart + (decPart || '')).replace(/^0+/, '') || '0';
    const originalScale = (decPart || '').length;
    const scale = originalScale - exp;
    if (scale <= 0) {
      const result = BigInt(digits + '0'.repeat(-scale));
      return { int: negative ? -result : result, scale: 0 };
    }
    const result = BigInt(digits);
    return { int: negative ? -result : result, scale };
  }

  const [intPart, decPart] = absStr.split('.');
  const digits = (intPart + (decPart || '')).replace(/^0+/, '') || '0';
  const scale = (decPart || '').length;
  const result = BigInt(digits);
  return { int: negative ? -result : result, scale };
}

/** Scale a decimal to a target scale, returning the integer at that scale. */
function scaleTo(d: ExactDecimal, targetScale: number): bigint {
  if (d.scale === targetScale) {
    return d.int;
  }
  if (d.scale < targetScale) {
    return d.int * 10n ** BigInt(targetScale - d.scale);
  }
  // This should not happen if targetScale is the max of all scales.
  return d.int / 10n ** BigInt(d.scale - targetScale);
}

/**
 * Check whether `value` is aligned to `step` from `min` using exact decimal
 * arithmetic. This avoids floating-point rounding errors that would
 * incorrectly reject valid values like 0.3 with step 0.1 from min 0.
 */
export function isAlignedToStep(min: number, step: number, value: number): boolean {
  const minDec = parseExactDecimal(min);
  const stepDec = parseExactDecimal(step);
  const valDec = parseExactDecimal(value);

  const maxScale = Math.max(minDec.scale, stepDec.scale, valDec.scale);

  const minInt = scaleTo(minDec, maxScale);
  const stepInt = scaleTo(stepDec, maxScale);
  const valInt = scaleTo(valDec, maxScale);

  const diff = valInt - minInt;

  if (diff < 0n) {
    return false;
  }

  if (stepInt === 0n) {
    return false;
  }

  return diff % stepInt === 0n;
}

// ---------------------------------------------------------------------------
// NFC text normalization (VAL-MODEQ-139)
// ---------------------------------------------------------------------------

/**
 * Normalize text to Unicode NFC form without implicit trimming.
 * Whitespace (including leading/trailing) is preserved exactly.
 */
export function normalizeTextNFC(text: string): string {
  return text.normalize('NFC');
}

// ---------------------------------------------------------------------------
// Unsafe control character detection (VAL-MODEQ-138)
// ---------------------------------------------------------------------------

/* eslint-disable no-control-regex, no-misleading-character-class */
/**
 * Reject C0/C1 control characters (except TAB/LF/CR) and all BiDi
 * override/embedding/isolate control characters, zero-width characters,
 * and BOM.
 */
const UNSAFE_CODEPOINT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B\u200C\u200D\uFEFF]/;
/* eslint-enable no-control-regex, no-misleading-character-class */

/** True when `s` contains no unsafe control or BiDi characters. */
export function isSafeText(s: string): boolean {
  return !UNSAFE_CODEPOINT_RE.test(s);
}

// ---------------------------------------------------------------------------
// Set-level bounds validation (VAL-MODEQ-058, VAL-MODEQ-138)
// ---------------------------------------------------------------------------

export interface SetValidationResult {
  valid: boolean;
  /** Present when `valid` is false. */
  errors: string[];
}

/**
 * Validate set-level bounds for a collection of question definitions.
 *
 * Checks:
 * - Cardinality: 1–12 questions per set (VAL-MODEQ-058).
 * - Total canonical size: ≤131072 bytes (VAL-MODEQ-138).
 */
export function validateQuestionSetBounds(questions: unknown[]): SetValidationResult {
  const errors: string[] = [];

  if (questions.length > MAX_QUESTIONS_PER_SET) {
    errors.push(
      `question set exceeds maximum of ${MAX_QUESTIONS_PER_SET} cards (${questions.length})`,
    );
  }

  if (questions.length < 1) {
    errors.push('question set must contain at least one question');
  }

  const totalBytes = measureJsonBytes(questions);
  if (totalBytes > MAX_SET_BYTES) {
    errors.push(`question set exceeds maximum of ${MAX_SET_BYTES} bytes (${totalBytes})`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a complete answer submission body is within the byte limit.
 * (VAL-MODEQ-138)
 */
export function validateAnswerBodySize(answerBody: unknown): SetValidationResult {
  const bytes = measureJsonBytes(answerBody);
  if (bytes > MAX_ANSWER_BODY_BYTES) {
    return {
      valid: false,
      errors: [`answer body exceeds maximum of ${MAX_ANSWER_BODY_BYTES} bytes (${bytes})`],
    };
  }
  return { valid: true, errors: [] };
}

/**
 * Validate the validation JSON of a question definition for depth and size.
 * (VAL-MODEQ-138)
 */
export function validateValidationJson(validation: unknown): SetValidationResult {
  if (validation === undefined || validation === null) {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];
  const depth = measureJsonDepth(validation);
  if (depth > MAX_VALIDATION_DEPTH) {
    errors.push(`validation JSON depth ${depth} exceeds maximum of ${MAX_VALIDATION_DEPTH}`);
  }

  const bytes = measureJsonBytes(validation);
  if (bytes > MAX_VALIDATION_BYTES) {
    errors.push(`validation JSON size ${bytes} bytes exceeds maximum of ${MAX_VALIDATION_BYTES}`);
  }

  return { valid: errors.length === 0, errors };
}
