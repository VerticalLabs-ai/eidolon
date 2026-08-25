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
  stripTrackingKeys,
  utf16ToScalarOffset,
  scalarToUtf16Offset,
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

// ---------------------------------------------------------------------------
// Regression: normalizeText entity decoding (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('normalizeText: HTML entity decoding (VAL-RES-112 regression)', () => {
  it('decodes standard named entities', () => {
    expect(normalizeText('a &amp; b')).toBe('a & b');
    expect(normalizeText('a &lt; b')).toBe('a < b');
    expect(normalizeText('a &gt; b')).toBe('a > b');
    expect(normalizeText('&quot;hi&quot;')).toBe('"hi"');
    expect(normalizeText('it&apos;s')).toBe("it's");
  });

  it('decodes numeric decimal entities', () => {
    expect(normalizeText('&#65;')).toBe('A');
    expect(normalizeText('&#123;')).toBe('{');
  });

  it('decodes numeric hex entities', () => {
    expect(normalizeText('&#x41;')).toBe('A');
    expect(normalizeText('&#X42;')).toBe('B');
  });

  it('decodes &nbsp; to non-breaking space then converts to ASCII space', () => {
    // &nbsp; → U+00A0 → ASCII space (via horizontal whitespace conversion)
    expect(normalizeText('a&nbsp;b')).toBe('a b');
  });

  it('leaves unknown named entities unchanged (fail-safe)', () => {
    expect(normalizeText('&unknownentity;')).toBe('&unknownentity;');
  });

  it('decodes multiple entities in one string', () => {
    expect(normalizeText('&lt;tag&gt; &amp; &quot;text&quot;')).toBe('<tag> & "text"');
  });
});

// ---------------------------------------------------------------------------
// Regression: normalizeText horizontal whitespace conversion (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('normalizeText: horizontal whitespace to ASCII space (VAL-RES-112 regression)', () => {
  it('converts tab to ASCII space', () => {
    expect(normalizeText('a\tb')).toBe('a b');
  });

  it('converts vertical tab to ASCII space', () => {
    expect(normalizeText('a\u000Bb')).toBe('a b');
  });

  it('converts form feed to ASCII space', () => {
    expect(normalizeText('a\u000Cb')).toBe('a b');
  });

  it('converts non-breaking space (U+00A0) to ASCII space', () => {
    expect(normalizeText('a\u00A0b')).toBe('a b');
  });

  it('converts ideographic space (U+3000) to ASCII space', () => {
    expect(normalizeText('a\u3000b')).toBe('a b');
  });

  it('converts various Unicode spaces (U+2000-U+200A) to ASCII space', () => {
    expect(normalizeText('a\u2000b')).toBe('a b');
    expect(normalizeText('a\u2009b')).toBe('a b');
    expect(normalizeText('a\u200Ab')).toBe('a b');
  });

  it('preserves runs of ASCII spaces (content-preserving)', () => {
    expect(normalizeText('a   b')).toBe('a   b');
  });
});

