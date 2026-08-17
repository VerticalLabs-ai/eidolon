# Alerting runbook

This runbook defines every Eidolon alert: what it means, how to investigate,
what action to take, and how to acknowledge and resolve it. It covers the
Prometheus alert rules in
[`monitoring/alert-rules.yml`](../../monitoring/alert-rules.yml) and the
existing Sentry alert rules routed to GitHub issues.

For the metrics pipeline, scraping configuration, and dashboard guidance, see
[Observability](observability.md). For incident escalation, see
[Incident response](incident.md).

## Alert routing and severity

| Source     | Mechanism                                           | Destination                            |
| ---------- | --------------------------------------------------- | -------------------------------------- |
| Prometheus | Alert rules in `monitoring/alert-rules.yml`         | Alertmanager / on-call                 |
| Sentry     | Sentry project alert rules (error volume, HTTP 5xx) | GitHub issue via `repository_dispatch` |

Prometheus alerts carry a `severity` label:

- **critical** — user-facing impact or imminent outage. Page the on-call and
  start investigation immediately.
- **warning** — degraded but not yet user-facing. Investigate during business
  hours and watch for escalation to critical.

Sentry alerts create a deduplicated GitHub issue labelled `sentry` and
`type/bug`. They do not page directly; triage them from the issue tracker.

## Acknowledging and resolving an alert

1. **Silence** — in Alertmanager, silence the alert to stop repeat
   notifications while you investigate. For Sentry-derived GitHub issues,
   assign the issue to yourself and add a comment noting you are
   investigating.
2. **Investigate** — follow the per-alert procedure below.
3. **Act** — apply the fix or mitigation.
4. **Verify** — confirm the alert has cleared in Prometheus/Alertmanager or
   that the Sentry issue is resolved.
5. **Resolve** — close the GitHub issue or remove the Alertmanager silence
   once the underlying cause is fixed. Record the root cause, timeline, and
   corrective change in the linked issue per [Incident response](incident.md).

---

## Prometheus alerts

### HighErrorRate

**Severity:** critical

**What it means:** More than 5% of HTTP responses returned a 5xx status code
over the last 5 minutes. The server is failing a meaningful fraction of
requests.

**Expression:**

```promql
(
  sum(rate(eidolon_http_requests_total{status_code=~"5.."}[5m]))
    /
  clamp_min(sum(rate(eidolon_http_requests_total[5m])), 1)
) > 0.05
```

**How to investigate:**

1. Open Sentry (when `SENTRY_DSN` is configured) and look for a spike in
   server errors around the alert time.
2. In Prometheus or Grafana, break the error rate down by `route` and
   `method` on `eidolon_http_requests_total{status_code=~"5.."}` to identify
   the failing endpoint(s).
3. Pull the server structured logs (Pino JSON) for the affected time window
   and filter on `level=error` and the failing routes. Use `X-Request-ID` and
   `X-Trace-ID` to correlate individual failures.
4. Check whether a deployment preceded the spike — review the Vercel
   dashboard and the commit promoted to `main`.

**Action to take:**

- If a specific route is failing, check the corresponding handler and its
  dependencies (database, provider, runtime).
