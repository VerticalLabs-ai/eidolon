/**
 * Frozen display metadata for historical provenance (VAL-RES-113).
 *
 * When a citation is created, a snapshot of the source's display metadata
 * (title, author, canonical URL, retrieval time, provider, content hash) is
 * frozen onto the citation row. A historical citation view reads the frozen
 * snapshot, not the current source metadata, so a later re-retrieval or edit
 * cannot rewrite the provenance drawer.
 *
 * This module is pure: it produces a bounded frozen record that the
 * persistence layer stores (encrypting restricted fields). It does not
 * touch the database.
 */

import { MAX_TITLE_CHARS, MAX_AUTHOR_CHARS } from './source-normalization.js';

// ---------------------------------------------------------------------------
// Frozen snapshot
// ---------------------------------------------------------------------------

export interface FrozenDisplayMetadata {
  title?: string;
  author?: string;
  canonicalUrl: string;
  retrievedAt: string;
  provider: string;
  contentHash?: string;
  /** When the snapshot was frozen (ISO 8601 UTC). */
  frozenAt: string;
}

export interface FreezeDisplayMetadataInput {
  title?: unknown;
  author?: unknown;
  canonicalUrl: unknown;
  retrievedAt: unknown;
  provider: unknown;
  contentHash?: unknown;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
}

function capString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const nfc = value.normalize('NFC');
  return nfc.length > max ? nfc.slice(0, max) : nfc;
}

/**
 * Build a bounded frozen display-metadata snapshot (VAL-RES-113).
 *
 * Required fields (canonicalUrl, retrievedAt, provider) must be present and
 * string-valued; otherwise the snapshot throws. Optional fields are
 * NFC-normalized and capped.
 */
export function freezeDisplayMetadata(input: FreezeDisplayMetadataInput): FrozenDisplayMetadata {
  if (typeof input.canonicalUrl !== 'string' || !input.canonicalUrl) {
    throw new Error('frozen canonicalUrl is required');
  }
  if (typeof input.retrievedAt !== 'string' || !input.retrievedAt) {
    throw new Error('frozen retrievedAt is required');
  }
  if (typeof input.provider !== 'string' || !input.provider) {
    throw new Error('frozen provider is required');
  }

  const result: FrozenDisplayMetadata = {
    canonicalUrl: input.canonicalUrl,
    retrievedAt: input.retrievedAt,
    provider: input.provider,
    frozenAt: (input.now ?? (() => new Date()))().toISOString(),
  };

  const title = capString(input.title, MAX_TITLE_CHARS);
  if (title) {
    result.title = title;
  }
  const author = capString(input.author, MAX_AUTHOR_CHARS);
  if (author) {
    result.author = author;
  }
  if (typeof input.contentHash === 'string') {
    result.contentHash = input.contentHash;
  }

  return result;
}
