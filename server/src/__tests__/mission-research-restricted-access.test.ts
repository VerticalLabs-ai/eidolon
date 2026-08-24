import { describe, expect, it } from 'vitest';
import {
  buildSourceSummary,
  buildCitationQuoteWindow,
  MAX_CITATION_QUOTE_WINDOW_CHARS,
  verifyLocator,
  isAuthorizedServiceContext,
  assertNotContentOracle,
  type SourceRevisionRecord,
  type CitationRecord,
  type AuthorizedServiceContext,
  type AuditEntry,
} from '../services/mission/research/restricted-access.js';
import { AppError } from '../middleware/error-handler.js';
import { encrypt } from '../services/crypto.js';

/**
 * Restricted source content access tests.
 *
 * VAL-RES-078: Restricted source content access
 * VAL-RES-118: Encrypted evidence is accessible only through authorized services
 */

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const PROJECT_A1 = '00000000-0000-4000-8000-000000000011';
const RUN_ID = '00000000-0000-4000-8000-000000000101';
const SOURCE_REVISION_ID = '00000000-0000-4000-8000-000000000103';
const CITATION_ID = '00000000-0000-4000-8000-000000000104';

const FULL_DOCUMENT =
  'This is the full document text. It contains an important fact about revenue growth in the quarterly report. ' +
  'More padding text follows. '.repeat(50);
const QUOTE_EXACT = 'important fact about revenue growth';

// ---------------------------------------------------------------------------
// VAL-RES-078: Restricted source content access
// ---------------------------------------------------------------------------

