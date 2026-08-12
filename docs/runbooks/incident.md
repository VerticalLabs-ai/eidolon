# Incident response

## Triage

1. Check the deployment commit and `GET /api/health`.
2. Check Vercel function logs and the server's structured logs for the affected
   route, company, agent, or runtime session.
3. Redact authorization headers, API keys, cookies, prompt contents, and
   personal data before copying evidence.
4. Identify whether the issue is availability, data integrity, auth/security,
   provider/runtime execution, or a migration problem.

## Containment

- Roll back the deployment when the regression is isolated to the release.
- Disable the affected provider, runtime adapter, or scheduled routine through
  its operator configuration when that limits impact.
- Revoke exposed credentials immediately and record only the credential class
  and rotation time.

## Recovery and follow-up

Restore service, verify `/api/health` and a representative authenticated API
flow, then document the root cause, timeline, affected data, corrective
change, and a regression test in the linked issue.
