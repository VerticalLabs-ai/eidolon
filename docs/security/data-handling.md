# Data handling and privacy

## Data categories

Eidolon can process account identity, organization membership, company
configuration, agent instructions, tasks, approvals, runtime transcripts,
knowledge documents, memories, provider configuration, and audit events.
Treat prompts, transcripts, documents, and provider responses as potentially
confidential. Treat identity, contact, and organization membership fields as
personal data.

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
