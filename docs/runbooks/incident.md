# Incident response

## Triage

1. Check the deployment commit, then `GET /api/ready` before `GET /api/health`.
   Readiness returns `503` with the failing dependency named; liveness returns
   `200` even when Postgres is unreachable, so it cannot distinguish "up" from
   "usable". See [reliability controls](reliability.md).
2. If an external dependency is suspected, check which circuits are open:
   `curl -H "Authorization: Bearer $METRICS_TOKEN" <host>/api/metrics | grep
eidolon_provider_circuits_open`.
3. Check Vercel function logs and the server's structured logs for the affected
   route, company, agent, or runtime session. Readiness and liveness probes are
   excluded from request logs, so they will not appear there.
4. Redact authorization headers, API keys, cookies, prompt contents, and
   personal data before copying evidence.
5. Identify whether the issue is availability, data integrity, auth/security,
   provider/runtime execution, or a migration problem.

## Containment

- Roll back the deployment when the regression is isolated to the release.
- Disable the affected provider, runtime adapter, or scheduled routine through
  its operator configuration when that limits impact.
- Revoke exposed credentials immediately and record only the credential class
  and rotation time.

## Recovery and follow-up

Restore service, verify `GET /api/ready` returns `200` and a representative
authenticated API flow succeeds, then document the root cause, timeline,
affected data, corrective change, and a regression test in the linked issue.
