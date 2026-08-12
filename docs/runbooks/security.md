# Security and DAST

## Dynamic application security testing

The `DAST` GitHub Actions workflow runs an OWASP ZAP baseline scan when
manually dispatched. It requires an HTTPS URL for a disposable or staging
deployment and rejects `https://eidolon.verticallabs.ai` so production cannot
be scanned accidentally.

To run it:

1. Deploy the branch to a disposable or staging environment.
2. Open **Actions → DAST → Run workflow**.
3. Enter the deployment URL in `target_url`.
4. Review the ZAP report and address findings before promotion.

The workflow does not create GitHub issues automatically. Findings remain
attached to the workflow run so the maintainer can triage them with the
appropriate context.
