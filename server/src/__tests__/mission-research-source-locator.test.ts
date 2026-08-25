import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  validateSourceLocator,
  verifyQuoteIntegrity,
  type SourceLocator,
} from '../services/mission/research/source-locator.js';
import { computeQuoteHash } from '../services/mission/research/source-normalization.js';

/**
 * VAL-RES-024: Citation exact quote integrity.
 * VAL-RES-025: Citation source locator integrity.
 *
 * A web citation includes canonical URL, exact quote, prefix, suffix, optional
 * section, and offsets against one exact source revision. The server-side
 * locator validator rejects invalid, out-of-range, contradictory, or ambiguous
 * locators atomically. Quote integrity verifies the exact quote occurs in the
 * normalized source text and its SHA-256 quote hash matches.
 */

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const SOURCE = 'The quick brown fox jumps over the lazy dog. The quick brown fox runs away.';

describe('VAL-RES-024: verifyQuoteIntegrity', () => {
  it('confirms a quote present in the normalized text with a matching hash', () => {
    const quote = 'jumps over the lazy dog';
    const r = verifyQuoteIntegrity(SOURCE, quote, computeQuoteHash(quote));
    expect(r.valid).toBe(true);
    expect(r.quoteHashMatches).toBe(true);
  });

  it('rejects a quote absent from the normalized text', () => {
    const r = verifyQuoteIntegrity(SOURCE, 'jumps over the energetic dog', sha256('x'));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('QUOTE_NOT_FOUND');
  });

  it('rejects a quote whose hash does not match the recomputed hash', () => {
    const quote = 'jumps over the lazy dog';
    const r = verifyQuoteIntegrity(SOURCE, quote, sha256('wrong-hash'));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('QUOTE_HASH_MISMATCH');
    expect(r.quoteHashMatches).toBe(false);
  });

  it('normalizes the quote and source before matching (NFC/CR/LF)', () => {
    const text = 'caf\u00e9\r\nbar';
    const quote = 'cafe\u0301\nbar'; // decomposed + LF
    const r = verifyQuoteIntegrity(text, quote, computeQuoteHash(quote));
    expect(r.valid).toBe(true);
  });

  it('reports the matched occurrence range when valid and unique', () => {
    const quote = 'lazy dog';
    const r = verifyQuoteIntegrity(SOURCE, quote, computeQuoteHash(quote));
    expect(r.charStart).toBe(SOURCE.indexOf('lazy dog'));
    expect(r.charEnd).toBe(r.charStart! + quote.length);
  });
});

