# Eidolon runbooks

Use these procedures for local development and production incidents:

- [Deployment and rollback](deployment.md)
- [Incident response](incident.md)
- [Feature flag rollout and rollback](feature-flags.md)
- [Observability](observability.md)
- [Reliability controls](reliability.md)
- [Security and DAST](security.md)

Every Markdown file in this directory must be linked above. `pnpm docs:check`
fails on an unindexed runbook, so a new procedure cannot land unreachable.

## Architecture references

- [Database schema ownership](../architecture/schema-ownership.md) — which
  applications own which schemas, the migration workflow, and schema
  management tools

## First checks during an incident

| Question                           | Where to look                                          |
| ---------------------------------- | ------------------------------------------------------ |
| Is the process up?                 | `GET /api/health`                                      |
| Can it serve traffic?              | `GET /api/ready` (`503` when a dependency is down)     |
| Is an external dependency failing? | `eidolon_provider_circuits_open` on `GET /api/metrics` |
| Which request was it?              | `X-Request-ID` and `X-Trace-ID` response headers       |

Production access, Clerk/Vercel configuration, and provider credentials are
operator-controlled. Never paste credentials, customer data, or full
provider responses into issues or chat.
