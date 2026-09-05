import { describe, expect, it } from 'vitest';
import {
  RESEARCH_FIELD_CLASSIFICATIONS,
  isRestrictedField,
  isPlaintextField,
  encryptResearchField,
  decryptResearchField,
  encryptResearchRecord,
  decryptResearchRecord,
} from '../services/mission/research/encryption-manifest.js';

/**
 * Restricted research field encryption-at-rest tests.
 *
 * VAL-RES-107: Restricted research fields are encrypted at rest
 *
 * Encrypted fields include normalized source content, restricted diagnostics,
 * citation exact/prefix/suffix text, title/author/publication/language/MIME
 * display metadata, and sensitive provider metadata. Plaintext is limited to
 * company/project/run/source/revision IDs, hashes, ordinals, byte counts,
 * status enums, timestamps, and a policy-approved canonical HTTPS origin/URL
 * only when classified public. Secrets and sensitive query values are never
 * plaintext. Authorized services decrypt bounded views for locator
 * verification, while no route returns keys, ciphertext, or full restricted
 * content.
 */

const CANARY_CONTENT = '__CANARY_DOCUMENT__ secret document text with sk-test-key-1234567890';
const CANARY_TITLE = '__CANARY_SECRET__ confidential title';
const CANARY_QUOTE = 'This is a secret quote with __CANARY_CREDENTIAL__ bearer token';

// ---------------------------------------------------------------------------
// Field classification manifest
// ---------------------------------------------------------------------------

