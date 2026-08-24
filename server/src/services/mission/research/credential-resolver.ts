/**
 * Company-scoped research credential resolution and rotation
 * (VAL-RES-091).
 *
 * Each research call uses its company's encrypted credential when configured,
 * otherwise only the deployment default. Another company's secret is never
 * considered. Rotation affects new logical calls only — an in-flight
 * resolved credential keeps its key for the duration of that call.
 *
 * No secret, ciphertext, or fingerprint reaches policy JSON, command/event
 * payloads, provider health rows, traces, UI bundles, or artifacts. The
 * credential handle exposes only a non-secret identity (provider, source,
 * fingerprint, company ID) and an explicit `getApiKey()` method for
 * authorized service paths.
 */

import { createHash } from 'node:crypto';
import { AppError } from '../../../middleware/error-handler.js';

// ---------------------------------------------------------------------------
// Credential store interface
// ---------------------------------------------------------------------------

/**
 * A minimal interface for resolving company-scoped encrypted credentials.
 * In production this is backed by the `secrets` table; tests inject a mock.
 *
 * The store returns the decrypted credential value (the `secrets` table stores
 * `value_encrypted`; the caller decrypts before returning). This interface
 * keeps the credential resolver testable without coupling to the Drizzle
 * schema.
 */
export interface CredentialStore {
  /**
   * Get the decrypted credential value for a company and provider name.
   * Returns `undefined` if no credential is configured for this company.
   */
  getSecret(companyId: string, providerName: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Resolved credential
// ---------------------------------------------------------------------------

export type CredentialSource = 'company' | 'default';

/**
 * A resolved research credential. The `apiKey` is the raw secret — it is
 * accessible only within authorized service code. Do not serialize this
 * object into events, logs, traces, or artifacts.
 */
export interface ResolvedCredential {
  provider: string;
  apiKey: string;
  source: CredentialSource;
  /** Company ID when `source === 'company'`, null for deployment default. */
  companyId: string | null;
}

// ---------------------------------------------------------------------------
// Credential handle
// ---------------------------------------------------------------------------

/**
 * A safe handle to a resolved credential. Exposes only non-secret identity
 * metadata. The raw API key is accessible only through `getApiKey()`, which
 * authorized service paths call when dispatching a provider request.
 *
 * The handle is immutable — rotation produces a new handle rather than
 * mutating the old one, so an in-flight call keeps its resolved credential.
 */
export class CredentialHandle {
  public readonly provider: string;
  public readonly source: CredentialSource;
  public readonly companyId: string | null;
  public readonly fingerprint: string;

  private readonly _apiKey: string;

  constructor(resolved: ResolvedCredential) {
    this.provider = resolved.provider;
    this.source = resolved.source;
    this.companyId = resolved.companyId;
    this._apiKey = resolved.apiKey;
    this.fingerprint = credentialFingerprint(resolved.apiKey);
  }

  /**
   * Get the raw API key. Only authorized service paths should call this.
   * Never log, serialize, or expose the return value in events/artifacts.
   */
  getApiKey(): string {
    return this._apiKey;
  }
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute a non-reversible SHA-256 fingerprint (first 16 hex chars) of a
 * credential. Used for audit/logging without exposing the secret.
 *
 * The fingerprint is a one-way hash — it cannot be reversed to recover the
 * key. It is safe to include in provider acceptance logs keyed by non-secret
 * identity (VAL-RES-091).
 */
export function credentialFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a research credential for a company and provider.
 *
 * Resolution order:
 *  1. Company-scoped encrypted credential from the store (when configured).
 *  2. Deployment default (from environment) when no company credential exists.
 *  3. `503 CREDENTIAL_UNAVAILABLE` when neither is available.
 *
 * Another company's secret is never considered — the store lookup is always
 * scoped to the requesting `companyId`.
 *
 * @param store - The credential store (production: `secrets` table).
 * @param companyId - The company making the research call.
 * @param providerName - The provider name (e.g. 'tavily', 'firecrawl').
 * @param defaultKey - The deployment default key from environment (optional).
 */
export async function resolveResearchCredential(
  store: CredentialStore,
  companyId: string,
  providerName: string,
  defaultKey?: string,
): Promise<ResolvedCredential> {
  // 1. Try company-scoped credential.
  const companyKey = await store.getSecret(companyId, providerName);
  if (companyKey) {
    return {
      provider: providerName,
      apiKey: companyKey,
      source: 'company',
      companyId,
    };
  }

  // 2. Fall back to deployment default.
  if (defaultKey) {
    return {
      provider: providerName,
      apiKey: defaultKey,
      source: 'default',
      companyId: null,
    };
  }

  // 3. No credential available — fail closed.
  throw new AppError(
    503,
    'CREDENTIAL_UNAVAILABLE',
    `No credential configured for provider '${providerName}'`,
  );
}

// ---------------------------------------------------------------------------
// Handle creation
// ---------------------------------------------------------------------------

/**
 * Create a safe credential handle from a resolved credential.
 * The handle exposes non-secret identity metadata and a `getApiKey()` method.
 */
export function createCredentialHandle(resolved: ResolvedCredential): CredentialHandle {
  return new CredentialHandle(resolved);
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/**
 * Rotate a credential handle by creating a new handle with the new key.
 * The old handle is unchanged — an in-flight resolved credential keeps its
 * key for the duration of that logical call. Only new logical calls resolve
 * the rotated credential from the store.
 *
 * @param oldHandle - The previous credential handle (unchanged by this call).
 * @param newApiKey - The new API key (from the rotated store entry).
 * @returns A new credential handle with the rotated key.
 */
export function rotateResearchCredential(
  _oldHandle: CredentialHandle,
  newApiKey: string,
): CredentialHandle {
  return new CredentialHandle({
    provider: _oldHandle.provider,
    apiKey: newApiKey,
    source: _oldHandle.source,
    companyId: _oldHandle.companyId,
  });
}
