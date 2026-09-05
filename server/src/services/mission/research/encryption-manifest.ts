/**
 * Restricted research field encryption-at-rest manifest (VAL-RES-107).
 *
 * Defines which research fields are encrypted at rest vs plaintext.
 *
 * **Encrypted** (restricted) fields include:
 * - Normalized source content / text / excerpt
 * - Restricted diagnostics / diagnostic details
 * - Citation exact / prefix / suffix text
 * - Title / author / publication / language / MIME display metadata
 * - Sensitive provider metadata
 *
 * **Plaintext** (public projection) fields are limited to:
 * - Company / project / run / source / revision / citation / artifact IDs
 * - Hashes (content hash, quote hash, canonical URL hash, provider request ID hash)
 * - Ordinals, ranks, byte counts
 * - Status enums
 * - Timestamps
 * - Policy-approved canonical HTTPS origin/URL (classified public)
 *
 * Secrets and sensitive query values are NEVER plaintext. Authorized services
 * decrypt bounded views for locator verification, while no route returns keys,
 * ciphertext, or full restricted content.
 *
 * This manifest is consumed by later features that create the research
 * persistence tables (m5-f05-source-normalization-citations,
 * m5-f07-provenance-revision-export-backend). The encryption/decryption
 * helpers use the existing AES-256-GCM `crypto.ts` module.
 */

import { encrypt, decrypt } from '../../crypto.js';

// ---------------------------------------------------------------------------
// Classification types
// ---------------------------------------------------------------------------

export type FieldClassification = 'encrypted' | 'plaintext';

export type ResearchFieldType =
  | 'normalized_text'
  | 'text'
  | 'excerpt'
  | 'quote_exact'
  | 'quote_prefix'
  | 'quote_suffix'
  | 'title'
  | 'author'
  | 'published_at'
  | 'language'
  | 'mime_type'
  | 'restricted_diagnostics'
  | 'diagnostic_details'
  | 'provider_metadata_sensitive'
  | 'company_id'
  | 'project_id'
  | 'run_id'
  | 'root_run_id'
  | 'parent_run_id'
  | 'source_id'
  | 'source_revision_id'
  | 'citation_id'
  | 'artifact_id'
  | 'artifact_revision_id'
  | 'logical_call_id'
  | 'content_hash'
  | 'quote_hash'
  | 'canonical_url_hash'
  | 'provider_request_id_hash'
  | 'rank'
  | 'ordinal'
  | 'byte_count'
  | 'status'
  | 'retrieved_at'
  | 'created_at'
  | 'updated_at'
  | 'canonical_url'
  | 'provider'
  | 'operation'
  | 'credits'
  | 'score'
  | 'injection_risk_labels'
  | 'excluded'
  | 'exclusion_reason'
  | 'warnings';

