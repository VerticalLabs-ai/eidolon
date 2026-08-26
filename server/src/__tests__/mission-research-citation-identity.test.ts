import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  resolveQuoteLocator,
  createCitationIdentity,
  type CitationLocator,
} from '../services/mission/research/citation-identity.js';
import { computeQuoteHash } from '../services/mission/research/source-normalization.js';

/**
 * Repeated quotes require an unambiguous locator (VAL-RES-097).
 * Citations bind to the exact immutable source revision and artifact revision
 * and never retarget a newer source revision (architecture: citations never
 * silently move to a newer source).
 */

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const TEXT = 'alpha beta alpha gamma alpha delta';

describe('resolveQuoteLocator (VAL-RES-097)', () => {
  it('accepts a unique quote without a locator', () => {
    const r = resolveQuoteLocator(TEXT, 'beta');
    expect(r.kind).toBe('unique');
  });

  it('rejects a repeated quote without a locator as ambiguous', () => {
    const r = resolveQuoteLocator(TEXT, 'alpha');
    expect(r.kind).toBe('ambiguous');
    expect(r.reason).toBe('AMBIGUOUS_QUOTE_LOCATOR_REQUIRED');
  });

  it('accepts a repeated quote when the locator pins one occurrence', () => {
    const locator: CitationLocator = { charStart: 0, charEnd: 5 };
    const r = resolveQuoteLocator(TEXT, 'alpha', locator);
    expect(r.kind).toBe('located');
    expect(r.charStart).toBe(0);
    expect(r.charEnd).toBe(5);
  });

  it('rejects a locator that does not match the quote at the offsets', () => {
    const locator: CitationLocator = { charStart: 6, charEnd: 10 };
    const r = resolveQuoteLocator(TEXT, 'alpha', locator);
    expect(r.kind).toBe('rejected');
    expect(r.reason).toBe('LOCATOR_QUOTE_MISMATCH');
  });

  it('rejects a quote that does not appear at all', () => {
    const r = resolveQuoteLocator(TEXT, 'zeta');
    expect(r.kind).toBe('rejected');
    expect(r.reason).toBe('QUOTE_NOT_FOUND');
  });

  it('rejects an invalid locator range (start >= end)', () => {
    const r = resolveQuoteLocator(TEXT, 'beta', { charStart: 5, charEnd: 5 });
    expect(r.kind).toBe('rejected');
    expect(r.reason).toBe('LOCATOR_INVALID');
  });

  it('normalizes the quote before matching (NFC / line endings)', () => {
    const text = 'caf\u00e9\r\nrepeat caf\u00e9';
    // decomposed quote normalizes to composed and matches.
    const r = resolveQuoteLocator(text, 'cafe\u0301');
    expect(r.kind).toBe('ambiguous');
  });
});

describe('createCitationIdentity (bind to exact revisions)', () => {
  const baseInput = {
    companyId: 'comp-1',
    projectId: 'proj-1',
    runId: 'run-1',
    sourceRevisionId: 'src-rev-1',
    artifactId: 'art-1',
    artifactRevisionId: 'art-rev-1',
    ordinal: 1,
    quote: 'beta',
    frozenTitle: 'Article',
    frozenAuthor: 'Jane',
    frozenCanonicalUrl: 'https://example.com/article',
    frozenRetrievedAt: '2026-08-24T12:00:00Z',
    frozenProvider: 'tavily',
    normalizedSourceText: TEXT,
  };

  it('binds to the exact source and artifact revision and computes a quote hash', () => {
    const c = createCitationIdentity(baseInput);
    expect(c.sourceRevisionId).toBe('src-rev-1');
    expect(c.artifactRevisionId).toBe('art-rev-1');
    expect(c.quoteHash).toBe(computeQuoteHash('beta'));
    expect(c.quoteHash).toBe(sha256('beta'));
  });

  it('captures frozen display metadata at creation time (VAL-RES-113)', () => {
    const c = createCitationIdentity(baseInput);
    expect(c.frozenTitle).toBe('Article');
    expect(c.frozenAuthor).toBe('Jane');
    expect(c.frozenCanonicalUrl).toBe('https://example.com/article');
    expect(c.frozenProvider).toBe('tavily');
  });

  it('creates a metadata-only citation for an empty quote (fix-ut-m5-citation-quote-validation)', () => {
    const c = createCitationIdentity({ ...baseInput, quote: '' });
    expect(c.quote).toBe('');
    expect(c.quoteHash).toBe(computeQuoteHash(''));
    expect(c.charStart).toBeUndefined();
    expect(c.charEnd).toBeUndefined();
  });

  it('rejects a missing source or artifact revision id', () => {
    expect(() => createCitationIdentity({ ...baseInput, sourceRevisionId: '' })).toThrow();
    expect(() => createCitationIdentity({ ...baseInput, artifactRevisionId: '' })).toThrow();
  });

  it('requires a non-negative ordinal', () => {
    expect(() => createCitationIdentity({ ...baseInput, ordinal: -1 })).toThrow();
  });

  it('records a resolved locator when provided and valid', () => {
    const c = createCitationIdentity({
      ...baseInput,
      quote: 'alpha',
      locator: { charStart: 0, charEnd: 5 },
      normalizedSourceText: TEXT,
    });
    expect(c.charStart).toBe(0);
    expect(c.charEnd).toBe(5);
  });

  it('rejects an ambiguous repeated quote when no locator is provided', () => {
    expect(() => createCitationIdentity({ ...baseInput, quote: 'alpha' })).toThrow(/AMBIGUOUS/);
  });

  it('rejects fail-closed when neither locator nor source text is provided', () => {
    expect(() => createCitationIdentity({ ...baseInput, normalizedSourceText: undefined })).toThrow(
      /AMBIGUOUS/,
    );
  });

  it('produces a deterministic identity for identical inputs', () => {
    expect(createCitationIdentity(baseInput)).toEqual(createCitationIdentity(baseInput));
  });
});

