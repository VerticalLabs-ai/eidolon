import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_BOUNDS,
  checkCitationCount,
  checkUniqueSourceCount,
  checkAggregateDisclosureBytes,
  checkPageBounds,
  checkQuoteBounds,
  validateEvidenceBounds,
  type EvidenceBoundsInput,
} from '../services/mission/research/evidence-bounds.js';

/**
 * VAL-RES-115: Evidence payloads have closed byte and cardinality bounds.
 *
 * Canonical UTF-8 limits are: exact quote 4,096 bytes; prefix and suffix 256
 * bytes each; 500 citations per artifact revision; 100 unique sources per
 * run; source/provenance pages 50/100 records; and 2 MiB aggregate
 * citation/provenance disclosure per artifact revision. Over-limit commits
 * reject atomically with `EVIDENCE_LIMIT_EXCEEDED` rather than truncating
 * locators; pagination/export preserve global ordinals.
 */

describe('VAL-RES-115: evidence bounds constants', () => {
  it('exposes the documented canonical limits', () => {
    expect(EVIDENCE_BOUNDS.maxQuoteBytes).toBe(4096);
    expect(EVIDENCE_BOUNDS.maxPrefixBytes).toBe(256);
    expect(EVIDENCE_BOUNDS.maxSuffixBytes).toBe(256);
    expect(EVIDENCE_BOUNDS.maxCitationsPerRevision).toBe(500);
    expect(EVIDENCE_BOUNDS.maxUniqueSourcesPerRun).toBe(100);
    expect(EVIDENCE_BOUNDS.maxSourcePageRecords).toBe(50);
    expect(EVIDENCE_BOUNDS.maxProvenancePageRecords).toBe(100);
    expect(EVIDENCE_BOUNDS.maxAggregateDisclosureBytes).toBe(2 * 1024 * 1024);
  });
});

describe('VAL-RES-115: checkQuoteBounds', () => {
  it('accepts a quote at exactly 4096 bytes', () => {
    const quote = 'x'.repeat(4096);
    const r = checkQuoteBounds(quote);
    expect(r.valid).toBe(true);
  });

  it('rejects a quote one byte over 4096', () => {
    const quote = 'x'.repeat(4097);
    const r = checkQuoteBounds(quote);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('rejects a multibyte quote whose UTF-8 bytes exceed 4096', () => {
    // 'é' is 2 UTF-8 bytes; 2049 of them = 4098 bytes.
    const quote = 'é'.repeat(2049);
    const r = checkQuoteBounds(quote);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('rejects a prefix over 256 bytes', () => {
    const r = checkQuoteBounds('ok', 'x'.repeat(257), '');
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('rejects a suffix over 256 bytes', () => {
    const r = checkQuoteBounds('ok', '', 'y'.repeat(257));
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });
});

describe('VAL-RES-115: checkCitationCount', () => {
  it('accepts exactly 500 citations per revision', () => {
    expect(checkCitationCount(500).valid).toBe(true);
  });

  it('rejects 501 citations per revision', () => {
    const r = checkCitationCount(501);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });
});

describe('VAL-RES-115: checkUniqueSourceCount', () => {
  it('accepts exactly 100 unique sources per run', () => {
    expect(checkUniqueSourceCount(100).valid).toBe(true);
  });

  it('rejects 101 unique sources per run', () => {
    const r = checkUniqueSourceCount(101);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });
});

describe('VAL-RES-115: checkAggregateDisclosureBytes', () => {
  it('accepts aggregate disclosure at exactly 2 MiB', () => {
    expect(checkAggregateDisclosureBytes(2 * 1024 * 1024).valid).toBe(true);
  });

  it('rejects aggregate disclosure one byte over 2 MiB', () => {
    const r = checkAggregateDisclosureBytes(2 * 1024 * 1024 + 1);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });
});

describe('VAL-RES-115: checkPageBounds', () => {
  it('accepts a source page of 50 records', () => {
    expect(checkPageBounds('source', 50).valid).toBe(true);
  });

  it('rejects a source page of 51 records', () => {
    const r = checkPageBounds('source', 51);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('accepts a provenance page of 100 records', () => {
    expect(checkPageBounds('provenance', 100).valid).toBe(true);
  });

  it('rejects a provenance page of 101 records', () => {
    const r = checkPageBounds('provenance', 101);
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });
});

describe('VAL-RES-115: validateEvidenceBounds (atomic)', () => {
  function input(over: Partial<EvidenceBoundsInput>): EvidenceBoundsInput {
    return {
      citationCount: 1,
      uniqueSourceCount: 1,
      aggregateDisclosureBytes: 100,
      citations: [
        {
          quote: 'x',
          prefix: '',
          suffix: '',
        },
      ],
      ...over,
    };
  }

  it('accepts a fully in-bounds input', () => {
    const r = validateEvidenceBounds(input({}));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects atomically when any citation quote exceeds bounds', () => {
    const r = validateEvidenceBounds(
      input({
        citations: [{ quote: 'x'.repeat(4097), prefix: '', suffix: '' }],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('rejects atomically when citation count exceeds bounds', () => {
    const r = validateEvidenceBounds(input({ citationCount: 501 }));
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('rejects atomically when unique source count exceeds bounds', () => {
    const r = validateEvidenceBounds(input({ uniqueSourceCount: 101 }));
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('rejects atomically when aggregate disclosure exceeds bounds', () => {
    const r = validateEvidenceBounds(input({ aggregateDisclosureBytes: 2 * 1024 * 1024 + 1 }));
    expect(r.valid).toBe(false);
    expect(r.code).toBe('EVIDENCE_LIMIT_EXCEEDED');
  });

  it('collects all violations without truncating locators', () => {
    const r = validateEvidenceBounds(
      input({
        citationCount: 501,
        uniqueSourceCount: 101,
        citations: [{ quote: 'x'.repeat(4097), prefix: 'p'.repeat(257), suffix: 's'.repeat(257) }],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(1);
  });
});
