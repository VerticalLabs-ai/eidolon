# Data handling and privacy

## Data categories

Eidolon can process account identity, organization membership, company
configuration, agent instructions, tasks, approvals, runtime transcripts,
knowledge documents, memories, provider configuration, and audit events.
Treat prompts, transcripts, documents, and provider responses as potentially
confidential. Treat identity, contact, and organization membership fields as
personal data.

### Field-level PII classification

Every sensitive column in the database schema is enumerated and classified by
sensitivity in `server/src/services/privacy.ts` (`PII_FIELD_CLASSIFICATIONS`).
The classification is re-derived from the schema sources by
`server/src/__tests__/privacy-inventory.test.ts`, so adding a new credential,
contact, or transcript column fails the test until it is classified.

| Sensitivity  | Applies to                                            | Examples                                                                                           |
| ------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| identity     | Columns holding a user id that ties a row to a person | `company_members.user_id`, `tasks.created_by_user_id`, `activity_log.actor_id`                     |
| contact      | Direct contact handles                                | `company_invitations.email`, `test_users.email` (test fixture only)                                |
| credential   | Secrets, tokens, API key material, MFA secrets        | `user_mfa_factors.secret`, `webhooks.secret`, `agent_api_keys.key_hash`, `secrets.value_encrypted` |
| confidential | Free-text content that may hold personal data         | `meetings.transcript`, `agent_runtime_sessions.transcript`, `routines.prompt`                      |
| financial    | Cost and billing data                                 | `cost_events.cost_cents`, `budget_alerts.threshold_percent`                                        |
| metadata     | jsonb blobs that may carry arbitrary personal data    | `activity_log.metadata`, `meetings.metadata`, `messages.metadata`                                  |

Each classification records how the field is protected: `hashed` (irreversible
digest stored), `encrypted-at-rest`, `redacted-on-erasure`, `erased-with-subject`
(removed when the subject's row is deleted or nulled), `company-owned` (retention
governed by company policy), or `test-fixture` (test-only, never production).

## Collection and access

- Collect only data required to operate the requested company, agent, task, or
  runtime flow.
- Company-scoped routes must enforce organization membership and runtime
  mutations require the documented operator authorization.
- Provider credentials belong in the configured secret/environment mechanism,
  never in source, fixtures, issue descriptions, or logs.
- Do not send production data to local test databases or test fixtures.

## Logs and retention

Structured logs must not contain credentials, authorization headers, cookies,
environment values, full prompts, or unbounded provider responses. Existing
runtime diagnostics redact remote URL details and configured environment
values. Keep production logs and transcripts only for the shortest operational
period required by the deployment owner, and delete or archive them according
to the applicable retention policy.

### Log redaction policy

The server's Pino logger (`server/src/utils/logger.ts`) is configured with
built-in `redact` paths that automatically censor sensitive fields before they
reach the log stream. The censor replacement value is `[Redacted]`.

The following sensitive paths are redacted in every log entry:

| Category          | Redact paths                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| Authorization     | `req.headers.authorization`, `*.headers.authorization`                             |
| Cookies           | `req.headers.cookie`, `*.headers.cookie`                                           |
| API keys (header) | `req.headers["x-api-key"]`, `*.headers["x-api-key"]`                               |
| Passwords         | `req.body.password`, `req.body.passphrase`, `*.body.password`, `*.body.passphrase` |
| Tokens (body)     | `req.body.token`, `req.body.refreshToken`, `req.body.accessToken`, and wildcards   |
| API keys (body)   | `req.body.apiKey`, `*.body.apiKey`                                                 |
| Secrets (body)    | `req.body.secret`, `req.body.clientSecret`, and wildcards                          |
| Tokens (query)    | `req.query.token`, `req.query.apiKey`, `req.query.secret`, and wildcards           |

Wildcard variants (`*.`) catch the same fields on differently-named containers
(e.g. `res`, the pino-http serialised request object, or custom log objects).

