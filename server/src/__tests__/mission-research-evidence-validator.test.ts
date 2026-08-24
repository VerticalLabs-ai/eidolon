import { describe, expect, it } from 'vitest';
import {
  validateClaimSupport,
  applyTransformation,
  validateEvidenceForArtifact,
  SUPPORTED_TRANSFORMATIONS,
  EVIDENCE_NOT_SUPPORTING_CLAIM_CODE,
  CITATION_REQUIRED_FOR_EXTERNAL_CLAIM_CODE,
  type EvidenceClaim,
  type CitedEvidence,
  type ArtifactEvidenceInput,
} from '../services/mission/research/evidence-validator.js';

/**
 * VAL-RES-111: Evidence semantically supports the cited claim.
 * VAL-RES-023: Citation required for external claims.
 *
 * Before commit, a bounded evidence validator confirms each external factual
 * claim or structured field is supported by its exact cited quote. Unrelated
 * or contradictory passages fail with `EVIDENCE_NOT_SUPPORTING_CLAIM` and no
 * partial artifact/provenance. Transformed structured values record the exact
 * quote, artifact JSON pointer, and a declared transformation from the closed
 * enum `identity|parse_number|parse_date|normalize_whitespace|select_enum`,
 * with validated output.
 */

const SOURCE = 'The revenue for Q3 2025 was $1,234,567, a 12.5% increase year over year.';

describe('VAL-RES-111: validateClaimSupport', () => {
  function evidence(quote: string): CitedEvidence {
    return {
      sourceRevisionId: 'src-rev-1',
      quote,
      normalizedSourceText: SOURCE,
    };
  }

  it('confirms a claim directly supported by the quote (identity)', () => {
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $1,234,567',
      citationId: 'cit-1',
      transformation: 'identity',
      evidence: evidence('revenue for Q3 2025 was $1,234,567'),
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(true);
  });

  it('rejects an unrelated quote with EVIDENCE_NOT_SUPPORTING_CLAIM', () => {
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $1,234,567',
      citationId: 'cit-1',
      transformation: 'identity',
      evidence: evidence('the weather was sunny all week'),
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(false);
    expect(r.code).toBe(EVIDENCE_NOT_SUPPORTING_CLAIM_CODE);
  });

  it('rejects a contradictory passage with EVIDENCE_NOT_SUPPORTING_CLAIM', () => {
    const contradictorySource = 'The revenue for Q3 2025 was $999, not $1,234,567 as some claim.';
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $1,234,567',
      citationId: 'cit-1',
      transformation: 'identity',
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'revenue for Q3 2025 was $999',
        normalizedSourceText: contradictorySource,
      },
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(false);
    expect(r.code).toBe(EVIDENCE_NOT_SUPPORTING_CLAIM_CODE);
  });

  it('rejects a quote absent from the source text', () => {
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $1,234,567',
      citationId: 'cit-1',
      transformation: 'identity',
      evidence: evidence('this quote does not appear in the source'),
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(false);
    expect(r.code).toBe(EVIDENCE_NOT_SUPPORTING_CLAIM_CODE);
  });
});

