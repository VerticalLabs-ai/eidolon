import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  resolveResearchCredential,
  createCredentialHandle,
  rotateResearchCredential,
  credentialFingerprint,
} from '../services/mission/research/credential-resolver.js';
import type { AppError } from '../middleware/error-handler.js';

/**
 * Company-scoped credential resolution and rotation tests.
 *
 * VAL-RES-091: Company-scoped credential resolution and rotation
 *
 * Each research call uses its company's encrypted credential when configured,
 * otherwise only the deployment default; another company's secret is never
 * considered, rotation affects new logical calls only, and no
 * secret/ciphertext/fingerprint reaches policy, events, health, traces, UI,
 * or artifacts.
 */

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000002';

const COMPANY_A_KEY = 'tavily-key-company-a- SECRET_VALUE_A';
const COMPANY_B_KEY = 'tavily-key-company-b- SECRET_VALUE_B';
const DEFAULT_KEY = 'tavily-key-deployment-default- SECRET_VALUE_DEFAULT';

// ---------------------------------------------------------------------------
// Mock credential store
// ---------------------------------------------------------------------------

interface MockSecretRow {
  companyId: string;
  name: string;
  valueEncrypted: string;
  provider: string;
}

function makeMockStore(rows: MockSecretRow[]): {
  getSecret: (companyId: string, provider: string) => Promise<string | undefined>;
} {
  return {
    getSecret: async (companyId: string, provider: string) =>
      rows.find((r) => r.companyId === companyId && r.name === provider)?.valueEncrypted,
  };
}

// ---------------------------------------------------------------------------
// VAL-RES-091: Company-scoped credential resolution and rotation
// ---------------------------------------------------------------------------