Redaction is verified by `server/src/__tests__/log-redaction.test.ts`, which
confirms that sensitive data is replaced with `[Redacted]` and that
non-sensitive fields (method, URL, content-type, user-agent, body names,
query pagination) are preserved without false positives.

## Retention periods

The following concrete retention periods apply per data category. "Until
deleted" means the data is retained as long as the owning company exists
unless an operator or the data subject requests deletion earlier. Deployment
owners may shorten these periods but must not extend them without a documented
legal basis.

| Data category                         | Retention period                             | Disposition at end of retention                                                                          |
| ------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Account identity (Clerk user records) | Until the user is deleted in Clerk           | Deleted in Clerk; the in-database user-id references are erased on subject erasure.                      |
| Organization membership               | Until the member is removed or erased        | Membership row deleted on erasure or membership removal.                                                 |
| Company configuration                 | Until the company is deleted                 | Cascade-deleted with the company.                                                                        |
| Tasks, approvals, plans, decisions    | Until the company is deleted                 | Authorship is nulled on subject erasure; the content survives as company work product.                   |
| Runtime transcripts and prompts       | 90 days, then archived or deleted            | Deployment owner configures archival; default is deletion. Confidential content.                         |
| Meeting transcripts                   | 90 days, then archived or deleted            | Deployment owner configures archival; default is deletion.                                               |
| Knowledge documents                   | Until the document is deleted by an editor   | Soft-deleted by an editor; removed on company delete.                                                    |
| Agent memories                        | Until the memory is deleted or expires       | `expiresAt` honoured; otherwise deleted with the agent.                                                  |
| Audit log (`activity_log`)            | 7 years                                      | Never deleted. Subject ids are pseudonymised on erasure so the trail survives without naming the person. |
| MFA factors and sessions              | Until the user is erased or the session ends | Deleted on erasure or session expiry. Never exported.                                                    |
| Provider credentials (`secrets`)      | Until the secret is rotated/deleted          | Encrypted at rest; deleted with the company.                                                             |
| Agent API keys                        | Until revoked or expired                     | Soft-deleted via `revokedAt`; hard expiry via `expiresAt`. Hashed, never recoverable.                    |
| Cost events                           | 7 years                                      | Aggregated financial record; retained for accounting/audit.                                              |
| Budget alerts                         | Until the alert is deleted                   | Deleted with the company.                                                                                |
| Product analytics events              | 13 months from event time                    | Aggregated, non-personal events only; purged after 13 months.                                            |
| Application logs                      | 30 days hot, 90 days cold archive            | Structured logs; rotated and archived per the deployment log policy.                                     |

## Subject access and erasure requests

Verified access and deletion requests are served by two owner-only endpoints,
scoped to a single company:

| Request         | Endpoint                                                          |
| --------------- | ----------------------------------------------------------------- |
| Access / export | `GET /api/companies/{companyId}/privacy/subjects/{userId}/export` |
| Erasure         | `POST /api/companies/{companyId}/privacy/subjects/{userId}/erase` |

Both require the `privacy.manage` permission, which is granted to the `owner`
role only, and both respond with `Cache-Control: no-store`. The subject must
already be a member of the named company; any other subject returns `404` so an
owner cannot probe for membership in companies they do not own. Erasure
additionally requires `confirmSubject` in the body to match the path, and
refuses with `409` when an owner names themselves, because that would delete the
membership row authorizing the request and can leave a company without an owner.

### What erasure does

Identity lives in Clerk. This database stores the Clerk user id alongside
whatever the person authored, so erasure severs the link between a person and
their activity rather than deleting a profile that was never held here. **A
request is not complete until the identity is also deleted in Clerk.**

The erasure endpoint attempts the Clerk deletion automatically when
`CLERK_SECRET_KEY` is configured (see
[`docs/runbooks/feature-flags.md`](../runbooks/feature-flags.md) for auth
mode setup). The erasure report includes a `clerkDeletion` result describing
whether the Clerk user was deleted. When `CLERK_SECRET_KEY` is not set (local
development, test environments), the deletion is a safe no-op and the manual
step below is required.

