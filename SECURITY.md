# Security Posture — Eidolon

This document describes the security controls implemented in Eidolon as of the
M8 enterprise-security milestone. It is a compliance-posture statement, not a
SOC 2 / ISO 27001 audit package — controls are marked **Implemented** or
**Roadmap** so the posture is not overstated.

## Authentication & MFA

- **Auth modes.** Production uses Clerk (session cookies, org membership,
  org roles: `owner` / `admin` / `member` / `viewer`). Local development and
  validation use `AUTH_MODE=local_trusted`, which auto-authenticates on
  loopback with a dev user — never enabled in production.
- **TOTP MFA — Implemented.** Users enroll a TOTP factor
  (`POST /api/auth/mfa/enroll`) from their account/security settings. The
  factor secret is stored base32-encoded in `user_mfa_factors`; the list
  endpoint never returns the secret. Verification
  (`POST /api/auth/mfa/verify`) accepts a ±1 step window to tolerate clock
  skew. (VAL-SEC-001/002/003.)
- **Step-up re-authentication — Implemented.** Sensitive operations —
  permanent company deletion (`?hard=true`), permanent artifact deletion
  (`?permanent=true`), and artifact ownership transfer — require a
  step-up session (`POST /api/auth/step-up`) granted after a valid MFA code.
  The session is scope-bound and time-boxed; absent or expired step-up →
  `403 MFA_STEP_UP_REQUIRED` with no mutation. (VAL-SEC-008.)
- **Session invalidation on privilege loss — Implemented.** When a user's
  org role is downgraded or they are removed from a company, their existing
  session can no longer perform now-disallowed operations on the next
  request (modeled via mutable `local_trusted_sessions` in dev; Clerk session
  revocation in production). (VAL-SEC-011.)

## Encryption at Rest

- **Algorithm.** AES-256-GCM with a per-value random 12-byte IV and 16-byte
  auth tag. The active encryption key is derived from
  `EIDOLON_ENCRYPTION_KEY` (scrypt-derived to 32 bytes when shorter than 32
  bytes; first 32 bytes used otherwise). A deterministic dev fallback key is
  used when the env var is absent — **never use the fallback in production**.
- **Artifact content — Implemented.** Every artifact's `content` (jsonb) and
  every `artifact_revisions.content` snapshot is stored as an encryption
  envelope `{ __encrypted: true, alg: 'aes-256-gcm', keyId, data }` where
  `data` is the base64 ciphertext. A direct database query shows ciphertext,
  not plaintext; the API decrypts and returns readable content only to
  authorized clients. (VAL-SEC-004.)
- **Secrets vault — Implemented.** `secrets.value_encrypted` stores
  AES-256-GCM ciphertext. The secrets API never returns the cleartext value
  — only metadata (name, provider, description, timestamps). (VAL-SEC-005.)
- **Agent API keys — Implemented.** `agents.api_key_encrypted` stores
  AES-256-GCM ciphertext; the agentic loop decrypts in-memory at provider
  call time.
- **Key rotation — Implemented.** `POST /api/admin/encryption/rotate`
  (platform-admin gated) generates a new active key, retains the previous
  key in the registry for decryption of pre-rotation ciphertext, and
  re-encrypts all artifact content, revision content, secret values, and
  agent API keys under the new key. After rotation the API returns identical
  decrypted content for all pre-existing data — no data loss. Each ciphertext
  is tagged with its `keyId` so decryption always selects the right key.
  (VAL-SEC-010.) In production, set `EIDOLON_ENCRYPTION_KEY` to the new key
  and `EIDOLON_ENCRYPTION_LEGACY_KEYS` (JSON `{ keyId: material }`) to the
  previous keys so deployed instances can read pre-rotation ciphertext.

## RBAC (Role-Based Access Control)

- **Org roles.** `owner` > `admin` > `member` > `viewer`. Routes that affect
  access levels (teams, permissions, integrations, MCP, webhooks, secrets,
  environments) require `admin`+ via `requireOrgMember('admin')`.