describe('VAL-RES-078: Restricted source content access', () => {
  const sourceRevision: SourceRevisionRecord = {
    type: 'source_revision',
    companyId: COMPANY_A,
    projectId: PROJECT_A1,
    id: SOURCE_REVISION_ID,
    source_revision_id: SOURCE_REVISION_ID,
    run_id: RUN_ID,
    canonical_url: 'https://example.com/article',
    content_hash: 'abc123hash',
    normalized_text_encrypted: encrypt(FULL_DOCUMENT),
    title_encrypted: encrypt('Secret Article Title'),
    byte_count: FULL_DOCUMENT.length,
    mime_type_encrypted: encrypt('text/html'),
    language_encrypted: encrypt('en'),
    retrieved_at: '2026-08-24T00:00:00Z',
    rank: 0,
    status: 'retrieved',
  };

  it('source summary exposes only safe fields, not full document content', () => {
    const summary = buildSourceSummary(sourceRevision);
    expect(summary.source_revision_id).toBe(SOURCE_REVISION_ID);
    expect(summary.canonical_url).toBe('https://example.com/article');
    expect(summary.content_hash).toBe('abc123hash');
    expect(summary.byte_count).toBe(FULL_DOCUMENT.length);
    expect(summary.retrieved_at).toBe('2026-08-24T00:00:00Z');
    expect(summary.rank).toBe(0);
    expect(summary.status).toBe('retrieved');
    // Full document content is NOT present.
    expect(summary).not.toHaveProperty('normalized_text');
    expect(summary).not.toHaveProperty('normalized_text_encrypted');
    expect(summary).not.toHaveProperty('text');
    expect(summary).not.toHaveProperty('title_encrypted');
  });

  it('source summary does not expose encrypted ciphertext', () => {
    const summary = buildSourceSummary(sourceRevision);
    const serialized = JSON.stringify(summary);
    // The ciphertext should not appear in the summary.
    expect(serialized).not.toContain(sourceRevision.normalized_text_encrypted);
    expect(serialized).not.toContain(sourceRevision.title_encrypted);
  });

  it('source summary does not expose full document plaintext', () => {
    const summary = buildSourceSummary(sourceRevision);
    const serialized = JSON.stringify(summary);
    // The full document text should not be in the summary.
    expect(serialized).not.toContain(FULL_DOCUMENT.slice(0, 50));
    expect(serialized).not.toContain('Secret Article Title');
  });

  it('full-content read parameter is denied', () => {
    // Attempting to request full content via a parameter should throw.
    expect(() => buildSourceSummary(sourceRevision, { includeFullContent: true })).toThrow(
      AppError,
    );
    try {
      buildSourceSummary(sourceRevision, { includeFullContent: true });
    } catch (err) {
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe('RESTRICTED_CONTENT_DENIED');
    }
  });

  it('citation quote window is bounded', () => {
    const citation: CitationRecord = {
      type: 'citation',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      id: CITATION_ID,
      citation_id: CITATION_ID,
      source_revision_id: SOURCE_REVISION_ID,
      quote_exact_encrypted: encrypt(QUOTE_EXACT),
      quote_prefix_encrypted: encrypt('The report states that '),
      quote_suffix_encrypted: encrypt(' in Q3 2026.'),
      quote_hash: 'def456hash',
      canonical_url: 'https://example.com/article',
      ordinal: 1,
    };
    const window = buildCitationQuoteWindow(citation);
    expect(window.quote_exact).toBe(QUOTE_EXACT);
    expect(window.quote_prefix).toBe('The report states that ');
    expect(window.quote_suffix).toBe(' in Q3 2026.');
    expect(window.quote_hash).toBe('def456hash');
    expect(window.canonical_url).toBe('https://example.com/article');
    expect(window.ordinal).toBe(1);
  });

  it('citation quote window does not expose full document content', () => {
    const citation: CitationRecord = {
      type: 'citation',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      id: CITATION_ID,
      citation_id: CITATION_ID,
      source_revision_id: SOURCE_REVISION_ID,
      quote_exact_encrypted: encrypt(QUOTE_EXACT),
      quote_prefix_encrypted: encrypt('prefix '),
      quote_suffix_encrypted: encrypt(' suffix'),
      quote_hash: 'def456hash',
      canonical_url: 'https://example.com/article',
      ordinal: 1,
    };
    const window = buildCitationQuoteWindow(citation);
    const serialized = JSON.stringify(window);
    // Only the bounded quote window, not the full document.
    expect(serialized).not.toContain(FULL_DOCUMENT.slice(0, 50));
  });

  it('citation quote window is capped at MAX_CITATION_QUOTE_WINDOW_CHARS', () => {
    const longQuote = 'x'.repeat(MAX_CITATION_QUOTE_WINDOW_CHARS + 100);
    const citation: CitationRecord = {
      type: 'citation',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      id: CITATION_ID,
      citation_id: CITATION_ID,
      source_revision_id: SOURCE_REVISION_ID,
      quote_exact_encrypted: encrypt(longQuote),
      quote_prefix_encrypted: encrypt(''),
      quote_suffix_encrypted: encrypt(''),
      quote_hash: 'longhash',
      canonical_url: 'https://example.com/article',
      ordinal: 1,
    };
    const window = buildCitationQuoteWindow(citation);
    expect(window.quote_exact.length).toBeLessThanOrEqual(MAX_CITATION_QUOTE_WINDOW_CHARS);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-118: Encrypted evidence accessible only through authorized services
// ---------------------------------------------------------------------------

describe('VAL-RES-118: authorized service access only', () => {
  const sourceRevision: SourceRevisionRecord = {
    type: 'source_revision',
    companyId: COMPANY_A,
    projectId: PROJECT_A1,
    id: SOURCE_REVISION_ID,
    source_revision_id: SOURCE_REVISION_ID,
    run_id: RUN_ID,
    canonical_url: 'https://example.com/article',
    content_hash: 'abc123hash',
    normalized_text_encrypted: encrypt(FULL_DOCUMENT),
    title_encrypted: encrypt('Secret Title'),
    byte_count: 100,
    mime_type_encrypted: encrypt('text/html'),
    language_encrypted: encrypt('en'),
    retrieved_at: '2026-08-24T00:00:00Z',
    rank: 0,
    status: 'retrieved',
  };

  it('isAuthorizedServiceContext returns true for authorized service context', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      actorId: 'worker-1',
    };
    expect(isAuthorizedServiceContext(ctx, sourceRevision)).toBe(true);
  });

  it('isAuthorizedServiceContext returns false for cross-company', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: '00000000-0000-4000-8000-000000000999',
      projectId: PROJECT_A1,
      actorId: 'worker-1',
    };
    expect(isAuthorizedServiceContext(ctx, sourceRevision)).toBe(false);
  });

  it('isAuthorizedServiceContext returns false for cross-project', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: COMPANY_A,
      projectId: '00000000-0000-4000-8000-000000000999',
      actorId: 'worker-1',
    };
    expect(isAuthorizedServiceContext(ctx, sourceRevision)).toBe(false);
  });

  it('isAuthorizedServiceContext returns false for non-service role', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'api_route',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      actorId: 'user-1',
    };
    expect(isAuthorizedServiceContext(ctx, sourceRevision)).toBe(false);
  });

  it('verifyLocator decrypts and verifies through authorized service only', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      actorId: 'worker-1',
    };
    const result = verifyLocator(ctx, sourceRevision, {
      quote: QUOTE_EXACT,
      charStart: FULL_DOCUMENT.indexOf(QUOTE_EXACT),
      charEnd: FULL_DOCUMENT.indexOf(QUOTE_EXACT) + QUOTE_EXACT.length,
    });
    expect(result.verified).toBe(true);
  });

  it('verifyLocator denies unauthorized context', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'api_route',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      actorId: 'user-1',
    };
    expect(() =>
      verifyLocator(ctx, sourceRevision, {
        quote: QUOTE_EXACT,
        charStart: 0,
        charEnd: 10,
      }),
    ).toThrow(AppError);
  });

  it('verifyLocator denies cross-company service context', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: '00000000-0000-4000-8000-000000000999',
      projectId: PROJECT_A1,
      actorId: 'worker-1',
    };
    expect(() =>
      verifyLocator(ctx, sourceRevision, {
        quote: QUOTE_EXACT,
        charStart: 0,
        charEnd: 10,
      }),
    ).toThrow(AppError);
  });

  it('verifyLocator rejects a quote that does not match the source text', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      actorId: 'worker-1',
    };
    const result = verifyLocator(ctx, sourceRevision, {
      quote: 'this quote does not exist in the document',
      charStart: 0,
      charEnd: 38,
    });
    expect(result.verified).toBe(false);
  });

  it('verifyLocator rejects a mismatched char range', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      actorId: 'worker-1',
    };
    const result = verifyLocator(ctx, sourceRevision, {
      quote: QUOTE_EXACT,
      charStart: 0,
      charEnd: 5, // wrong range
    });
    expect(result.verified).toBe(false);
  });

  it('hash cannot be used as a content oracle', () => {
    // A content hash alone must not return the content.
    expect(() => assertNotContentOracle({ content_hash: 'abc123hash' })).toThrow(AppError);
    try {
      assertNotContentOracle({ content_hash: 'abc123hash' });
    } catch (err) {
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe('RESTRICTED_CONTENT_DENIED');
    }
  });

  it('quote hash cannot be used as a content oracle', () => {
    expect(() => assertNotContentOracle({ quote_hash: 'def456hash' })).toThrow(AppError);
  });

  it('canonical URL hash cannot be used as a content oracle', () => {
    expect(() => assertNotContentOracle({ canonical_url_hash: 'url123hash' })).toThrow(AppError);
  });

  it('source revision ID alone cannot be used as a content oracle', () => {
    expect(() => assertNotContentOracle({ source_revision_id: SOURCE_REVISION_ID })).toThrow(
      AppError,
    );
  });

  it('ciphertext cannot be used as an equality oracle', () => {
    // Providing ciphertext and asking if it matches a record should be denied.
    expect(() => assertNotContentOracle({ ciphertext: encrypt('some content') })).toThrow(AppError);
  });

  it('search/pagination parameters cannot act as content oracles', () => {
    // Searching by a content fragment should not return content.
    expect(() => assertNotContentOracle({ search: 'revenue growth', page: 1 })).toThrow(AppError);
  });

  it('every restricted administrative read is audited', () => {
    const ctx: AuthorizedServiceContext = {
      serviceRole: 'research_service',
      companyId: COMPANY_A,
      projectId: PROJECT_A1,
      actorId: 'worker-1',
    };
    const auditLog: AuditEntry[] = [];
    verifyLocator(
      ctx,
      sourceRevision,
      {
        quote: QUOTE_EXACT,
        charStart: FULL_DOCUMENT.indexOf(QUOTE_EXACT),
        charEnd: FULL_DOCUMENT.indexOf(QUOTE_EXACT) + QUOTE_EXACT.length,
      },
      { auditLog },
    );
    expect(auditLog.length).toBe(1);
    expect(auditLog[0].action).toBe('restricted_read');
    expect(auditLog[0].actorId).toBe('worker-1');
    expect(auditLog[0].companyId).toBe(COMPANY_A);
    expect(auditLog[0].projectId).toBe(PROJECT_A1);
    expect(auditLog[0].sourceRevisionId).toBe(SOURCE_REVISION_ID);
    // Audit entry must not contain the decrypted content.
    const serialized = JSON.stringify(auditLog[0]);
    expect(serialized).not.toContain(FULL_DOCUMENT.slice(0, 50));
    expect(serialized).not.toContain(QUOTE_EXACT);
  });
});
