import { Router } from 'express';
import { eq, isNotNull } from 'drizzle-orm';
import {
  rotateEncryptionKey,
  reencrypt,
  getActiveKeyId,
  getKeyRegistryInfo,
} from '../services/crypto.js';
import { reencryptContent, isContentEncrypted } from '../services/content-encryption.js';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Security admin endpoints (M8 enterprise security — VAL-SEC-010)
// ---------------------------------------------------------------------------
//
// Encryption key rotation + posture introspection. These are platform-admin
// operations (not company-scoped): in `local_trusted` mode the dev user is
// owner/admin; in Clerk mode a platform admin (`req.user.role === 'admin'`)
// is required. The rotation flow:
//
//   1. Generate a new active key (random 32 bytes) + retain the previous key
//      in the registry so pre-rotation ciphertext stays decryptable.
//   2. Re-encrypt every stored ciphertext (artifact content, artifact
//      revision content, secret values, agent API keys) under the new key.
//   3. Return a summary. After rotation the API returns identical decrypted
//      content for all pre-existing data (VAL-SEC-010: no data loss).
// ---------------------------------------------------------------------------

function requirePlatformAdmin(req: any): void {
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';
  if (isLocalTrusted) return; // dev user is owner/admin
  if (req.user?.role === 'admin') return;
  throw new AppError(403, 'INSUFFICIENT_ROLE', 'Platform admin role required');
}

export function securityAdminRouter(db: DbInstance): Router {
  const router = Router();

  // GET /api/admin/encryption/posture — current encryption key posture.
  router.get('/encryption/posture', (req, res) => {
    requirePlatformAdmin(req);
    const info = getKeyRegistryInfo();
    res.json({
      data: {
        algorithm: 'aes-256-gcm',
        activeKeyId: info.activeKeyId,
        knownKeyIds: info.keyIds,
        keyCount: info.keyIds.length,
      },
    });
  });

  // POST /api/admin/encryption/rotate — rotate the active key + re-encrypt
  // all ciphertext at rest under the new key (VAL-SEC-010).
  router.post('/encryption/rotate', async (req, res) => {
    requirePlatformAdmin(req);

    const previousKeyId = getActiveKeyId();
    const { newKeyId } = rotateEncryptionKey();

    // Re-encrypt artifact content (jsonb envelopes).
    let artifactsRotated = 0;
    const artifactRows = await db.drizzle
      .select({ id: db.schema.artifacts.id, content: db.schema.artifacts.content })
      .from(db.schema.artifacts);
    for (const row of artifactRows) {
      const stored = row.content as Record<string, unknown>;
      if (!isContentEncrypted(stored)) continue; // legacy plaintext — leave as-is
      const reencrypted = reencryptContent(stored);
      await db.drizzle
        .update(db.schema.artifacts)
        .set({ content: reencrypted })
        .where(eq(db.schema.artifacts.id, row.id));
      artifactsRotated += 1;
    }

    // Re-encrypt artifact revision content (jsonb envelopes).
    let revisionsRotated = 0;
    const revisionRows = await db.drizzle
      .select({ id: db.schema.artifactRevisions.id, content: db.schema.artifactRevisions.content })
      .from(db.schema.artifactRevisions);
    for (const row of revisionRows) {
      const stored = row.content as Record<string, unknown>;
      if (!isContentEncrypted(stored)) continue;
      const reencrypted = reencryptContent(stored);
      await db.drizzle
        .update(db.schema.artifactRevisions)
        .set({ content: reencrypted })
        .where(eq(db.schema.artifactRevisions.id, row.id));
      revisionsRotated += 1;
    }

    // Re-encrypt secret values (string envelopes).
    let secretsRotated = 0;
    const secretRows = await db.drizzle
      .select({ id: db.schema.secrets.id, valueEncrypted: db.schema.secrets.valueEncrypted })
      .from(db.schema.secrets);
    for (const row of secretRows) {
      try {
        const reencrypted = reencrypt(row.valueEncrypted);
        await db.drizzle
          .update(db.schema.secrets)
          .set({ valueEncrypted: reencrypted, updatedAt: new Date() })
          .where(eq(db.schema.secrets.id, row.id));
        secretsRotated += 1;
      } catch {
        // Skip values that don't decrypt (malformed/legacy) — don't fail rotation.
      }
    }

    // Re-encrypt agent API keys (string envelopes), where present.
    let agentKeysRotated = 0;
    const agentRows = await db.drizzle
      .select({ id: db.schema.agents.id, apiKeyEncrypted: db.schema.agents.apiKeyEncrypted })
      .from(db.schema.agents)
      .where(isNotNull(db.schema.agents.apiKeyEncrypted));
    for (const row of agentRows) {
      if (!row.apiKeyEncrypted) continue;
      try {
        const reencrypted = reencrypt(row.apiKeyEncrypted);
        await db.drizzle
          .update(db.schema.agents)
          .set({ apiKeyEncrypted: reencrypted })
          .where(eq(db.schema.agents.id, row.id));
        agentKeysRotated += 1;
      } catch {
        // Skip values that don't decrypt.
      }
    }

    res.json({
      data: {
        previousKeyId,
        newKeyId,
        artifactsRotated,
        revisionsRotated,
        secretsRotated,
        agentKeysRotated,
      },
    });
  });

  return router;
}