describe('VAL-RES-025: validateSourceLocator', () => {
  const quote = 'jumps over the lazy dog';
  const uniqueStart = SOURCE.indexOf(quote);
  const locator: SourceLocator = {
    canonicalUrl: 'https://example.com/article',
    quote,
    prefix: 'brown fox ',
    suffix: '. The quick',
    charStart: uniqueStart,
    charEnd: uniqueStart + quote.length,
  };

  it('accepts a valid locator with matching prefix/suffix/offsets/quote', () => {
    const r = validateSourceLocator(SOURCE, locator);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a valid locator without a section (section is optional)', () => {
    const r = validateSourceLocator(SOURCE, { ...locator, section: undefined });
    expect(r.valid).toBe(true);
  });

  it('accepts a valid locator with a section label', () => {
    const r = validateSourceLocator(SOURCE, { ...locator, section: 'intro' });
    expect(r.valid).toBe(true);
  });

  it('rejects a locator whose offsets do not bracket the quote', () => {
    const r = validateSourceLocator(SOURCE, {
      ...locator,
      charStart: uniqueStart + 2,
      charEnd: uniqueStart + 2 + quote.length,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/offset|quote.*mismatch|bracket/i);
  });

  it('rejects out-of-range offsets', () => {
    const r = validateSourceLocator(SOURCE, {
      ...locator,
      charStart: SOURCE.length - 3,
      charEnd: SOURCE.length + 10,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/range|out.of.range|bounds/i);
  });

  it('rejects contradictory prefix context', () => {
    const r = validateSourceLocator(SOURCE, { ...locator, prefix: 'green fox ' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/prefix/i);
  });

  it('rejects contradictory suffix context', () => {
    const r = validateSourceLocator(SOURCE, { ...locator, suffix: '! Then the slow' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/suffix/i);
  });

  it('rejects start >= end', () => {
    const r = validateSourceLocator(SOURCE, {
      ...locator,
      charStart: uniqueStart,
      charEnd: uniqueStart,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/range|start.*end|invalid/i);
  });

  it('rejects an ambiguous repeated quote when offsets are not supplied', () => {
    const repeated = 'The quick brown fox';
    const r = validateSourceLocator(SOURCE, {
      canonicalUrl: 'https://example.com/article',
      quote: repeated,
      prefix: '',
      suffix: '',
      // no offsets
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/ambiguous|locator.*required/i);
  });

  it('accepts a repeated quote pinned by correct offsets', () => {
    const repeated = 'The quick brown fox';
    const first = SOURCE.indexOf(repeated);
    const second = SOURCE.indexOf(repeated, first + 1);
    expect(second).toBeGreaterThan(first);
    const r = validateSourceLocator(SOURCE, {
      canonicalUrl: 'https://example.com/article',
      quote: repeated,
      prefix: '',
      suffix: ' jumps',
      charStart: first,
      charEnd: first + repeated.length,
    });
    expect(r.valid).toBe(true);
  });

  it('rejects an empty quote atomically (no partial validation leaks)', () => {
    const r = validateSourceLocator(SOURCE, {
      canonicalUrl: 'https://example.com/article',
      quote: '',
      prefix: '',
      suffix: '',
      charStart: 0,
      charEnd: 0,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/empty/i);
  });

  it('rejects a missing canonicalUrl', () => {
    const r = validateSourceLocator(SOURCE, {
      ...locator,
      canonicalUrl: '',
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/canonicalUrl|url/i);
  });
});

describe('VAL-RES-024/025: prefix/suffix bounds', () => {
  it('rejects a prefix longer than 256 bytes (UTF-8)', () => {
    const longPrefix = 'x'.repeat(257);
    const r = validateSourceLocator(SOURCE, { ...makeLocator(), prefix: longPrefix });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/prefix.*256|prefix.*bound|prefix.*exceed/i);
  });

  it('rejects a suffix longer than 256 bytes (UTF-8)', () => {
    const longSuffix = 'y'.repeat(257);
    const r = validateSourceLocator(SOURCE, { ...makeLocator(), suffix: longSuffix });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/suffix.*256|suffix.*bound|suffix.*exceed/i);
  });
});

function makeLocator(): SourceLocator {
  const quote = 'jumps over the lazy dog';
  const start = SOURCE.indexOf(quote);
  return {
    canonicalUrl: 'https://example.com/article',
    quote,
    prefix: 'brown fox ',
    suffix: '. The quick',
    charStart: start,
    charEnd: start + quote.length,
  };
}

// ---------------------------------------------------------------------------
// Regression: Unicode scalar value offsets for astral characters (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('VAL-RES-112: Unicode scalar value offsets for astral characters', () => {
  // 😀 is U+1F600 (surrogate pair = 2 UTF-16 code units, 1 scalar value)
  const ASTRAL_SOURCE = '😀 Hello world 🎉 end';

  it('verifyQuoteIntegrity returns scalar offsets for text with astral chars', () => {
    const quote = 'Hello';
    const r = verifyQuoteIntegrity(ASTRAL_SOURCE, quote, computeQuoteHash(quote));
    expect(r.valid).toBe(true);
    expect(r.charStart).toBe(2); // scalar: 😀(1) + space(1) = 2
    expect(r.charEnd).toBe(7); // 2 + 5 = 7
  });

  it('verifyQuoteIntegrity returns scalar offsets for quote after astral chars', () => {
    const quote = 'end';
    const r = verifyQuoteIntegrity(ASTRAL_SOURCE, quote, computeQuoteHash(quote));
    expect(r.valid).toBe(true);
    // 😀(1) + space(1) + Hello(5) + space(1) + world(5) + space(1) + 🎉(1) + space(1) = 16
    expect(r.charStart).toBe(16);
    expect(r.charEnd).toBe(19);
  });

  it('validateSourceLocator accepts scalar offsets for text with astral chars', () => {
    const quote = 'Hello';
    const r = validateSourceLocator(ASTRAL_SOURCE, {
      canonicalUrl: 'https://example.com/article',
      quote,
      prefix: '😀 ',
      suffix: ' world',
      charStart: 2, // scalar offset
      charEnd: 7, // scalar offset
    });
    expect(r.valid).toBe(true);
    expect(r.charStart).toBe(2);
    expect(r.charEnd).toBe(7);
  });

  it('validateSourceLocator returns scalar offsets when no offsets provided', () => {
    const quote = 'world';
    const r = validateSourceLocator(ASTRAL_SOURCE, {
      canonicalUrl: 'https://example.com/article',
      quote,
      prefix: 'Hello ',
      suffix: ' 🎉',
    });
    expect(r.valid).toBe(true);
    // Scalar: 😀(1) + space(1) + Hello(5) + space(1) = 8
    expect(r.charStart).toBe(8);
    expect(r.charEnd).toBe(13);
  });

  it('BMP-only text offsets are unchanged (backward compatible)', () => {
    const quote = 'jumps over the lazy dog';
    const r = verifyQuoteIntegrity(SOURCE, quote, computeQuoteHash(quote));
    expect(r.valid).toBe(true);
    expect(r.charStart).toBe(SOURCE.indexOf(quote));
    expect(r.charEnd).toBe(r.charStart! + quote.length);
  });
});