describe('VAL-RES-111: transformations', () => {
  it('parse_number extracts a numeric value from the quote and validates it', () => {
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was 1234567',
      citationId: 'cit-1',
      transformation: 'parse_number',
      expectedValue: 1234567,
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'revenue for Q3 2025 was $1,234,567',
        normalizedSourceText: SOURCE,
      },
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(true);
    expect(r.transformedValue).toBe(1234567);
  });

  it('parse_number rejects when the parsed value does not match the claim', () => {
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was 999',
      citationId: 'cit-1',
      transformation: 'parse_number',
      expectedValue: 999,
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'revenue for Q3 2025 was $1,234,567',
        normalizedSourceText: SOURCE,
      },
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(false);
    expect(r.code).toBe(EVIDENCE_NOT_SUPPORTING_CLAIM_CODE);
  });

  it('parse_date extracts an ISO date from the quote and validates it', () => {
    const sourceText = 'The report was published on January 15, 2026.';
    const claim: EvidenceClaim = {
      claimText: 'published 2026-01-15',
      citationId: 'cit-1',
      transformation: 'parse_date',
      expectedValue: '2026-01-15',
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'published on January 15, 2026',
        normalizedSourceText: sourceText,
      },
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(true);
    expect(r.transformedValue).toBe('2026-01-15');
  });

  it('normalize_whitespace collapses whitespace in the quote and matches', () => {
    const sourceText = 'The  quick   brown\n\nfox';
    const claim: EvidenceClaim = {
      claimText: 'The quick brown fox',
      citationId: 'cit-1',
      transformation: 'normalize_whitespace',
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'The  quick   brown\n\nfox',
        normalizedSourceText: sourceText,
      },
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(true);
    expect(r.transformedValue).toBe('The quick brown fox');
  });

  it('select_enum validates that the quote yields one of the allowed enum values', () => {
    const sourceText = 'Status: APPROVED for release.';
    const claim: EvidenceClaim = {
      claimText: 'APPROVED',
      citationId: 'cit-1',
      transformation: 'select_enum',
      expectedValue: 'APPROVED',
      allowedEnum: ['APPROVED', 'REJECTED', 'PENDING'],
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'Status: APPROVED',
        normalizedSourceText: sourceText,
      },
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(true);
    expect(r.transformedValue).toBe('APPROVED');
  });

  it('select_enum rejects a value not in the allowed enum', () => {
    const sourceText = 'Status: UNKNOWN for release.';
    const claim: EvidenceClaim = {
      claimText: 'UNKNOWN',
      citationId: 'cit-1',
      transformation: 'select_enum',
      expectedValue: 'UNKNOWN',
      allowedEnum: ['APPROVED', 'REJECTED', 'PENDING'],
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'Status: UNKNOWN',
        normalizedSourceText: sourceText,
      },
    };
    const r = validateClaimSupport(claim);
    expect(r.valid).toBe(false);
    expect(r.code).toBe(EVIDENCE_NOT_SUPPORTING_CLAIM_CODE);
  });

  it('rejects an unsupported transformation kind', () => {
    const r = applyTransformation('evil_parse', 'x', SOURCE);
    expect(r.valid).toBe(false);
  });

  it('exposes the closed transformation enum', () => {
    expect([...SUPPORTED_TRANSFORMATIONS]).toEqual([
      'identity',
      'parse_number',
      'parse_date',
      'normalize_whitespace',
      'select_enum',
    ]);
  });
});

describe('VAL-RES-023: validateEvidenceForArtifact (citation required)', () => {
  function docWithClaims(claims: EvidenceClaim[]): ArtifactEvidenceInput {
    return {
      claims,
      declaredCitationIds: new Set(claims.map((c) => c.citationId)),
    };
  }

  it('accepts when every external factual claim has a supporting citation', () => {
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $1,234,567',
      citationId: 'cit-1',
      transformation: 'identity',
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'revenue for Q3 2025 was $1,234,567',
        normalizedSourceText: SOURCE,
      },
    };
    const r = validateEvidenceForArtifact(docWithClaims([claim]));
    expect(r.valid).toBe(true);
  });

  it('rejects with CITATION_REQUIRED when an external factual claim has no citation', () => {
    const r = validateEvidenceForArtifact({
      claims: [
        {
          claimText: 'Q3 2025 revenue was $1,234,567',
          citationId: '',
          transformation: 'identity',
          isExternalFactualClaim: true,
          evidence: {
            sourceRevisionId: '',
            quote: '',
            normalizedSourceText: SOURCE,
          },
        },
      ],
      declaredCitationIds: new Set(),
    });
    expect(r.valid).toBe(false);
    expect(r.code).toBe(CITATION_REQUIRED_FOR_EXTERNAL_CLAIM_CODE);
  });

  it('rejects atomically when any claim is unsupported (no partial artifact/provenance)', () => {
    const good: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $1,234,567',
      citationId: 'cit-1',
      transformation: 'identity',
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'revenue for Q3 2025 was $1,234,567',
        normalizedSourceText: SOURCE,
      },
    };
    const bad: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $999',
      citationId: 'cit-2',
      transformation: 'identity',
      evidence: {
        sourceRevisionId: 'src-rev-2',
        quote: 'weather was sunny',
        normalizedSourceText: 'the weather was sunny all week',
      },
    };
    const r = validateEvidenceForArtifact(docWithClaims([good, bad]));
    expect(r.valid).toBe(false);
    expect(r.code).toBe(EVIDENCE_NOT_SUPPORTING_CLAIM_CODE);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects when a claim references a citation id not in the declared set', () => {
    const claim: EvidenceClaim = {
      claimText: 'Q3 2025 revenue was $1,234,567',
      citationId: 'missing',
      transformation: 'identity',
      evidence: {
        sourceRevisionId: 'src-rev-1',
        quote: 'revenue for Q3 2025 was $1,234,567',
        normalizedSourceText: SOURCE,
      },
    };
    const r = validateEvidenceForArtifact({
      claims: [claim],
      declaredCitationIds: new Set(['cit-1']),
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/dangling|declared|citation/i);
  });
});