describe('VAL-RES-091: Company-scoped credential resolution and rotation', () => {
  it('uses company-specific credential when configured', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: COMPANY_A_KEY, provider: 'local' },
    ]);
    const result = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    expect(result.source).toBe('company');
    expect(result.apiKey).toBe(COMPANY_A_KEY);
    expect(result.companyId).toBe(COMPANY_A);
  });

  it('falls back to deployment default when company has no credential', async () => {
    const store = makeMockStore([]);
    const result = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    expect(result.source).toBe('default');
    expect(result.apiKey).toBe(DEFAULT_KEY);
    expect(result.companyId).toBeNull();
  });

  it('never uses another company secret', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_B, name: 'tavily', valueEncrypted: COMPANY_B_KEY, provider: 'local' },
    ]);
    // Company A has no credential; it must NOT receive Company B's key.
    const result = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    expect(result.source).toBe('default');
    expect(result.apiKey).toBe(DEFAULT_KEY);
    expect(result.apiKey).not.toBe(COMPANY_B_KEY);
  });

  it('throws CREDENTIAL_UNAVAILABLE when no company credential and no default', async () => {
    const store = makeMockStore([]);
    try {
      await resolveResearchCredential(store, COMPANY_A, 'tavily', undefined);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as AppError).status).toBe(503);
      expect((err as AppError).code).toBe('CREDENTIAL_UNAVAILABLE');
    }
  });

  it('credential handle does not expose the raw secret', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: COMPANY_A_KEY, provider: 'local' },
    ]);
    const resolved = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    const handle = createCredentialHandle(resolved);
    // The handle exposes a non-secret identity, not the raw key.
    expect(handle.provider).toBe('tavily');
    expect(handle.source).toBe('company');
    expect(handle.fingerprint).toBeTruthy();
    expect(handle.fingerprint).not.toContain(COMPANY_A_KEY);
    // The raw key is accessible only through an explicit authorized method.
    expect((handle as unknown as Record<string, unknown>).apiKey).toBeUndefined(); // not a public property
    expect(handle.getApiKey()).toBe(COMPANY_A_KEY);
  });

  it('credential fingerprint is a non-reversible hash', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: COMPANY_A_KEY, provider: 'local' },
    ]);
    const resolved = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    const handle = createCredentialHandle(resolved);
    // Fingerprint is a SHA-256 hash prefix — cannot be reversed to the key.
    expect(handle.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // Same key produces same fingerprint.
    const expectedFp = createHash('sha256').update(COMPANY_A_KEY).digest('hex').slice(0, 16);
    expect(handle.fingerprint).toBe(expectedFp);
  });

  it('credential fingerprint does not leak the secret value', () => {
    const fp = credentialFingerprint(COMPANY_A_KEY);
    expect(fp).not.toContain(COMPANY_A_KEY);
    expect(fp).not.toContain('SECRET_VALUE');
    // Different keys produce different fingerprints.
    const fpB = credentialFingerprint(COMPANY_B_KEY);
    expect(fp).not.toBe(fpB);
  });

  it('rotation produces a new credential handle for new logical calls only', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: COMPANY_A_KEY, provider: 'local' },
    ]);
    // Resolve credential for an in-flight logical call.
    const resolved1 = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    const handle1 = createCredentialHandle(resolved1);

    // Rotate: update the store to a new key.
    const NEW_KEY = 'tavily-key-company-a-rotated- SECRET_VALUE_ROTATED';
    const rotatedStore = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: NEW_KEY, provider: 'local' },
    ]);

    // The in-flight handle still has the OLD key — rotation does not
    // retroactively change resolved credentials.
    expect(handle1.getApiKey()).toBe(COMPANY_A_KEY);

    // A new logical call resolves the NEW key.
    const resolved2 = await resolveResearchCredential(
      rotatedStore,
      COMPANY_A,
      'tavily',
      DEFAULT_KEY,
    );
    const handle2 = createCredentialHandle(resolved2);
    expect(handle2.getApiKey()).toBe(NEW_KEY);
    expect(handle2.fingerprint).not.toBe(handle1.fingerprint);
  });

  it('credential handle does not expose ciphertext or key material in serialized form', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: COMPANY_A_KEY, provider: 'local' },
    ]);
    const resolved = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    const handle = createCredentialHandle(resolved);
    // Serializing the handle for events/audit must not leak the key.
    const serialized = JSON.stringify({
      provider: handle.provider,
      source: handle.source,
      fingerprint: handle.fingerprint,
      companyId: handle.companyId,
    });
    expect(serialized).not.toContain(COMPANY_A_KEY);
    expect(serialized).not.toContain('SECRET_VALUE');
  });

  it('different providers for same company resolve independently', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: COMPANY_A_KEY, provider: 'local' },
    ]);
    // Firecrawl not configured for Company A → falls back to default.
    const result = await resolveResearchCredential(store, COMPANY_A, 'firecrawl', DEFAULT_KEY);
    expect(result.source).toBe('default');
    expect(result.apiKey).toBe(DEFAULT_KEY);
  });

  it('rotateResearchCredential updates the credential handle for future calls', async () => {
    const store = makeMockStore([
      { companyId: COMPANY_A, name: 'tavily', valueEncrypted: COMPANY_A_KEY, provider: 'local' },
    ]);
    const resolved = await resolveResearchCredential(store, COMPANY_A, 'tavily', DEFAULT_KEY);
    const handle = createCredentialHandle(resolved);

    // Rotate the handle in-place (simulates key rotation where the new
    // key is provisioned). The old handle's key is unchanged, but a
    // rotated handle uses the new key.
    const NEW_KEY = 'tavily-key-rotated- SECRET_ROTATED';
    const rotatedHandle = rotateResearchCredential(handle, NEW_KEY);
    expect(rotatedHandle.getApiKey()).toBe(NEW_KEY);
    expect(rotatedHandle.fingerprint).not.toBe(handle.fingerprint);
    // The old handle is unchanged.
    expect(handle.getApiKey()).toBe(COMPANY_A_KEY);
  });
});