// ---------------------------------------------------------------------------
// Regression: Unicode scalar value offsets for astral characters (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('VAL-RES-112: Astral character offset conversion in citation identity', () => {
  // 😀 is U+1F600 (surrogate pair = 2 UTF-16 code units, 1 scalar value)
  const ASTRAL_TEXT = '😀 Hello world 🎉 end';

  it('resolveQuoteLocator returns scalar offsets for unique quote with astral chars', () => {
    const r = resolveQuoteLocator(ASTRAL_TEXT, 'Hello');
    expect(r.kind).toBe('unique');
    expect(r.charStart).toBe(2); // 😀(1) + space(1) = 2
    expect(r.charEnd).toBe(7); // 2 + 5 = 7
  });

  it('resolveQuoteLocator accepts scalar offsets for locator with astral chars', () => {
    const r = resolveQuoteLocator(ASTRAL_TEXT, 'Hello', {
      charStart: 2,
      charEnd: 7,
    });
    expect(r.kind).toBe('located');
    expect(r.charStart).toBe(2);
    expect(r.charEnd).toBe(7);
  });

  it('resolveQuoteLocator rejects invalid scalar offsets for astral text', () => {
    // charStart 1 would be in the middle of the surrogate pair — invalid scalar offset
    const r = resolveQuoteLocator(ASTRAL_TEXT, 'Hello', {
      charStart: 1,
      charEnd: 7,
    });
    expect(r.kind).toBe('rejected');
    expect(r.reason).toBe('LOCATOR_QUOTE_MISMATCH');
  });

  it('createCitationIdentity stores scalar offsets for text with astral chars', () => {
    const c = createCitationIdentity({
      companyId: 'comp-1',
      projectId: 'proj-1',
      runId: 'run-1',
      sourceRevisionId: 'src-rev-1',
      artifactId: 'art-1',
      artifactRevisionId: 'art-rev-1',
      ordinal: 0,
      quote: 'Hello',
      frozenCanonicalUrl: 'https://example.com/article',
      frozenRetrievedAt: '2026-08-24T12:00:00Z',
      frozenProvider: 'tavily',
      normalizedSourceText: ASTRAL_TEXT,
    });
    expect(c.charStart).toBe(2);
    expect(c.charEnd).toBe(7);
  });

  it('createCitationIdentity stores scalar offsets with locator for astral text', () => {
    const c = createCitationIdentity({
      companyId: 'comp-1',
      projectId: 'proj-1',
      runId: 'run-1',
      sourceRevisionId: 'src-rev-1',
      artifactId: 'art-1',
      artifactRevisionId: 'art-rev-1',
      ordinal: 0,
      quote: 'Hello',
      locator: { charStart: 2, charEnd: 7 },
      frozenCanonicalUrl: 'https://example.com/article',
      frozenRetrievedAt: '2026-08-24T12:00:00Z',
      frozenProvider: 'tavily',
      normalizedSourceText: ASTRAL_TEXT,
    });
    expect(c.charStart).toBe(2);
    expect(c.charEnd).toBe(7);
  });

  it('BMP-only text offsets are unchanged (backward compatible)', () => {
    const r = resolveQuoteLocator(TEXT, 'beta');
    expect(r.kind).toBe('unique');
    expect(r.charStart).toBe(6); // 'alpha ' = 6
    expect(r.charEnd).toBe(10); // 6 + 4 = 10
  });
});