export interface ResearchFieldClassification {
  field: string;
  classification: FieldClassification;
  why: string;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * The complete field-level encryption classification for research data.
 *
 * Every field that may be stored in a research table is classified here.
 * Fields not listed are treated as unknown and left as-is by the record
 * encrypt/decrypt helpers — they are neither encrypted nor dropped.
 */
export const RESEARCH_FIELD_CLASSIFICATIONS: ResearchFieldClassification[] = [
  // --- Encrypted: content and text -----------------------------------------
  {
    field: 'normalized_text',
    classification: 'encrypted',
    why: 'Normalized source content may contain full retrieved document text; encrypted at rest.',
  },
  {
    field: 'text',
    classification: 'encrypted',
    why: 'Bounded normalized text from a provider response; encrypted at rest.',
  },
  {
    field: 'excerpt',
    classification: 'encrypted',
    why: 'Bounded excerpt of retrieved content; encrypted at rest.',
  },
  // --- Encrypted: citation quote text --------------------------------------
  {
    field: 'quote_exact',
    classification: 'encrypted',
    why: 'Exact citation quote text from the source; encrypted at rest.',
  },
  {
    field: 'quote_prefix',
    classification: 'encrypted',
    why: 'Prefix context around the citation quote; encrypted at rest.',
  },
  {
    field: 'quote_suffix',
    classification: 'encrypted',
    why: 'Suffix context around the citation quote; encrypted at rest.',
  },
  // --- Encrypted: display metadata -----------------------------------------
  {
    field: 'title',
    classification: 'encrypted',
    why: 'Source title may contain sensitive information; encrypted at rest.',
  },
  {
    field: 'author',
    classification: 'encrypted',
    why: 'Source author may be a personal-data field; encrypted at rest.',
  },
  {
    field: 'published_at',
    classification: 'encrypted',
    why: 'Publication timestamp metadata; encrypted at rest.',
  },
  {
    field: 'language',
    classification: 'encrypted',
    why: 'Language metadata; encrypted at rest.',
  },
  {
    field: 'mime_type',
    classification: 'encrypted',
    why: 'MIME type metadata; encrypted at rest.',
  },
  // --- Encrypted: restricted diagnostics -----------------------------------
  {
    field: 'restricted_diagnostics',
    classification: 'encrypted',
    why: 'Restricted diagnostic details may contain provider errors or sensitive context; encrypted at rest.',
  },
  {
    field: 'diagnostic_details',
    classification: 'encrypted',
    why: 'Detailed diagnostic information; encrypted at rest.',
  },
  // --- Encrypted: sensitive provider metadata ------------------------------
  {
    field: 'provider_metadata_sensitive',
    classification: 'encrypted',
    why: 'Sensitive provider metadata that is not in the public allowlist; encrypted at rest.',
  },
  // --- Plaintext: IDs ------------------------------------------------------
  {
    field: 'company_id',
    classification: 'plaintext',
    why: 'Company ID is a scope identifier; plaintext for queryability.',
  },
  {
    field: 'project_id',
    classification: 'plaintext',
    why: 'Project ID is a scope identifier; plaintext for queryability.',
  },
  {
    field: 'run_id',
    classification: 'plaintext',
    why: 'Run ID is a scope identifier; plaintext for queryability.',
  },
  {
    field: 'root_run_id',
    classification: 'plaintext',
    why: 'Root run ID is a scope identifier; plaintext for queryability.',
  },
  {
    field: 'parent_run_id',
    classification: 'plaintext',
    why: 'Parent run ID is a scope identifier; plaintext for queryability.',
  },
  {
    field: 'source_id',
    classification: 'plaintext',
    why: 'Source ID is an identifier; plaintext for queryability.',
  },
  {
    field: 'source_revision_id',
    classification: 'plaintext',
    why: 'Source revision ID is an identifier; plaintext for queryability.',
  },
  {
    field: 'citation_id',
    classification: 'plaintext',
    why: 'Citation ID is an identifier; plaintext for queryability.',
  },
  {
    field: 'artifact_id',
    classification: 'plaintext',
    why: 'Artifact ID is an identifier; plaintext for queryability.',
  },
  {
    field: 'artifact_revision_id',
    classification: 'plaintext',
    why: 'Artifact revision ID is an identifier; plaintext for queryability.',
  },
  {
    field: 'logical_call_id',
    classification: 'plaintext',
    why: 'Logical call ID is an identifier; plaintext for queryability.',
  },
  // --- Plaintext: hashes ---------------------------------------------------
  {
    field: 'content_hash',
    classification: 'plaintext',
    why: 'SHA-256 content hash is a one-way digest; plaintext for dedup and verification.',
  },
  {
    field: 'quote_hash',
    classification: 'plaintext',
    why: 'SHA-256 quote hash is a one-way digest; plaintext for citation verification.',
  },
  {
    field: 'canonical_url_hash',
    classification: 'plaintext',
    why: 'SHA-256 canonical URL hash is a one-way digest; plaintext for dedup.',
  },
  {
    field: 'provider_request_id_hash',
    classification: 'plaintext',
    why: 'Hashed provider request ID; plaintext for audit without exposing the raw ID.',
  },
  // --- Plaintext: counts, ordinals, status, timestamps ---------------------
  {
    field: 'rank',
    classification: 'plaintext',
    why: 'Provider-assigned rank ordinal; plaintext.',
  },
  {
    field: 'ordinal',
    classification: 'plaintext',
    why: 'Citation ordinal; plaintext.',
  },
  {
    field: 'byte_count',
    classification: 'plaintext',
    why: 'Byte count is a non-sensitive metric; plaintext.',
  },
  {
    field: 'status',
    classification: 'plaintext',
    why: 'Status enum; plaintext for queryability.',
  },
  {
    field: 'retrieved_at',
    classification: 'plaintext',
    why: 'Retrieval timestamp; plaintext.',
  },
  {
    field: 'created_at',
    classification: 'plaintext',
    why: 'Creation timestamp; plaintext.',
  },
  {
    field: 'updated_at',
    classification: 'plaintext',
    why: 'Update timestamp; plaintext.',
  },
  // --- Plaintext: public projection ----------------------------------------
  {
    field: 'canonical_url',
    classification: 'plaintext',
    why: 'Policy-approved canonical HTTPS origin/URL classified public; plaintext for deep links.',
  },
  {
    field: 'provider',
    classification: 'plaintext',
    why: 'Provider name (tavily/firecrawl); plaintext for audit and metrics.',
  },
  {
    field: 'operation',
    classification: 'plaintext',
    why: 'Research operation type; plaintext for audit.',
  },
  {
    field: 'credits',
    classification: 'plaintext',
    why: 'Provider-reported credits used; plaintext for accounting.',
  },
  {
    field: 'score',
    classification: 'plaintext',
    why: 'Provider-assigned relevance score; plaintext.',
  },
  {
    field: 'injection_risk_labels',
    classification: 'plaintext',
    why: 'Risk labels are metadata, not content; plaintext.',
  },
  {
    field: 'excluded',
    classification: 'plaintext',
    why: 'Exclusion flag; plaintext.',
  },
  {
    field: 'exclusion_reason',
    classification: 'plaintext',
    why: 'Safe exclusion reason; plaintext.',
  },
  {
    field: 'warnings',
    classification: 'plaintext',
    why: 'Bounded safe warnings; plaintext.',
  },
];

// ---------------------------------------------------------------------------
// Classification lookups
// ---------------------------------------------------------------------------

const RESTRICTED_FIELDS: ReadonlySet<string> = new Set(
  RESEARCH_FIELD_CLASSIFICATIONS.filter((c) => c.classification === 'encrypted').map(
    (c) => c.field,
  ),
);

const PLAINTEXT_FIELDS: ReadonlySet<string> = new Set(
  RESEARCH_FIELD_CLASSIFICATIONS.filter((c) => c.classification === 'plaintext').map(
    (c) => c.field,
  ),
);

/**
 * Returns true if the field is classified as restricted (encrypted at rest).
 */
export function isRestrictedField(field: string): boolean {
  return RESTRICTED_FIELDS.has(field);
}

/**
 * Returns true if the field is classified as plaintext (public projection).
 */
export function isPlaintextField(field: string): boolean {
  return PLAINTEXT_FIELDS.has(field);
}

// ---------------------------------------------------------------------------
// Field-level encryption / decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a restricted research field value using AES-256-GCM.
 * The ciphertext is a `keyId:iv:authTag:ciphertext` envelope string.
 *
 * Only call this for fields classified as `encrypted` in the manifest.
 *
 * @param field - The field name (must be in the restricted set).
 * @param value - The plaintext value to encrypt.
 * @returns The encrypted ciphertext string.
 */
export function encryptResearchField(field: string, value: string): string {
  if (!isRestrictedField(field)) {
    // Non-restricted fields are not encrypted — return as-is.
    return value;
  }
  return encrypt(value);
}

/**
 * Decrypt a restricted research field value.
 *
 * @param encryptedValue - The ciphertext string produced by `encryptResearchField`.
 * @returns The decrypted plaintext value.
 */
export function decryptResearchField(encryptedValue: string): string {
  return decrypt(encryptedValue);
}

// ---------------------------------------------------------------------------
// Record-level encryption / decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt all restricted fields in a research record, leaving plaintext
 * fields as-is. Unknown fields (not in the manifest) are left as-is.
 *
 * This is the record-level helper used by persistence code when writing
 * research source revisions, citations, and provenance rows.
 *
 * @param record - The record with plaintext restricted fields.
 * @returns A new record with restricted fields encrypted.
 */
export function encryptResearchRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isRestrictedField(key) && typeof value === 'string') {
      result[key] = encrypt(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Decrypt all restricted fields in an encrypted research record, leaving
 * plaintext fields as-is. Unknown fields are left as-is.
 *
 * This is the record-level helper used by authorized service code when
 * reading research rows for locator verification or bounded views.
 *
 * @param record - The record with encrypted restricted fields.
 * @returns A new record with restricted fields decrypted.
 */
export function decryptResearchRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isRestrictedField(key) && typeof value === 'string') {
      try {
        result[key] = decrypt(value);
      } catch {
        // If decryption fails (legacy plaintext or corrupted), leave as-is.
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Build a public-safe projection of a research record: only plaintext fields
 * are retained; all restricted fields are removed. This is what API routes
 * return by default — summaries without full document content.
 *
 * @param record - The full record (may be encrypted or plaintext).
 * @param options - Optional fields to include even if restricted (for
 *   authorized bounded views like citation quote windows).
 */
export function buildPublicProjection(
  record: Record<string, unknown>,
  options?: { includeRestricted?: string[] },
): Record<string, unknown> {
  const includeRestricted = new Set(options?.includeRestricted ?? []);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isPlaintextField(key)) {
      result[key] = value;
    } else if (includeRestricted.has(key)) {
      result[key] = value;
    }
    // Restricted fields not in the include set are dropped.
  }
  return result;
}