### Manual Clerk deletion (fallback)

When the integrated deletion did not run or reported `deleted: false`, complete
the erasure manually:

1. Sign in to the [Clerk dashboard](https://dashboard.clerk.com) and open the
   application that backs this deployment.
2. Locate the user by the Clerk user id from the erasure request (the subject
   id in the endpoint path).
3. Open the user's detail page and select **Delete user**. Confirm the
   deletion.
4. Record the manual deletion in the audit trail without copying the user id
   into the issue or ticket — reference the per-company pseudonym returned by
   the erasure report instead.
5. Treat the subject access/erasure request as complete only once the Clerk
   user no longer exists.

Every column in the schema that holds a user id is enumerated in
`server/src/services/privacy.ts`, with one of three dispositions:

| Disposition  | Applies to                                                                                                                       | Effect                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Delete       | Membership, inbox read state, team membership, MFA factors, step-up and local-trusted sessions                                   | The row exists only to describe the person, so it is removed.                                                                   |
| Null         | Attribution on shared content: tasks, artifacts, thread items, approvals, plans, decisions, outcomes, meetings, teams, templates | The content survives as company work product with the attribution removed.                                                      |
| Pseudonymise | `activity_log.actor_id`, `agent_api_keys.created_by_user_id`, `company_invitations.invited_by_user_id`                           | The id is replaced with an irreversible per-company hash so a sequence of actions still reads as one actor without naming them. |

Audit rows are never deleted. An accepted invitation's email address is replaced
with a stable non-routable redaction, since it is the only real contact detail
this database stores. For a _pending_ invitation there is no user id to match on,
so pass the address as `email` in the erasure body.

Erasure runs in one transaction and then re-counts every rule, returning
`remainingReferences`. Treat any non-zero value as an incomplete erasure and
escalate rather than reporting the request as fulfilled.

### Deliberate limits

- Pseudonymisation is per company, so the same person is not correlatable across
  companies from the pseudonym alone. It is not reversible, and there is no
  mapping table to un-redact a trail later.
- Export omits authentication material (MFA factors and session rows) by design.
  Returning it would hand an operator live credentials.
- Both operations write an audit row identified by the pseudonym only, so the
  audit trail does not reintroduce the identifier the erasure just removed.

Record the decision and the returned report without copying personal data into
issues. Security incidents follow
[`docs/runbooks/incident.md`](../runbooks/incident.md).

Before sharing diagnostics, remove secrets, tokens, cookies, email addresses,
names, company identifiers, prompts, transcripts, and document contents unless
the recipient is authorized to receive them.

## Product analytics instrumentation

Product analytics is off by default and gated by the `productAnalytics` feature
flag (see [`docs/runbooks/feature-flags.md`](../runbooks/feature-flags.md)).
When disabled, no events are emitted; when enabled, events carry only
non-sensitive aggregate fields.

### What analytics events contain

Each event has a stable name and a typed payload limited to company-scoped
identifiers and counts — for example `company.created` carries `{companyId,
plan}`, and `task.completed` carries `{companyId, projectId, durationMs}`.
The full taxonomy is declared in `server/src/services/product-analytics.ts`.

### What analytics events never contain

A runtime redaction layer strips any field whose name matches a sensitive
pattern (prompt, transcript, credential, password, secret, token, apiKey,
email, phone, name, address, content, body, description, metadata) before the
event reaches the transport. A runtime assertion throws if a sensitive field is
attached, so a type-system escape is caught at emit time rather than silently
redacted.

### Provider-agnostic transport

No vendor SDK is embedded in product code. The emitter calls a transport
function that receives the sanitised event; the default transport is a no-op,
and a console transport is available for development. Production wiring is
configured via the `PRODUCT_ANALYTICS_TRANSPORT` environment variable.