- **Per-resource RBAC (M4) — Implemented.** Beyond org roles, per-resource
  permissions (`artifact_permissions`) grant `view` / `edit` / `manage` on
  projects, folders, and artifacts to users or teams. Effective access is
  resolved by walking the resource chain (artifact → folder → project) with
  specific-grant-overrides-inherited semantics. Owner/admin always manage.
- **Graceful 403 — Implemented.** RBAC denials return a structured
  `403` body (`{ status, code, message }`) — `INSUFFICIENT_ROLE`,
  `INSUFFICIENT_ACCESS`, or `FORBIDDEN` — never a `500` or stack trace. The
  UI surfaces a clean forbidden toast and does not crash. (VAL-SEC-006.)

## Audit Logging

- **Activity log — Implemented.** The `activity_log` table records
  security-relevant actions with `actor_type`, `actor_id`, `action`,
  `entity_type`, `entity_id`, `description`, `metadata`, and `created_at`.
  Records are retrievable by admins via `GET /api/companies/:companyId/activity`.
  (VAL-SEC-007.)
- **Audited actions.** MFA enrollment (`mfa.enroll`), permission grant
  (`permission.granted`), permission revoke (`permission.revoked`), artifact
  soft-delete (`artifact.deleted`), artifact permanent deletion
  (`artifact.delete_permanent`), artifact ownership transfer
  (`artifact.ownership_transfer`), company permanent deletion
  (`company.delete_permanent`), and secret lifecycle
  (`secret.created`/`updated`/`deleted`). Security-relevant events carry an
  explicit `actor` descriptor so the audit row records the acting user/agent
  rather than defaulting to `system`.
- **Audit retention.** Audit rows are append-only and retained for the
  company's lifetime. Company permanent deletion records the deletion event
  before the cascade removes the company's other rows.

## Rate Limiting

- **Auth-sensitive endpoints — Implemented.** MFA verification
  (`POST /api/auth/mfa/verify`), step-up re-authentication
  (`POST /api/auth/step-up`), and local-trusted session creation
  (`POST /api/auth/local-trusted/create-session`) are protected by a strict
  per-IP rate limiter (default 10 requests / 15 min; override via
  `RATE_LIMIT_AUTH_SENSITIVE_MAX`). Repeated rapid requests beyond the limit
  receive `429 RATE_LIMITED`. This limiter is always-on in dev/validation so
  the posture is demonstrable; the deterministic test suite bypasses it via
  `EIDOLON_RATE_LIMIT_TEST_BYPASS=1`. (VAL-SEC-009.)
- **General API + auth rate limiting — Implemented (opt-in).** Broad
  per-IP limits (`apiRateLimit`, `authRateLimit`) are active in production
  (`NODE_ENV=production`) or when `RATE_LIMIT_ENABLED=1`, and skipped in
  dev/test to avoid self-throttling.

## Data Handling

- **Company scoping.** Every artifact, secret, and permission query is
  scoped by `companyId`; cross-company access is rejected with `403`/`404`.
- **Agent authoring.** Agent artifact tools run server-side under the
  existing auth/RLS + company scoping. Agent-authored content is data, not
  code execution (except the M6 code artifact, which runs in a sandboxed
  runtime with filesystem/subprocess/network blocklists).
- **Secrets handling.** Secret values are encrypted at rest and never
  returned in cleartext by the API. Agent API keys are encrypted at rest and
  decrypted only in-memory for provider calls.
- **No secrets in logs.** Encryption keys, secret values, and API keys are
  never printed to logs or error responses.

## Roadmap (not yet implemented)

- External KMS / managed key integration (currently env-var keys).
- DB-level guards enforcing `artifact_revisions` append-only (currently
  service-enforced).
- Formal SOC 2 / ISO 27001 audit packages.
- Clerk-native MFA enrollment as the production factor store (server-side
  TOTP store is the current dev/validation and fallback path).
