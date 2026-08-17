# Observability

## UI structured logging

The UI application uses the structured logger in `ui/src/lib/logger.ts` instead
of direct `console.log`/`console.error` calls. It supports four levels:
`error`, `warn`, `info`, and `debug`.

- In production builds (`import.meta.env.PROD`), the logger emits
  newline-delimited JSON with `level`, `message`, `timestamp`, and any optional
  context fields. These logs are captured by the hosting platform's log drain
  (e.g., Vercel) and can be aggregated by Loki, CloudWatch, or a similar sink.
- In development, the logger prints a human-readable line to the console method
  that matches the level (`console.error`, `console.warn`, `console.info`,
  `console.debug`).

Application code should import the default `logger` singleton and pass
structured context as the second argument:

```ts
import { logger } from '@/lib/logger';

logger.info('Company created', { companyId });
logger.error('Import failed', { error: err.message });
```

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

The server and UI each have independent, optional Sentry integrations. Both
mirror the same pattern: the SDK initializes **only** when a DSN is set, and
no personal data is ever attached to events.

### Server Sentry

1. Create a Sentry project for the server and copy its DSN into the deployment
   environment as `SENTRY_DSN`.
2. Set `SENTRY_ENVIRONMENT=production` and choose a low
   `SENTRY_TRACES_SAMPLE_RATE` such as `0.05` if performance tracing is
   enabled.
3. The server's error tracking is initialized in
   `server/src/utils/error-tracking.ts` (`initializeErrorTracking`).
   Unexpected errors are captured with request ID, trace ID, route, method,
   and authenticated user ID context. Credentials, prompts, transcripts, and
   provider responses are never attached.

### UI Sentry

The UI initializes `@sentry/react` in `ui/src/lib/error-tracking.ts`
(`initializeErrorTracking`), called from `ui/src/main.tsx` before React
renders so render-time exceptions are captured.

1. Create a separate Sentry project for the UI (recommended) or reuse the
   server project, and copy its DSN into the build environment as
   `VITE_SENTRY_DSN`. Error tracking stays disabled when this is unset —
   there is no behavior change.
2. Optionally set `VITE_SENTRY_ENVIRONMENT=production` and
   `VITE_SENTRY_TRACES_SAMPLE_RATE` (0 to 1, defaults to `0`).
3. The release is taken from `VITE_APP_VERSION`, which the release workflow
   sets to the CalVer tag at build time.
4. `sendDefaultPii` is `false`. User IDs, emails, prompts, transcripts, and
   credentials are never attached to UI Sentry events. Use `captureUIError`
   and pass only non-identifying context (e.g. `route` tags).

### Source map upload

1. Add the GitHub Actions secret `SENTRY_AUTH_TOKEN` with release and project
   artifact upload permissions.
2. Add repository variables `SENTRY_ORG` and `SENTRY_PROJECT` (the server
   project). Optionally add `SENTRY_UI_PROJECT` to send UI source maps to a
   separate project; when unset, UI source maps are uploaded to
   `SENTRY_PROJECT`.
