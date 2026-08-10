import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// ---------------------------------------------------------------------------
// Key registry (M8 enterprise security — encryption-at-rest + key rotation)
// ---------------------------------------------------------------------------
//
// The registry holds the ACTIVE key (used for all new `encrypt()` calls) plus
// every previously-active key (retained so `decrypt()` can read ciphertext
// produced before a rotation). Each key is identified by a stable `keyId`
// derived from its material, and every new ciphertext is prefixed with that
// keyId so decryption always picks the right key — even after multiple
// rotations.
//
// Envelope formats:
//   • New (keyId-tagged):   `keyId:iv:authTag:ciphertext`  (4 base64 parts)
//   • Legacy (pre-rotation): `iv:authTag:ciphertext`        (3 base64 parts)
//
// Legacy 3-part envelopes have no keyId. `decrypt()` tries every key in the
// registry against them (GCM auth-tag verification rejects wrong keys), so
// pre-refactor data remains readable after rotation.
//
// In dev/test the key comes from the deterministic dev fallback (or
// `EIDOLON_ENCRYPTION_KEY`). `rotateEncryptionKey()` generates a fresh random
// key in-memory and re-encrypts all ciphertext under it — the dev/validation
// path for VAL-SEC-010. In production the active key + legacy keys are sourced
// from `EIDOLON_ENCRYPTION_KEY` + `EIDOLON_ENCRYPTION_LEGACY_KEYS` (a JSON
// map of `{ keyId: material }`); rotation updates those env/KMS values.
// ---------------------------------------------------------------------------

const keyRegistry = new Map<string, Buffer>();
let activeKeyId: string;

function deriveKey(material: string): Buffer {
  if (material.length >= 32) {
    return Buffer.from(material.slice(0, 32), 'utf8');
  }
  return scryptSync(material, 'eidolon-salt', 32);
}

function keyIdFromKey(key: Buffer): string {
  // Stable, non-reversible id derived from the key material.
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function loadKeys(): void {
  const envKey = process.env.EIDOLON_ENCRYPTION_KEY;
  let primary: Buffer;
  if (envKey) {
    primary = deriveKey(envKey);
  } else {
    // Development fallback — deterministic but NOT secure for production.
    primary = scryptSync('eidolon-dev-encryption-key', 'eidolon-dev-salt-v1', 32);
  }
  activeKeyId = keyIdFromKey(primary);
  keyRegistry.set(activeKeyId, primary);

  // Legacy/old keys for decryption (EIDOLON_ENCRYPTION_LEGACY_KEYS = JSON
  // { keyId: material }). Lets production rotate by adding the previous key
  // here after updating EIDOLON_ENCRYPTION_KEY to the new active value.
  const legacy = process.env.EIDOLON_ENCRYPTION_LEGACY_KEYS;
  if (legacy) {
    try {
      const map = JSON.parse(legacy) as Record<string, string>;
      for (const [kid, material] of Object.entries(map)) {
        if (!keyRegistry.has(kid)) {
          keyRegistry.set(kid, deriveKey(material));
        }
      }
    } catch {
      // Ignore malformed legacy key config — decryption will surface unknown
      // keyId errors clearly.
    }
  }

  // Always retain the original dev fallback key so legacy 3-part envelopes
  // encrypted under it remain decryptable even when an env key is set.
  const devKey = scryptSync('eidolon-dev-encryption-key', 'eidolon-dev-salt-v1', 32);
  const devKeyId = keyIdFromKey(devKey);
  if (!keyRegistry.has(devKeyId)) {
    keyRegistry.set(devKeyId, devKey);
  }
}

loadKeys();

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string using AES-256-GCM under the active key.
 * Returns `keyId:iv:authTag:ciphertext` (all base64-encoded).
 */
export function encrypt(plaintext: string): string {
  const key = keyRegistry.get(activeKeyId);
  if (!key) throw new Error('No active encryption key configured');

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    activeKeyId,
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a string produced by `encrypt()` (4-part keyId-tagged format) or a
 * legacy 3-part envelope (no keyId — tries every known key).
 */
export function decrypt(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 4 && parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  if (parts.length === 4) {
    const [keyId, ivB64, authTagB64, ciphertextB64] = parts;
    const key = keyRegistry.get(keyId);
    if (!key) {
      throw new Error(`Unknown encryption key id: ${keyId}`);
    }
    return decryptWith(key, ivB64, authTagB64, ciphertextB64);
  }

  // Legacy 3-part format (no keyId). Try every known key — GCM auth-tag
  // verification rejects wrong keys, so the first success is the right one.
  const [ivB64, authTagB64, ciphertextB64] = parts;
  let lastErr: unknown;
  for (const key of keyRegistry.values()) {
    try {
      return decryptWith(key, ivB64, authTagB64, ciphertextB64);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('No decryption key matches the legacy ciphertext');
}

function decryptWith(key: Buffer, ivB64: string, authTagB64: string, ciphertextB64: string): string {
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Key rotation (VAL-SEC-010)
// ---------------------------------------------------------------------------

/**
 * Rotate the active encryption key. Generates a fresh random 32-byte key (or
 * uses the provided `newKeyMaterial`), registers it as the active key, and
 * retains the previous active key in the registry so pre-rotation ciphertext
 * remains decryptable. Returns the new + previous key ids.
 *
 * After rotation, call `reencrypt()` on every stored ciphertext to re-encrypt
 * it under the new key. Until re-encryption completes, `decrypt()` reads old
 * ciphertext via the retained previous key, so no data is lost.
 */
export function rotateEncryptionKey(newKeyMaterial?: string): {
  newKeyId: string;
  previousKeyId: string;
} {
  const previousKeyId = activeKeyId;
  const newKey =
    newKeyMaterial !== undefined
      ? deriveKey(newKeyMaterial)
      : randomBytes(32);
  const newKeyId = keyIdFromKey(newKey);
  keyRegistry.set(newKeyId, newKey);
  activeKeyId = newKeyId;
  return { newKeyId, previousKeyId };
}

/**
 * Re-encrypt a ciphertext string under the current active key. The input is
 * decrypted (using whatever key produced it) and re-encrypted with the active
 * key + its keyId. Used by the rotation flow to migrate stored ciphertext.
 */
export function reencrypt(encrypted: string): string {
  const plaintext = decrypt(encrypted);
  return encrypt(plaintext);
}

/**
 * The active key id (used for all new `encrypt()` calls).
 */
export function getActiveKeyId(): string {
  return activeKeyId;
}

/**
 * Diagnostic: all known key ids + which is active.
 */
export function getKeyRegistryInfo(): { activeKeyId: string; keyIds: string[] } {
  return { activeKeyId, keyIds: Array.from(keyRegistry.keys()) };
}

/**
 * Test-only escape hatch: reset the key registry back to the env/dev default.
 * Used by integration tests that exercise rotation so one test's rotation
 * doesn't leak into the next.
 */
export function __resetKeyRegistryForTest(): void {
  keyRegistry.clear();
  loadKeys();
}