describe('VAL-RES-107: field classification manifest', () => {
  it('classifies normalized source content as encrypted', () => {
    expect(isRestrictedField('normalized_text')).toBe(true);
    expect(isRestrictedField('text')).toBe(true);
    expect(isRestrictedField('excerpt')).toBe(true);
  });

  it('classifies citation exact/prefix/suffix text as encrypted', () => {
    expect(isRestrictedField('quote_exact')).toBe(true);
    expect(isRestrictedField('quote_prefix')).toBe(true);
    expect(isRestrictedField('quote_suffix')).toBe(true);
  });

  it('classifies title/author/publication/language/MIME as encrypted', () => {
    expect(isRestrictedField('title')).toBe(true);
    expect(isRestrictedField('author')).toBe(true);
    expect(isRestrictedField('published_at')).toBe(true);
    expect(isRestrictedField('language')).toBe(true);
    expect(isRestrictedField('mime_type')).toBe(true);
  });

  it('classifies restricted diagnostics as encrypted', () => {
    expect(isRestrictedField('restricted_diagnostics')).toBe(true);
    expect(isRestrictedField('diagnostic_details')).toBe(true);
  });

  it('classifies sensitive provider metadata as encrypted', () => {
    expect(isRestrictedField('provider_metadata_sensitive')).toBe(true);
  });

  it('classifies IDs as plaintext', () => {
    expect(isPlaintextField('company_id')).toBe(true);
    expect(isPlaintextField('project_id')).toBe(true);
    expect(isPlaintextField('run_id')).toBe(true);
    expect(isPlaintextField('source_id')).toBe(true);
    expect(isPlaintextField('source_revision_id')).toBe(true);
    expect(isPlaintextField('citation_id')).toBe(true);
    expect(isPlaintextField('artifact_id')).toBe(true);
  });

  it('classifies hashes as plaintext', () => {
    expect(isPlaintextField('content_hash')).toBe(true);
    expect(isPlaintextField('quote_hash')).toBe(true);
    expect(isPlaintextField('canonical_url_hash')).toBe(true);
    expect(isPlaintextField('provider_request_id_hash')).toBe(true);
  });

  it('classifies ordinals, byte counts, status, timestamps as plaintext', () => {
    expect(isPlaintextField('rank')).toBe(true);
    expect(isPlaintextField('ordinal')).toBe(true);
    expect(isPlaintextField('byte_count')).toBe(true);
    expect(isPlaintextField('status')).toBe(true);
    expect(isPlaintextField('retrieved_at')).toBe(true);
    expect(isPlaintextField('created_at')).toBe(true);
  });

  it('classifies canonical HTTPS URL as plaintext only when classified public', () => {
    // canonical_url is plaintext (public origin/URL classification)
    expect(isPlaintextField('canonical_url')).toBe(true);
  });

  it('does NOT classify secrets or sensitive query values as plaintext', () => {
    expect(isPlaintextField('api_key')).toBe(false);
    expect(isPlaintextField('secret')).toBe(false);
    expect(isPlaintextField('credential')).toBe(false);
    expect(isPlaintextField('authorization_header')).toBe(false);
  });

  it('every field in the manifest is classified as either restricted or plaintext', () => {
    for (const cls of RESEARCH_FIELD_CLASSIFICATIONS) {
      expect(cls.classification === 'encrypted' || cls.classification === 'plaintext').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Encryption / decryption of restricted fields
// ---------------------------------------------------------------------------

describe('VAL-RES-107: encrypt/decrypt restricted fields', () => {
  it('encrypts normalized source content and ciphertext is not plaintext', () => {
    const encrypted = encryptResearchField('normalized_text', CANARY_CONTENT);
    expect(encrypted).not.toBe(CANARY_CONTENT);
    expect(encrypted).not.toContain('CANARY_DOCUMENT');
    expect(encrypted).not.toContain('sk-test-key');
  });

  it('decrypts normalized source content back to original', () => {
    const encrypted = encryptResearchField('normalized_text', CANARY_CONTENT);
    const decrypted = decryptResearchField(encrypted);
    expect(decrypted).toBe(CANARY_CONTENT);
  });

  it('encrypts citation exact/prefix/suffix text', () => {
    const encExact = encryptResearchField('quote_exact', CANARY_QUOTE);
    const encPrefix = encryptResearchField('quote_prefix', 'prefix text');
    const encSuffix = encryptResearchField('quote_suffix', 'suffix text');
    expect(encExact).not.toContain('CANARY_CREDENTIAL');
    expect(decryptResearchField(encExact)).toBe(CANARY_QUOTE);
    expect(decryptResearchField(encPrefix)).toBe('prefix text');
    expect(decryptResearchField(encSuffix)).toBe('suffix text');
  });

  it('encrypts title and author display metadata', () => {
    const encTitle = encryptResearchField('title', CANARY_TITLE);
    const encAuthor = encryptResearchField('author', 'Secret Author');
    expect(encTitle).not.toContain('CANARY_SECRET');
    expect(decryptResearchField(encTitle)).toBe(CANARY_TITLE);
    expect(decryptResearchField(encAuthor)).toBe('Secret Author');
  });

  it('encrypts restricted diagnostics', () => {
    const encDiag = encryptResearchField(
      'restricted_diagnostics',
      'detailed error with sk-secret-key',
    );
    expect(encDiag).not.toContain('sk-secret-key');
    expect(decryptResearchField(encDiag)).toBe('detailed error with sk-secret-key');
  });

  it('encryption produces keyId-tagged ciphertext (AES-256-GCM)', () => {
    const encrypted = encryptResearchField('normalized_text', 'test content');
    // KeyId-tagged envelope has 4 colon-separated base64 parts.
    expect(encrypted.split(':').length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Record-level encryption
// ---------------------------------------------------------------------------

describe('VAL-RES-107: record-level encryption', () => {
  it('encrypts all restricted fields in a research record and leaves plaintext fields as-is', () => {
    const record: Record<string, unknown> = {
      company_id: 'comp-123',
      project_id: 'proj-456',
      run_id: 'run-789',
      source_id: 'src-001',
      source_revision_id: 'rev-002',
      citation_id: 'cit-003',
      content_hash: 'abc123hash',
      quote_hash: 'def456hash',
      canonical_url: 'https://example.com/page',
      rank: 1,
      ordinal: 0,
      byte_count: 1024,
      status: 'retrieved',
      retrieved_at: '2026-08-24T00:00:00Z',
      // Restricted fields:
      normalized_text: CANARY_CONTENT,
      title: CANARY_TITLE,
      author: 'Secret Author',
      quote_exact: CANARY_QUOTE,
      quote_prefix: 'prefix context',
      quote_suffix: 'suffix context',
      restricted_diagnostics: 'error with sk-secret',
    };

    const encrypted = encryptResearchRecord(record);

    // Plaintext fields are unchanged.
    expect(encrypted['company_id']).toBe('comp-123');
    expect(encrypted['project_id']).toBe('proj-456');
    expect(encrypted['content_hash']).toBe('abc123hash');
    expect(encrypted['canonical_url']).toBe('https://example.com/page');
    expect(encrypted['rank']).toBe(1);
    expect(encrypted['status']).toBe('retrieved');

    // Restricted fields are encrypted — no plaintext canary leaks.
    expect(encrypted['normalized_text']).not.toBe(CANARY_CONTENT);
    expect(encrypted['normalized_text']).not.toContain('CANARY_DOCUMENT');
    expect(encrypted['title']).not.toContain('CANARY_SECRET');
    expect(encrypted['quote_exact']).not.toContain('CANARY_CREDENTIAL');
    expect(encrypted['restricted_diagnostics']).not.toContain('sk-secret');

    // All encrypted fields are strings (ciphertext).
    expect(typeof encrypted['normalized_text']).toBe('string');
    expect(typeof encrypted['title']).toBe('string');
  });

  it('decrypts all restricted fields back to original values', () => {
    const record: Record<string, unknown> = {
      company_id: 'comp-123',
      content_hash: 'abc123hash',
      normalized_text: CANARY_CONTENT,
      title: CANARY_TITLE,
      author: 'Secret Author',
      quote_exact: CANARY_QUOTE,
    };

    const encrypted = encryptResearchRecord(record);
    const decrypted = decryptResearchRecord(encrypted);

    expect(decrypted['company_id']).toBe('comp-123');
    expect(decrypted['content_hash']).toBe('abc123hash');
    expect(decrypted['normalized_text']).toBe(CANARY_CONTENT);
    expect(decrypted['title']).toBe(CANARY_TITLE);
    expect(decrypted['author']).toBe('Secret Author');
    expect(decrypted['quote_exact']).toBe(CANARY_QUOTE);
  });

  it('record with only plaintext fields passes through unchanged', () => {
    const record: Record<string, unknown> = {
      company_id: 'comp-123',
      run_id: 'run-789',
      content_hash: 'abc123',
      status: 'retrieved',
    };
    const encrypted = encryptResearchRecord(record);
    expect(encrypted).toEqual(record);
    const decrypted = decryptResearchRecord(encrypted);
    expect(decrypted).toEqual(record);
  });

  it('unknown fields are left as-is (not encrypted, not dropped)', () => {
    const record: Record<string, unknown> = {
      company_id: 'comp-123',
      unknown_field: 'some value',
    };
    const encrypted = encryptResearchRecord(record);
    expect(encrypted['unknown_field']).toBe('some value');
  });
});

// ---------------------------------------------------------------------------
// Canaries: plaintext is absent from encrypted fields
// ---------------------------------------------------------------------------

describe('VAL-RES-107: canary absence in encrypted records', () => {
  it('plaintext canaries are absent from the encrypted record', () => {
    const record: Record<string, unknown> = {
      company_id: 'comp-123',
      content_hash: 'abc123',
      normalized_text: 'document with __CANARY_DOCUMENT__ secret content',
      title: 'title with __CANARY_SECRET__ value',
      quote_exact: 'quote with bearer __CANARY_CREDENTIAL__ token',
      restricted_diagnostics: 'error with sk-secret-key-1234567890123',
    };
    const encrypted = encryptResearchRecord(record);
    const serialized = JSON.stringify(encrypted);
    expect(serialized).not.toContain('CANARY_DOCUMENT');
    expect(serialized).not.toContain('CANARY_SECRET');
    expect(serialized).not.toContain('CANARY_CREDENTIAL');
    expect(serialized).not.toContain('sk-secret-key');
  });
});