3. The CalVer release workflow (`.github/workflows/release.yml`) builds the
   server and UI, then uses `getsentry/action-release@v3` to create and
   finalize a Sentry release and upload source maps from `server/dist` and
   `ui/dist`. If `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, or `SENTRY_PROJECT` is
   absent, the upload job is skipped without failing the release.

The repository exposes Prometheus metrics at `GET /api/metrics` (see
[Metrics collection](#metrics-collection) below). Treat repeated health
failures, elevated 5xx rates, or stuck runtime sessions as escalation
triggers and follow the [incident runbook](incident.md).

## Profiling

Build the server, start the representative workload, and run
`pnpm --filter @eidolon/server profile`. Node writes a CPU profile under
`server/profiles/`; inspect it with Chrome DevTools or another compatible
profile viewer. Stop the process normally before collecting the profile and
remove sensitive request data from any shared analysis.

## Metrics collection

The server exposes a Prometheus-format metrics endpoint at `GET /api/metrics`.
The endpoint is token-gated: it returns `404 Not Found` unless a valid bearer
token is supplied, and it returns `404` when `METRICS_TOKEN` is not configured
at all (no auth bypass).

### Available metrics

| Metric                                  | Type      | Labels                     | Description                              |
| --------------------------------------- | --------- | -------------------------- | ---------------------------------------- |
| `eidolon_http_requests_total`           | Counter   | method, route, status_code | Total HTTP requests handled              |
| `eidolon_http_request_duration_seconds` | Histogram | method, route, status_code | Request latency in seconds               |
| `eidolon_provider_circuits_open`        | Gauge     | kind                       | Open circuit breakers by dependency kind |
| `eidolon_companies_active`              | Gauge     | —                          | Companies with `status = 'active'`       |
| `eidolon_agents_by_status`              | Gauge     | status                     | Agent count grouped by status            |
| `eidolon_tasks_by_status`               | Gauge     | status                     | Task count grouped by status             |

Default process metrics (`process_cpu_seconds_total`, `nodejs_memory_*`,
etc.) are also collected via `prom-client`'s `collectDefaultMetrics`.

### Configuring the metrics token

1. Generate a strong random token:

   ```bash
   openssl rand -hex 32
   ```

2. Set `METRICS_TOKEN` in the deployment environment (Vercel project
   settings, `.env` for self-hosted). The endpoint returns `404` for all
   callers when this variable is empty or unset.

3. Verify the endpoint returns metrics:

   ```bash
   curl -sf \
     -H "Authorization: Bearer $METRICS_TOKEN" \
     https://eidolon.verticallabs.ai/api/metrics
   ```

   A `404` response means the token is missing, unset, or incorrect — the
   endpoint never reveals whether the token is wrong vs. unconfigured.

### Scraping with Prometheus

Add a scrape job to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: eidolon
    scrape_interval: 15s
    scrape_timeout: 10s
    metrics_path: /api/metrics
    scheme: https
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets:
          - eidolon.verticallabs.ai
```

For local development against the launchd-managed server on `:3100`:

```yaml
scrape_configs:
  - job_name: eidolon-local
    scrape_interval: 15s
    metrics_path: /api/metrics
    scheme: http
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets:
          - localhost:3100
```

Reload Prometheus (`POST /-/reload` or restart) and confirm the target is
up in the Prometheus UI under **Status → Targets**.

### Visualizing in Grafana

1. Add Prometheus as a data source in Grafana
   (**Connections → Data sources → Add data source → Prometheus**).
   Point the URL at your Prometheus instance.
2. Create a dashboard with panels for key metrics:

   **Request rate** (QPS):

   ```promql
   rate(eidolon_http_requests_total[5m])
   ```

   **Error rate** (5xx percentage):

   ```promql
   sum(rate(eidolon_http_requests_total{status_code=~"5.."}[5m]))
     / sum(rate(eidolon_http_requests_total[5m])) * 100
   ```

   **P99 latency**:

   ```promql
   histogram_quantile(0.99,
     rate(eidolon_http_request_duration_seconds_bucket[5m]))
   ```

   **Open circuit breakers**:

   ```promql
   eidolon_provider_circuits_open
   ```

   **Active companies**:

   ```promql
   eidolon_companies_active
   ```

   **Agents by status**:

   ```promql
   eidolon_agents_by_status
   ```

   **Task completion rate** (done vs. total non-cancelled):

   ```promql
   eidolon_tasks_by_status{status="done"}
     / (eidolon_tasks_by_status{status="done"}
        + eidolon_tasks_by_status{status="in_progress"}
        + eidolon_tasks_by_status{status="review"}
        + eidolon_tasks_by_status{status="todo"}
        + eidolon_tasks_by_status{status="backlog"}) * 100
   ```

3. Set up alert panels or Grafana alerting rules based on the Prometheus
   queries above.

## Schema ownership

The server is the sole owner of the database schema. The UI, desktop, and
MCP server applications do not define or migrate schemas; they access data
through the server's REST and WebSocket APIs. See
[Database schema ownership](../architecture/schema-ownership.md) for the
full ownership model, migration workflow, and schema management tools.

## Distributed tracing

The server optionally initializes the OpenTelemetry SDK to export
distributed traces via the OTLP protocol. Tracing is **opt-in** and has
**no behavior change** when unconfigured — the SDK is not started, no
exporters are created, and no instrumentations are registered.

### Configuration

