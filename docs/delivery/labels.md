# Issue label taxonomy

Eidolon plans in Linear (team `EID`) and receives external reports in GitHub
issues. Both need to mean the same thing by the same word, so one taxonomy
covers both systems.

`.github/labels.json` is the source of truth for GitHub. It is checked in so the
taxonomy can be reviewed and diffed like any other change, rather than living
only in a settings page where a rename leaves no trace.

```bash
pnpm labels:check   # report drift against GitHub, exit 1 if any (read-only)
pnpm labels:sync    # create and update GitHub labels to match the file
```

Both commands use your existing GitHub CLI login. `labels:sync` never deletes:
an unrecognised label is reported for a human to decide on, because a label may
still classify closed issues that would silently lose their meaning.

The **Issue hygiene** workflow runs `labels:check` weekly, so drift is reported
without anyone remembering to look.

## The three dimensions

Every issue should carry one `type/*`, at least one `area/*`, and a priority.
Nothing else is required.

### `type/*` — what kind of change this is

| Label              | Use when                                                             |
| ------------------ | -------------------------------------------------------------------- |
| `type/bug`         | Behaviour is wrong relative to a documented or intended contract     |
| `type/feature`     | New user- or operator-visible capability                             |
| `type/improvement` | Existing capability made better without changing its contract        |
| `type/chore`       | Maintenance with no behaviour change: dependencies, cleanup, tooling |
| `type/docs`        | Documentation, runbooks, or agent instructions                       |
| `type/security`    | Security or privacy control, hardening, or vulnerability fix         |
| `type/test`        | Test coverage, test infrastructure, or test reliability              |

`type/security` also exempts an issue from stale marking, because a security
issue going quiet is not evidence it stopped mattering.

### `area/*` — which part of the system

Areas name workspace directories, so an area maps to a place in the repository
rather than to a team or a person.

| Label                | Directory or concern                                            |
| -------------------- | --------------------------------------------------------------- |
| `area/server`        | `server/` — Express API, services, middleware                   |
| `area/ui`            | `ui/` — React web application                                   |
| `area/desktop`       | `packages/desktop` — Electron shell and local runtime companion |
| `area/mcp`           | `packages/mcp-server` and MCP client integration                |
| `area/db`            | `packages/db` — schema, Drizzle migrations, query performance   |
| `area/ci`            | GitHub Actions, lint, formatting, dead-code, release automation |
| `area/docs`          | `docs/`, `README.md`, `AGENTS.md`                               |
| `area/observability` | Health, metrics, tracing, logging, alerting, profiling          |
| `area/security`      | Authentication, authorisation, secrets, privacy, scanning       |
| `area/delivery`      | Backlog hygiene, labels, feature flags, rollout, dependencies   |

Use more than one when a change genuinely spans them. If everything gets three
areas, the dimension has stopped carrying information and the issue probably
needs splitting.

### Priority

Linear has a native priority field, so there are **no `priority/*` labels in
Linear** — a second dimension would let the two disagree. GitHub has no such
field, so it uses labels. They mean the same thing:

| GitHub label      | Linear priority | Meaning                                               |
| ----------------- | --------------- | ----------------------------------------------------- |
| `priority/urgent` | 1 Urgent        | Active harm or legal exposure. Work starts now        |
| `priority/high`   | 2 High          | Blocks a committed outcome or leaves a known gap open |
| `priority/medium` | 3 Medium        | Clear value, no deadline pressure                     |
| `priority/low`    | 4 Low           | Worth doing when convenient                           |

`priority/urgent` also exempts an issue from stale marking.

An issue at no priority is untriaged. That is a legitimate state for something
just filed and an unacceptable one for anything older than a week.

## Operational labels

These belong to automation, not to triage, so they exist only in GitHub:

| Label       | Applied by                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `stale`     | The **Issue hygiene** workflow after 60 days without activity. It labels and comments; it never closes |
| `sentry`    | The **Sentry alert to issue** workflow, alongside `type/bug`                                           |
| `pinned`    | A maintainer, to exempt an issue from stale marking                                                    |
| `duplicate` | A maintainer, when another issue already tracks the work                                               |

`sentry-issue.yml` creates `sentry` and `type/bug` if they are missing, so an
alert is never dropped because a label was deleted. Its colours and descriptions
must match `.github/labels.json` or the weekly drift check will report the label
the workflow just created.

## Issue templates

`.github/ISSUE_TEMPLATE/bug_report.yml` applies `type/bug` and
`feature_request.yml` applies `type/feature`. Area and priority are triage
decisions, so a reporter is not asked to guess them.

## Adding or changing a label

1. Edit `.github/labels.json`.
2. Run `pnpm labels:sync`.
3. Open a pull request with the file change, so the taxonomy has a review trail.

For Linear, add `type/*` at workspace scope and `area/*` scoped to the `EID`
team, matching the existing labels, and update the tables above.

## Known extra GitHub labels

The repository still carries GitHub's eight stock labels (`bug`,
`documentation`, `enhancement`, `good first issue`, `help wanted`, `invalid`,
`question`, `wontfix`). None is applied to any issue or pull request, and
`bug`/`enhancement`/`documentation` duplicate `type/bug`, `type/feature`, and
`type/docs`. `labels:check` reports them without failing. A maintainer can remove
one with:

```bash
gh api -X DELETE "repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/labels/bug"
```

This is left to a human because deleting a label is not reversible from the file
alone: the label's history on any issue that used it goes with it.
