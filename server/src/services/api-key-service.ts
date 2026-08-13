import { randomBytes } from 'node:crypto';
import { hashAgentKey, AGENT_KEY_PREFIX } from '../middleware/agent-key-auth.js';

/**
 * Agent API Key Service
 *
 * Handles raw key generation, SHA-256 hashing, and key-prefix derivation
 * for agent API keys. The raw key (`eid_live_<random>`) is returned only
 * once on creation; only the SHA-256 hex hash is persisted in
 * `agent_api_keys.keyHash`.
 */

/** Number of random bytes used to generate the key suffix. */
const RANDOM_BYTES = 24;

/** Length of the key prefix stored for display (first N chars of raw key). */
export const KEY_PREFIX_LENGTH = 10;

/**
 * Generate a new raw agent API key.
 *
 * Format: `eid_live_<base64url-random>` where the random portion is
 * ~32 characters of URL-safe base64 derived from 24 random bytes.
 * Two consecutive calls always produce different values.
 */
export function generateRawKey(): string {
  const random = randomBytes(RANDOM_BYTES).toString('base64url');
  return `${AGENT_KEY_PREFIX}${random}`;
}

/**
 * Compute the SHA-256 hex hash of a raw agent API key.
 *
 * This is the same function used by the agent-key-auth middleware for
 * lookup during authentication, ensuring storage and lookup are
 * consistent.
 */
export function hashKey(rawKey: string): string {
  return hashAgentKey(rawKey);
}

/**
 * Derive the non-secret key prefix from a raw key.
 *
 * The prefix is the first `KEY_PREFIX_LENGTH` characters of the raw key
 * (e.g., `eid_live_X`). It is stored for display purposes so users can
 * identify keys without exposing the secret.
 */
export function deriveKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, KEY_PREFIX_LENGTH);
}
