# Observability

## Deployment checks

- Vercel project dashboard: https://vercel.com/verticallabs/eidolon
- Confirm the deployment commit matches the release tag.
- Review function logs for elevated 5xx responses, auth failures, database
  connection errors, and runtime adapter failures.
- Verify `GET /api/health` and one representative authenticated API request.

## Local diagnostics

The server emits structured JSON logs through Pino. Use the request method,
route, status code, company ID, agent ID, task ID, and session ID to correlate
events. Do not log or copy credentials, cookies, full prompts, transcripts, or
provider responses into incident records.

When `SENTRY_DSN` is configured, unexpected server errors are sent to Sentry
with request ID, trace ID, route, method, and authenticated user ID context.
Personal data, credentials, prompts, and provider responses are not attached.
Sentry is disabled when the DSN is unset. Set `SENTRY_RELEASE` explicitly for
self-hosted deployments; Vercel's commit SHA is used automatically when
available.

## Sentry-to-issue routing

The `Sentry alert to issue` workflow accepts a `repository_dispatch` event of
type `sentry-alert`. A Sentry webhook or integration should send a
`client_payload` containing an `issue` object with `shortId`, `title`, and
`web_url`. The workflow deduplicates open GitHub issues by Sentry ID, creates a
`sentry` label when needed, and never copies raw event payloads into the issue.

## Sentry deployment setup

1. Create a Sentry project for the server and copy its DSN into the deployment
   environment as `SENTRY_DSN`.
2. Set `SENTRY_ENVIRONMENT=production` and choose a low
   `SENTRY_TRACES_SAMPLE_RATE` such as `0.05` if performance tracing is
   enabled.
3. Add the GitHub Actions secret `SENTRY_AUTH_TOKEN` with release and project
   artifact upload permissions.
4. Add repository variables `SENTRY_ORG` and `SENTRY_PROJECT`.
5. The CalVer release workflow uploads `server/dist` and `ui/dist` source maps
   and finalizes the matching release. If the three GitHub settings are absent,
   the upload step is skipped without failing the release.

The repository does not currently provide hosted metrics dashboards or
automated alert delivery. Treat repeated health failures, elevated 5xx rates,
or stuck runtime sessions as escalation triggers and follow the [incident
runbook](incident.md).

## Profiling

Build the server, start the representative workload, and run
`pnpm --filter @eidolon/server profile`. Node writes a CPU profile under
`server/profiles/`; inspect it with Chrome DevTools or another compatible
profile viewer. Stop the process normally before collecting the profile and
remove sensitive request data from any shared analysis.

## Schema ownership

The server is the sole owner of the database schema. The UI, desktop, and
MCP server applications do not define or migrate schemas; they access data
through the server's REST and WebSocket APIs. See
[Database schema ownership](../architecture/schema-ownership.md) for the
full ownership model, migration workflow, and schema management tools.