| Variable                              | Description                             | Default                           |
| ------------------------------------- | --------------------------------------- | --------------------------------- |
| `EIDOLON_OTEL_ENABLED`                | Set to `1` or `true` to enable the SDK. | unset (disabled)                  |
| `EIDOLON_OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP trace exporter endpoint URL.       | `http://localhost:4318/v1/traces` |

### Setup

1. Deploy an OTLP-compatible trace collector (e.g., Jaeger, Grafana Tempo,
   Honeycomb, or the OpenTelemetry Collector) and note its OTLP/HTTP
   endpoint.

2. Set the environment variables in your deployment:

   ```
   EIDOLON_OTEL_ENABLED=1
   EIDOLON_OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector:4318/v1/traces
   ```

3. Restart the server. The SDK initializes during module loading, before
   Express, HTTP, and Postgres modules are imported, so auto-instrumentations
   can patch them at load time.

4. Verify traces appear in your tracing backend. The server emits spans for
   inbound HTTP requests, Express route handling, and Postgres queries
   automatically via `@opentelemetry/auto-instrumentations-node`.

### How it works

- `server/src/utils/tracing.ts` initializes the `NodeSDK` from
  `@opentelemetry/sdk-node` with `getNodeAutoInstrumentations()` when
  `EIDOLON_OTEL_ENABLED` is set.
- The module is imported as the first import in `server/src/bootstrap.ts`
  (and after `./env.js` in `server/src/index.ts`) so the SDK starts before
  instrumented modules load.
- The OTLP exporter sends traces to the configured endpoint via HTTP.
- Filesystem and DNS instrumentations are disabled to reduce noise.
- The SDK gracefully shuts down on `SIGTERM`/`SIGINT` to flush pending spans.

### W3C traceparent propagation

The observability middleware independently implements W3C traceparent
parsing and propagation (see `server/src/middleware/observability.ts`).
It parses incoming `traceparent` headers, generates `X-Request-ID` and
`X-Trace-ID` response headers, and propagates the trace context. This
behavior is present regardless of whether the OpenTelemetry SDK is
enabled — the middleware does not depend on OTel.

## Code quality CI gate

The `.github/workflows/quality-gate.yml` workflow runs on every pull
request and on pushes to `main` and `staging`. It enforces coverage
thresholds and publishes a code quality metrics summary to the GitHub
Actions run page.

### What the gate checks

1. **Coverage thresholds** — `pnpm test:coverage` runs the full test
   suite with V8 coverage. Vitest enforces the thresholds configured in
   `vitest.config.ts` (`coverage.thresholds`). If any metric (lines,
   statements, functions, branches) falls below its threshold, vitest
   exits non-zero and the workflow fails.
2. **Duplication** — `pnpm duplication` runs jscpd to detect duplicated
   code. The threshold is configured in `.jscpd.json`.
3. **Dead code** — `pnpm dead-code` runs knip to detect unused exports,
   dependencies, and files.

### Current thresholds

| Metric     | Threshold |
| ---------- | --------- |
| Lines      | 40%       |
| Statements | 40%       |
| Functions  | 50%       |
| Branches   | 40%       |

These are set slightly below the desktop package's coverage levels to
gate against regressions without blocking the existing server and
packages test suite. Raise thresholds as coverage improves.

### Metrics summary

After the gate runs, `scripts/quality-metrics-summary.mjs` writes a
Markdown table to `$GITHUB_STEP_SUMMARY` with:

- Coverage percentages (lines, statements, functions, branches) from
  `coverage/coverage-summary.json`.
- Test counts (passed, failed, skipped) parsed from the vitest output.
- Duplication percentage from the jscpd output.
- Dead-code analysis output from knip.

The summary appears on the Actions run page under the job's summary
section. A coverage report artifact (`coverage-report-<run-id>`) is also
uploaded for detailed inspection.

### Local usage

Run the same commands locally to check before pushing:

```bash
pnpm test:coverage   # enforces thresholds, writes coverage/
pnpm duplication     # checks duplicated code
pnpm dead-code       # checks unused exports and dependencies
```

To preview the metrics summary without CI:

```bash
node scripts/quality-metrics-summary.mjs \
  coverage/coverage-summary.json
```
