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

## Requests and incidents

The current application does not provide a general automated GDPR/CCPA export
or deletion workflow. Until one exists, operators must handle verified access,
export, correction, and deletion requests through the deployment owner and
record the decision without copying personal data into issues. Security
incidents follow [`docs/runbooks/incident.md`](../runbooks/incident.md).

Before sharing diagnostics, remove secrets, tokens, cookies, email addresses,
names, company identifiers, prompts, transcripts, and document contents unless
the recipient is authorized to receive them.