- If a recent deployment caused the regression, roll back using the
  [rollback runbook](deployment.md#rollback) and re-run deploy verification.
- If an external dependency is failing, check
  `eidolon_provider_circuits_open` — a related `CircuitBreakerOpen` alert may
  be firing.
- File a fix and add a regression test before re-deploying.

### HighLatencyP99

**Severity:** warning

**What it means:** The 99th-percentile HTTP request latency has exceeded 2.5
seconds for 10 minutes. A small fraction of users are experiencing slow
responses.

**Expression:**

```promql
histogram_quantile(
  0.99,
  sum by (le) (rate(eidolon_http_request_duration_seconds_bucket[5m]))
) > 2.5
```

**How to investigate:**

1. In Grafana, break p99 latency down by `route` to find the slow endpoint(s).
2. Check database performance — look for slow queries, lock contention, or
   connection pool exhaustion in the Postgres logs and the server structured
   logs.
3. Check LLM provider response times — a provider latency spike will surface
   in the agent execution logs.
4. Check for a recent deployment that may have introduced a performance
   regression.

**Action to take:**

- If the database is the bottleneck, check connection pool settings and
  investigate slow queries. Consider scaling the database.
- If a provider is slow, the circuit breaker may open (see
  `CircuitBreakerOpen`); verify the provider status page.
- If a code regression, roll back and file a performance fix with a
  regression test.
- This is a warning; if p99 climbs sharply or error rate rises, escalate per
  [Incident response](incident.md).

### DatabaseUnavailable

**Severity:** critical

**What it means:** The `/api/ready` endpoint has been failing for 2 minutes.
The server process is likely up but a required dependency (Postgres) is
unreachable, so the server cannot serve traffic.

**Expression:**

```promql
probe_success{job="eidolon-ready"} == 0
```

This rule requires a blackbox exporter scrape job probing
`https://eidolon.verticallabs.ai/api/ready`. Add this to your Prometheus
configuration:

```yaml
scrape_configs:
  - job_name: eidolon-ready
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
          - https://eidolon.verticallabs.ai/api/ready
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: target
      - target_label: __address__
        replacement: blackbox-exporter:9115
```

**How to investigate:**

1. Probe the endpoint directly:
   `curl -i https://eidolon.verticallabs.ai/api/ready`. A `503` response
   names the failing dependency in the JSON body (`checks[].name`).
2. Confirm the database is reachable from the server: check the Vercel
   function logs for Postgres connection errors.
3. Check the Postgres instance (Supabase dashboard or self-hosted) for
   outages, high load, or disk pressure.
4. Verify `GET /api/health` returns `200` — if it also fails, the process
   itself is down, not just the database.

**Action to take:**

- If Postgres is down, follow the Supabase status page and incident
  procedure. Restart or fail over the database as needed.
- If the database is up but the server cannot connect, check the
  `DATABASE_URL` and network configuration in the deployment environment.
- If the issue persists, roll back to a known-good deployment.
- Once `/api/ready` returns `200`, confirm a representative authenticated API
  request succeeds before closing the alert.

### CircuitBreakerOpen

**Severity:** warning

**What it means:** One or more outbound dependency circuit breakers have been
open for 5 minutes. A downstream dependency (LLM provider, MCP server, or
remote runtime) is failing its probe requests and the circuit has not reset.

**Expression:**

```promql
eidolon_provider_circuits_open > 0
```

**How to investigate:**

1. Check the `kind` label on `eidolon_provider_circuits_open` to identify the
   dependency type:
   - `llm_provider` — an LLM completion provider (e.g. OpenAI, Anthropic).
   - `mcp` — a tenant-registered MCP server.
   - `remote_runtime` — a remote runtime adapter.
2. For `llm_provider`, check the provider status page and the server logs for
   provider error responses.
3. For `mcp`, note that the circuit is keyed per tenant server. A non-zero
   `mcp` count with healthy LLM providers points at a customer-configured
   server, not Eidolon core.
4. A circuit clears on the first successful call, so a circuit that stays
   open means the dependency is still failing.

**Action to take:**

- For an LLM provider: verify API keys and the provider status page. If the
  provider is down, wait for recovery; the circuit will close automatically
  on the first successful call.
- For an MCP server: contact the tenant or disable the server in the operator
  configuration if it is causing impact.
- For a remote runtime: check the runtime adapter configuration and the
  remote endpoint health.
- If a configuration change caused the failures, revert it.

### MemoryPressure

**Severity:** warning

**What it means:** The Node.js heap utilization has exceeded 85% for 10
minutes, indicating a likely memory leak or unbounded in-memory retention.

**Expression:**

```promql
(
  nodejs_heap_size_used_bytes
    /
  clamp_min(nodejs_heap_size_total_bytes, 1)
) > 0.85
```

**How to investigate:**

1. Check `GET /api/health` — the `memory.rss` and `memory.heapUsed` fields
   report current usage in MB.
2. In Grafana, plot `nodejs_heap_size_used_bytes` and
   `nodejs_heap_size_total_bytes` over time to see if usage is monotonically
   increasing (leak) or plateauing (high steady-state).
3. Review recent deployments for changes that might retain references
   (caches, in-memory queues, event listeners).
4. Capture a heap snapshot if the issue persists — see the
   [profiling section](reliability.md#profiling) for CPU profiling; heap
   snapshots can be taken via `node --inspect`.

**Action to take:**

- If usage is climbing steadily, restart the server process to restore
  capacity while investigating (Vercel will redeploy automatically).
- Identify and fix the leak. Add a regression test that bounds the retained
  object count.
- If usage is stable but high, consider raising the memory limit or reducing
  in-memory retention.
- Escalate to critical if the process starts OOM-ing (the `up` metric flips
  to `0`).

---

## Sentry alerts

Sentry alerts are configured in the Sentry project UI (not in this
repository) and routed to GitHub issues via the
`Sentry alert to issue` workflow (`.github/workflows/sentry-issue.yml`). When
a Sentry alert fires, it sends a `repository_dispatch` event to the workflow,
which calls `scripts/sentry-dispatch.mjs` to create a deduplicated GitHub
issue labelled `sentry` and `type/bug`. The issue body contains only the
Sentry short ID and a link — never raw event payloads, stack traces, or
customer data.

The two Sentry alert rules currently in use:

### Error volume

**What it means:** The number of new (unresolved) errors in the Sentry server
project crosses a configured threshold within a rolling window. This catches
sudden bursts of new error types, not just volume on a known issue.

**How it is configured:** In the Sentry project UI under **Alerts**, create an
alert rule of type "Issue Alert" triggered by "The number of new issues is
greater than N in time window T" (e.g. more than 10 new issues in 1 hour).
Set the action to send a notification to the GitHub integration via the
Sentry webhook, which triggers the `repository_dispatch` event.

**How to investigate:**

1. Open the GitHub issue created by the workflow. It links to the Sentry
   issue.
2. In Sentry, review the new issues grouped by error type and affected route.
3. Correlate with a recent deployment if the burst started after a release.
4. Use the [HighErrorRate](#higherrorrate) Prometheus alert (if firing) to
   gauge user-facing impact.

**Action to take:**

- Triage each new error in Sentry. Link related errors to a single fix.
- If a deployment caused the burst, roll back and file a fix.
- Resolve the Sentry issues once the underlying errors stop occurring.
- Close the GitHub issue once all linked Sentry issues are resolved.

### HTTP 5xx rate

**What it means:** The rate of HTTP 5xx responses captured by Sentry
(through the server's `@sentry/node` integration) crosses a configured
threshold. This is the Sentry-side counterpart to the Prometheus
`HighErrorRate` alert and catches 5xx errors even when Prometheus scraping
is not configured.

**How it is configured:** In the Sentry project UI under **Alerts**, create an
alert rule of type "Issue Alert" triggered by "The event level rate is
greater than N events per minute for the `http.status_code` tag matching
`5xx`". Set the action to send a notification to the GitHub integration.

**How to investigate:**

1. Open the GitHub issue created by the workflow.
2. In Sentry, filter events by `http.status_code` in the `5xx` range and
   review the affected routes and request IDs.
3. Cross-reference with the server structured logs using the `X-Request-ID`
   attached to each Sentry event.
4. Check the Prometheus `HighErrorRate` alert — if both are firing, the
   impact is confirmed user-facing.

**Action to take:**

- Follow the same procedure as [HighErrorRate](#higherrorrate).
- Resolve the Sentry issue once the 5xx rate returns to baseline.
- Close the GitHub issue created by the workflow.

## Budget alerts

The existing infrastructure includes budget alerts for LLM provider spend.
These are configured at the provider level (e.g. Anthropic/OpenAI spend
notifications) and are outside the scope of this runbook. When a budget alert
fires, review the provider dashboard and adjust spend limits or rate limits
as needed.