// ---------------------------------------------------------------------------
// Regression: normalizeText newline collapse (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('normalizeText: newline collapse >2 to 2 (VAL-RES-112 regression)', () => {
  it('collapses 3 newlines to 2', () => {
    expect(normalizeText('a\n\n\nb')).toBe('a\n\nb');
  });

  it('collapses 5 newlines to 2', () => {
    expect(normalizeText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('preserves 1 newline', () => {
    expect(normalizeText('a\nb')).toBe('a\nb');
  });

  it('preserves 2 newlines', () => {
    expect(normalizeText('a\n\nb')).toBe('a\n\nb');
  });

  it('collapses CRLF sequences after CRLF normalization', () => {
    // \r\n\r\n\r\n → \n\n\n → \n\n
    expect(normalizeText('a\r\n\r\n\r\nb')).toBe('a\n\nb');
  });

  it('is idempotent after newline collapse', () => {
    const raw = 'a\n\n\n\nb';
    const normalized = normalizeText(raw);
    expect(normalizeText(normalized)).toBe(normalized);
  });
});

// ---------------------------------------------------------------------------
// Regression: URL dedup tracking key stripping (VAL-RES-019)
// ---------------------------------------------------------------------------

describe('stripTrackingKeys (VAL-RES-019 regression)', () => {
  it('strips utm_source from URL', () => {
    const result = stripTrackingKeys('https://example.com/path?utm_source=google&q=test');
    expect(result).toBe('https://example.com/path?q=test');
  });

  it('strips all utm_* parameters', () => {
    const result = stripTrackingKeys(
      'https://example.com/path?utm_source=google&utm_medium=cpc&utm_campaign=spring&q=test',
    );
    expect(result).toBe('https://example.com/path?q=test');
  });

  it('strips fbclid', () => {
    const result = stripTrackingKeys('https://example.com/path?fbclid=abc123&q=test');
    expect(result).toBe('https://example.com/path?q=test');
  });

  it('strips gclid', () => {
    const result = stripTrackingKeys('https://example.com/path?gclid=xyz789&q=test');
    expect(result).toBe('https://example.com/path?q=test');
  });

  it('strips msclkid', () => {
    const result = stripTrackingKeys('https://example.com/path?msclkid=abc&q=test');
    expect(result).toBe('https://example.com/path?q=test');
  });

  it('preserves non-tracking parameters', () => {
    const result = stripTrackingKeys('https://example.com/path?q=test&page=2&lang=en');
    expect(result).toBe('https://example.com/path?q=test&page=2&lang=en');
  });

  it('returns URL unchanged when no tracking keys present', () => {
    const url = 'https://example.com/path?q=test';
    expect(stripTrackingKeys(url)).toBe(url);
  });

  it('returns URL unchanged when no query parameters', () => {
    const url = 'https://example.com/path';
    expect(stripTrackingKeys(url)).toBe(url);
  });

  it('handles URL with only tracking parameters', () => {
    const result = stripTrackingKeys('https://example.com/path?utm_source=google');
    // URL.toString() normalizes the path (no trailing slash for non-root paths)
    expect(result).toBe('https://example.com/path');
  });

  it('is case-insensitive for tracking keys', () => {
    const result = stripTrackingKeys('https://example.com/path?UTM_SOURCE=google&q=test');
    expect(result).toBe('https://example.com/path?q=test');
  });
});

describe('computeCanonicalUrlHash strips tracking keys (VAL-RES-019 regression)', () => {
  it('produces the same hash for URLs differing only in tracking keys', () => {
    const url1 = 'https://example.com/article?q=test';
    const url2 = 'https://example.com/article?q=test&utm_source=google';
    const url3 = 'https://example.com/article?q=test&fbclid=abc123';
    expect(computeCanonicalUrlHash(url1)).toBe(computeCanonicalUrlHash(url2));
    expect(computeCanonicalUrlHash(url1)).toBe(computeCanonicalUrlHash(url3));
  });

  it('produces different hashes for URLs with different non-tracking params', () => {
    const url1 = 'https://example.com/article?q=test';
    const url2 = 'https://example.com/article?q=other';
    expect(computeCanonicalUrlHash(url1)).not.toBe(computeCanonicalUrlHash(url2));
  });
});

// ---------------------------------------------------------------------------
// Regression: Unicode scalar value offset conversion (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('utf16ToScalarOffset / scalarToUtf16Offset (VAL-RES-112 regression)', () => {
  it('returns the same offset for BMP-only text (no astral chars)', () => {
    const text = 'hello world';
    expect(utf16ToScalarOffset(text, 5)).toBe(5);
    expect(scalarToUtf16Offset(text, 5)).toBe(5);
  });

  it('converts UTF-16 offset to scalar offset for astral characters', () => {
    // 😀 is U+1F600, a surrogate pair (2 UTF-16 code units)
    const text = '😀test';
    // UTF-16 offset 2 = after the emoji = scalar offset 1
    expect(utf16ToScalarOffset(text, 2)).toBe(1);
    // UTF-16 offset 3 = 't' = scalar offset 2
    expect(utf16ToScalarOffset(text, 3)).toBe(2);
  });

  it('converts scalar offset back to UTF-16 offset for astral characters', () => {
    const text = '😀test';
    expect(scalarToUtf16Offset(text, 1)).toBe(2); // scalar 1 = UTF-16 2 (after emoji)
    expect(scalarToUtf16Offset(text, 2)).toBe(3); // scalar 2 = UTF-16 3 ('t')
  });

  it('handles multiple astral characters', () => {
    const text = '😀🎉test';
    // UTF-16: 😀(2) + 🎉(2) + test(4) = 8 code units
    // Scalar: 😀(1) + 🎉(1) + test(4) = 6 scalar values
    expect(utf16ToScalarOffset(text, 4)).toBe(2); // after both emojis
    expect(utf16ToScalarOffset(text, 5)).toBe(3); // at 't'
    expect(scalarToUtf16Offset(text, 2)).toBe(4);
    expect(scalarToUtf16Offset(text, 3)).toBe(5);
  });

  it('round-trips correctly: scalar → utf16 → scalar', () => {
    const text = '😀alpha🎉beta';
    // Only check positions that are at scalar boundaries (not in the middle of a surrogate pair)
    for (let i = 0; i <= text.length; i++) {
      const code = text.charCodeAt(i);
      // Skip positions in the middle of a surrogate pair (low surrogate)
      if (i > 0 && code >= 0xdc00 && code <= 0xdfff) {
        continue;
      }
      const scalar = utf16ToScalarOffset(text, i);
      const back = scalarToUtf16Offset(text, scalar);
      expect(back).toBe(i);
    }
  });

  it('handles empty string', () => {
    expect(utf16ToScalarOffset('', 0)).toBe(0);
    expect(scalarToUtf16Offset('', 0)).toBe(0);
  });
});
