# Security scanning and privacy requests

Three security surfaces produce evidence you can read without downloading a
SARIF file or reasoning about a scanner's exit code: CodeQL, DAST, and the
subject access endpoints.

## Static analysis (CodeQL)

The `CodeQL` workflow runs on every pull request and on a weekly schedule. In
addition to uploading results to the GitHub Security tab, it writes a readable
summary so a reviewer does not have to leave the run:

- **Run summary** — open the workflow run; the summary lists each rule with its
  severity, occurrence count, and up to five file locations per rule. A clean
  analysis says so explicitly rather than rendering an empty table.
- **Artifact** — `codeql-security-summary`, retained 30 days, contains the same
  Markdown plus the raw SARIF for offline triage.

Severity comes from the rule's `security-severity` score when present, since the
coarse SARIF `level` collapses everything into error/warning/note. The summary
step never fails the build: it reports, and the Security tab plus branch
protection decide what blocks a merge. If the summary step is missing from a
run, the analysis itself failed before producing SARIF — fix that first.

## Dynamic analysis (DAST)

The `DAST` workflow runs an OWASP ZAP baseline scan weekly and on manual
dispatch.

### Configuring the target

Set the repository variable `DAST_TARGET_URL` (Settings → Secrets and variables
→ Actions → Variables) to a disposable or staging deployment URL. Until it is
set, the scheduled run skips cleanly and records why in the run summary rather
than failing every week.

A manual dispatch can override the target with the `target_url` input.

The target is validated before ZAP starts, and the run fails if the URL:

- is not HTTPS;
- embeds credentials (`a URL with embedded credentials`);
- resolves to a production hostname (`eidolon.verticallabs.ai` or its `www`
  form), compared case-insensitively and after normalizing a trailing dot and an
  explicit port, so `HTTPS://Eidolon.VerticalLabs.ai.:443/` is refused too.

Refusing production is the point of the check: a baseline scan sends live
traffic, and a passive scan against production is still unauthorized activity
against real user data.

### Reading the report

Every run, including a failing one, uploads a `zap-report` artifact (HTML,
Markdown, and JSON, retained 30 days). Read the HTML for triage and the JSON if
you want to diff findings between runs.

The workflow does not open issues automatically. Findings stay attached to the
run so a maintainer triages them with the deployment context that produced them.
Address findings before promoting to production.

## Subject access and erasure requests

Access and deletion requests are served by owner-only endpoints. The full
policy, including what is deleted, nulled, and pseudonymised, lives in
[`docs/security/data-handling.md`](../security/data-handling.md).

Operationally:

1. Verify the request out of band. The endpoints assume the requester's identity
   is already confirmed.
2. Export first: `GET /api/companies/{companyId}/privacy/subjects/{userId}/export`.
   Deliver it over a channel appropriate for personal data; it is never cached.
3. Erase: `POST /api/companies/{companyId}/privacy/subjects/{userId}/erase` with
   `{"confirmSubject": "<userId>"}`. Include `email` when the subject has a
   pending invitation, which has no user id to match on.
4. Check `remainingReferences` in the response. Anything other than `0` means the
   erasure was incomplete — escalate instead of closing the request.
5. Delete the identity in Clerk. This database holds the user id and authored
   content; the profile itself lives in Clerk, so the request is not complete
   until both are done.

Erasure is irreversible and pseudonyms cannot be resolved back to a user id.
Run the export before the erasure, not after.
