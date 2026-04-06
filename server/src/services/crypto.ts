import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte encryption key from EIDOLON_ENCRYPTION_KEY env var,
 * or fall back to a deterministic dev key derived from a fixed salt.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.EIDOLON_ENCRYPTION_KEY;
  if (envKey && envKey.length >= 32) {
    // Use first 32 bytes of the provided key
    return Buffer.from(envKey.slice(0, 32), 'utf8');
  }
  if (envKey) {
    // Derive a proper 32-byte key from the short env value
    return scryptSync(envKey, 'eidolon-salt', 32);
  }
  // Development fallback -- deterministic but NOT secure for production
  return scryptSync('eidolon-dev-encryption-key', 'eidolon-dev-salt-v1', 32);
}

const KEY = getEncryptionKey();

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a string in the format `iv:authTag:ciphertext` (all base64-encoded).
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a string produced by `encrypt()`.
 * Expects the format `iv:authTag:ciphertext` (all base64-encoded).
 */
export function decrypt(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
