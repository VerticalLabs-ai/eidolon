# Reliability controls

## Health and readiness by deployable

The repository ships four applications. Each needs either a service check or a
written reason it cannot have one.

| Application                           | Check                                 | Notes                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server` (also the Vercel deployment) | `GET /api/health`, `GET /api/ready`   | Vercel routes every `/api/*` request into this same Express app through `api/index.js`, so the web deployment is covered by these two routes.                                                                           |
| `ui`                                  | None by design                        | A static asset bundle served by the CDN. It has no runtime of its own to probe; a failed deploy shows up as a missing or stale asset, and the API it calls is covered by `/api/ready`.                                  |
| `packages/desktop`                    | Companion probe against `/api/health` | The Electron shell has no inbound socket. It polls the local runtime companion URL (`EIDOLON_DESKTOP_LOCAL_API_HEALTH_URL`, default `http://localhost:3100/api/health`) to decide whether a local runtime is available. |
| `packages/mcp-server`                 | None by design                        | A stdio MCP client launched per session by the calling agent. There is no long-lived listener to check; a broken launch fails the session immediately and visibly.                                                      |

### Which route to use

`GET /api/health` is **liveness**. It answers "this process is running" and
returns `200` even when Postgres is unreachable. Do not point a load balancer at
it: it will happily keep a useless instance in rotation. It stays the desktop
companion's probe because that is exactly the question the companion asks.

`GET /api/ready` is **readiness**. It probes every required dependency and
returns `503` when any is unavailable:

```json
{
  "status": "degraded",
  "timestamp": "2026-08-16T21:00:00.000Z",
  "checks": [{ "name": "database", "ok": false, "durationMs": 2000 }]
}
```

Both routes are unauthenticated, so probe failures are reported as `ok: false`
and never carry the driver error text — a Postgres error string contains the
host, port, and role. When a probe fails, read the reason from the structured
server logs, not from the response.

Each probe is capped at two seconds so readiness answers quickly even when the
dependency accepts the connection and then stalls.

## Circuit breakers

Outbound dependencies are guarded so a hard-down endpoint stops costing every
request its full timeout.

| Call path                                                   | Circuit key                         |
| ----------------------------------------------------------- | ----------------------------------- |
| LLM completions (`agentic-loop`, `agent-executor`)          | Provider name, for example `openai` |
| MCP server connect (`MCPClientService.connect`)             | `mcp:<digest of server id>`         |
| Remote runtime adapters (`http:remote`, `openclaw:webhook`) | `remote_runtime:<digest of origin>` |

Configuration:

| Variable                                     | Default | Description                                    |
| -------------------------------------------- | ------- | ---------------------------------------------- |
| `EIDOLON_PROVIDER_CIRCUIT_FAILURE_THRESHOLD` | `5`     | Consecutive failures before the circuit opens. |
| `EIDOLON_PROVIDER_CIRCUIT_RESET_MS`          | `30000` | Milliseconds before a probe is allowed.        |

MCP and remote-runtime circuits are keyed per endpoint so one company's dead
server cannot suppress another's. The key is a digest rather than the address
itself, because a tenant hostname is customer configuration and must not appear
in telemetry.

To see which circuits are open:

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://<host>/api/metrics \
  | grep eidolon_provider_circuits_open
```

The gauge is labelled by kind (`llm_provider`, `mcp`, `remote_runtime`) rather
than by circuit, so the label set cannot grow with the number of tenant-
registered endpoints. A non-zero `mcp` count with healthy LLM providers points
at a customer-configured server, not at Eidolon.

A circuit clears on the first successful call, so an open circuit that stays
open means the dependency is still failing.

## Query budgets

Database-backed list flows are protected against N+1 regressions by
`server/src/__tests__/query-budgets.test.ts`. Each guard runs the same request
twice with a different number of rows and requires an identical query count, so
a query added per row fails the test.

Guarded flows: company task list, company artifact list, unified inbox feed, and
the composed project home summary.

Use `assertQueryCountIndependentOfRows` from `server/src/test-utils.ts` when
adding a list-returning route:

```ts
await assertQueryCountIndependentOfRows({
  queries, // a QueryCounter passed to the FIRST createTestDb() in the file
  label: 'GET /api/companies/:companyId/things',
  read: () => request(app).get(url).expect(200),
  seed: () => createMoreThings(6),
});
```

Do not replace this with an absolute `assertAtMost` budget on a route. An
absolute budget has to be widened whenever an unrelated query moves, and a
budget that keeps getting widened stops protecting anything. The helper refuses
to run when it observes zero queries, because a counter that is not attached to
the database under test would otherwise make the guard pass for any
implementation.

## Profiling

### Server CPU profile

```bash
pnpm build
pnpm --filter @eidolon/server profile
```

Node writes a CPU profile under `server/profiles/` (git-ignored). Drive the
representative workload, stop the process normally, then open the profile in
Chrome DevTools. Remove sensitive request data before sharing any analysis.

### UI bundle profile

```bash
pnpm --filter @eidolon/ui build
pnpm profile:ui                       # table on stdout
pnpm profile:ui -- --csv ui-bundle.csv  # plus CSV for trend comparison
```

Reports raw and gzip size per asset and per kind. Gzip is measured, not
estimated, and incompressible kinds (images, fonts) are reported at their real
size instead of being re-compressed.

The scheduled **Build and test performance** workflow runs this after the build
and publishes both the step summary and a retained `ui-bundle.csv` artifact, so
a bundle regression is visible without anyone remembering to look.
