import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  SOURCE_NORMALIZATION_VERSION,
  normalizeText,
  computeContentHash,
  computeCanonicalUrlHash,
  computeQuoteHash,
  boundMetadata,
  normalizeSourceForPersistence,
} from '../services/mission/research/source-normalization.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Source normalization is versioned and deterministic (VAL-RES-112).
 * Canonical URL deduplication (VAL-RES-019) and content-hash deduplication
 * (VAL-RES-020) depend on these hashes being stable across calls, restarts,
 * and processes. Source metadata is normalized and bounded (VAL-RES-098).
 */

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('SOURCE_NORMALIZATION_VERSION (VAL-RES-112)', () => {
  it('exposes a positive integer normalization version', () => {
    expect(SOURCE_NORMALIZATION_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(SOURCE_NORMALIZATION_VERSION)).toBe(true);
  });
});

describe('normalizeText (determinism, VAL-RES-112)', () => {
  it('NFC-normalizes Unicode and strips a leading BOM', () => {
    const composed = 'caf\u00e9'; // é precomposed
    const decomposed = 'cafe\u0301'; // e + combining acute
    expect(normalizeText(`\uFEFF${decomposed}`)).toBe(composed);
  });

  it('normalizes CRLF and CR line endings to LF', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('is idempotent', () => {
    const raw = '\uFEFFcaf\u00e9\r\nline two\r';
    expect(normalizeText(normalizeText(raw))).toBe(normalizeText(raw));
  });

  it('does not collapse internal whitespace (content-preserving)', () => {
    expect(normalizeText('a   b')).toBe('a   b');
  });
});

describe('computeContentHash (VAL-RES-020, VAL-RES-112)', () => {
  it('produces a lowercase SHA-256 hex of the normalized UTF-8 text', () => {
    const text = 'caf\u00e9\nline two';
    expect(computeContentHash(text)).toBe(sha256(text));
    expect(computeContentHash(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls (restart-stable)', () => {
    expect(computeContentHash('hello')).toBe(computeContentHash('hello'));
  });

  it('differs when normalized text differs', () => {
    expect(computeContentHash('hello')).not.toBe(computeContentHash('hello!'));
  });

  it('hashes the normalized form, not the raw input', () => {
    // decomposed and composed normalize to the same text → same hash.
    expect(computeContentHash('cafe\u0301')).toBe(computeContentHash('caf\u00e9'));
  });
});

describe('computeCanonicalUrlHash (VAL-RES-019)', () => {
  it('produces a lowercase SHA-256 hex of the canonical URL', () => {
    const url = 'https://example.com/path';
    expect(computeCanonicalUrlHash(url)).toBe(sha256(url));
    expect(computeCanonicalUrlHash(url)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeCanonicalUrlHash('https://example.com/a')).toBe(
      computeCanonicalUrlHash('https://example.com/a'),
    );
  });
});

describe('computeQuoteHash (VAL-RES-097)', () => {
  it('produces a lowercase SHA-256 hex of the exact normalized quote', () => {
    const quote = 'exact quote';
    expect(computeQuoteHash(quote)).toBe(sha256(quote));
    expect(computeQuoteHash(quote)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('boundMetadata (VAL-RES-098)', () => {
  it('NFC-normalizes and caps overlong fields to bounded maximums', () => {
    const long = 'x'.repeat(1000);
    const m = boundMetadata({
      title: long,
      author: long,
      mimeType: 'text/html; charset=utf-8',
      language: 'en-US',
      publishedAt: '2026-08-24T00:00:00Z',
    });
    expect(m.title?.length).toBeLessThanOrEqual(500);
    expect(m.author?.length).toBeLessThanOrEqual(200);
    expect(m.mimeType?.length).toBeLessThanOrEqual(100);
    expect(m.language?.length).toBeLessThanOrEqual(10);
  });

  it('NFC-normalizes field values', () => {
    const m = boundMetadata({ title: 'cafe\u0301' });
    expect(m.title).toBe('caf\u00e9');
  });

  it('drops null/non-string values', () => {
    const m = boundMetadata({
      title: null,
      author: undefined,
      mimeType: 42,
      language: 'en',
    });
    expect(m.title).toBeUndefined();
    expect(m.author).toBeUndefined();
    expect(m.mimeType).toBeUndefined();
    expect(m.language).toBe('en');
  });

  it('rejects a non-finite publishedAt but keeps a valid ISO timestamp', () => {
    const m = boundMetadata({ publishedAt: '2026-08-24T00:00:00Z' });
    expect(m.publishedAt).toBe('2026-08-24T00:00:00Z');
    const bad = boundMetadata({ publishedAt: 'not-a-date' });
    expect(bad.publishedAt).toBeUndefined();
  });
});

describe('normalizeSourceForPersistence (VAL-RES-019, 020, 098, 112)', () => {
  const baseSource: NormalizedResearchSource = {
    canonicalUrl: 'https://example.com/article',
    title: 'Article',
    author: 'Jane',
    publishedAt: '2026-08-24T00:00:00Z',
    rank: 0,
    score: 0.9,
    retrievedAt: '2026-08-24T12:00:00Z',
    mimeType: 'text/html',
    language: 'en',
    text: 'caf\u00e9 content',
    byteCount: 12,
    injectionRiskLabels: [],
  };

  it('produces a deterministic persistence record with hashes and version', () => {
    const rec = normalizeSourceForPersistence(baseSource);
    expect(rec.normalizationVersion).toBe(SOURCE_NORMALIZATION_VERSION);
    expect(rec.canonicalUrlHash).toBe(computeCanonicalUrlHash(baseSource.canonicalUrl));
    expect(rec.contentHash).toBe(computeContentHash(normalizeText(baseSource.text!)));
    expect(rec.originDomain).toBe('example.com');
    expect(rec.byteCount).toBe(Buffer.byteLength(normalizeText(baseSource.text!), 'utf8'));
  });

  it('is deterministic across calls (same input → same record)', () => {
    expect(normalizeSourceForPersistence(baseSource)).toEqual(
      normalizeSourceForPersistence(baseSource),
    );
  });

  it('computes a different content hash when text changes (VAL-RES-021)', () => {
    const changed = normalizeSourceForPersistence({ ...baseSource, text: 'different content' });
    const original = normalizeSourceForPersistence(baseSource);
    expect(changed.contentHash).not.toBe(original.contentHash);
    expect(changed.canonicalUrlHash).toBe(original.canonicalUrlHash);
  });

  it('bounds metadata in the persistence record (VAL-RES-098)', () => {
    const long = 'y'.repeat(900);
    const rec = normalizeSourceForPersistence({ ...baseSource, title: long, author: long });
    expect((rec.title ?? '').length).toBeLessThanOrEqual(500);
    expect((rec.author ?? '').length).toBeLessThanOrEqual(200);
  });
});
