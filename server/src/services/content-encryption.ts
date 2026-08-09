import { encrypt, decrypt } from './crypto.js';

// ---------------------------------------------------------------------------
// Content encryption (M8 enterprise security — VAL-SEC-004 / VAL-SEC-010)
// ---------------------------------------------------------------------------
//
// Artifact `content` is stored as jsonb. To encrypt it at rest we wrap the
// serialized content in an AES-256-GCM envelope and store the envelope as a
// jsonb object:
//
//   { __encrypted: true, alg: 'aes-256-gcm', keyId, data: '<ciphertext>' }
//
// A direct `psql SELECT content FROM artifacts` shows the envelope (ciphertext
// in `data`), not plaintext — satisfying VAL-SEC-004. The API layer decrypts
// on read so authorized clients receive readable content.
//
// `decryptContent` is tolerant of legacy plaintext content (pre-encryption
// rows): when `__encrypted` is absent the value is returned as-is, so the
// migration to encryption-at-rest is forward-compatible with existing rows.
// ---------------------------------------------------------------------------

const ENVELOPE_TAG = '__encrypted';

export interface EncryptedEnvelope {
  __encrypted: true;
  alg: 'aes-256-gcm';
  keyId: string;
  data: string;
}

/**
 * Encrypt a content object into a jsonb-storable encryption envelope.
 */
export function encryptContent(content: Record<string, unknown>): Record<string, unknown> {
  const data = encrypt(JSON.stringify(content));
  // The keyId is the first segment of the 4-part ciphertext envelope.
  const keyId = data.split(':')[0];
  return { __encrypted: true, alg: 'aes-256-gcm', keyId, data } as Record<string, unknown>;
}

/**
 * Decrypt a stored content value. If the value is an encryption envelope, the
 * decrypted content object is returned. Otherwise (legacy plaintext content)
 * the value is returned unchanged.
 */
export function decryptContent(stored: Record<string, unknown>): Record<string, unknown> {
  if (!stored || typeof stored !== 'object' || (stored as any)[ENVELOPE_TAG] !== true) {
    return stored;
  }
  const envelope = stored as unknown as EncryptedEnvelope;
  const json = decrypt(envelope.data);
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * True when the stored value is an encryption envelope (ciphertext at rest).
 */
export function isContentEncrypted(stored: unknown): boolean {
  return (
    !!stored &&
    typeof stored === 'object' &&
    (stored as any)[ENVELOPE_TAG] === true
  );
}

/**
 * Re-encrypt an envelope under the current active key. Used by the key
 * rotation flow. Accepts either an envelope or legacy plaintext content and
 * always returns an envelope encrypted under the active key.
 */
export function reencryptContent(stored: Record<string, unknown>): Record<string, unknown> {
  const plaintext = decryptContent(stored);
  return encryptContent(plaintext);
}
