# Backlog health policy

Planning happens in the Linear `EID` team. A backlog is healthy when you can
trust what it says: every open issue is classified, ordered, and honest about its
own state.

```bash
pnpm backlog:health            # check every rule below, exit 1 on violation
pnpm backlog:health -- --warn  # report only
```

The check needs `LINEAR_API_KEY`. Without it, it skips cleanly rather than
failing, so it can sit in a pipeline that has no Linear credential.

## Ready

An open issue is ready to be picked up when it has all of:

- **One `type/*` label** and **at least one `area/*` label**, from the taxonomy in
  [labels.md](labels.md). Exactly one type: an issue that is both a bug and a
  feature is two issues.
- **A priority.** No priority means untriaged. That is fine for something filed
  this morning and not fine for anything older than a week.
- **A project**, so it appears in roadmap views instead of only in search.
- **Acceptance criteria that can be checked by someone who did not write the
  issue.** "Improve error handling" is a wish. "A failed provider call returns
  502 and increments `eidolon_provider_errors_total`" is a criterion.
- **Evidence for its claims.** An issue asserting something is missing should
  name the file, endpoint, or workflow it checked, and the commit it checked
  against. Claims decay: the readiness audit that produced `EID-69`–`EID-121`
  described work that had since been partly delivered, so its descriptions
  actively misled until they were re-audited against `main@7060bee`.

## Priority

| Priority | Meaning                                                     |
| -------- | ----------------------------------------------------------- |
| 1 Urgent | Active harm or legal exposure. Work starts now              |
| 2 High   | Blocks a committed outcome, or a required control is absent |
| 3 Medium | Clear value, no deadline pressure                           |
| 4 Low    | Worth doing when convenient, or blocked and cheap           |

Priority is a claim about order, so a flat distribution is the same as no
priority at all. Before this policy, 48 of 76 open issues sat at the default 2
because a bulk import never revisited them.

When a batch of issues arrives with a uniform default, derive priority from
evidence rather than feel. For the readiness audit children that meant: start
from the category's risk (security and reliability at 2, testing and code
quality at 3, developer experience at 4), then drop one step when the audit's
own score showed the signal was already three-quarters satisfied, because the
remaining work no longer matches the remaining exposure.

## State

States describe reality, not intent:

| State       | Means                                              |
| ----------- | -------------------------------------------------- |
| Backlog     | Accepted, not scheduled                            |
| Todo        | Scheduled, not started                             |
| In Progress | Someone is working on it now                       |
| In Review   | An open pull request exists for it                 |
| Done        | Merged and verified, and every sub-issue is closed |

Two rules are enforced because both were violated in practice:

- **In Review requires a linked pull request.** Four issues sat In Review with no
  pull request at all, so a glance at the board showed work in flight that
  nobody was doing. Parents are exempt: their pull requests hang off their
  children.
- **A parent may not be closed while a child is open.** `EID-67` was `Done` with
  35 of its 41 sub-issues open, which reported an entire readiness audit as
  remediated when most of it was untouched.

## Stale

An issue with no update in 60 days is stale: not necessarily wrong, but a claim
nobody has re-checked. Re-audit it against the current default branch and either
refresh its description with what you found, lower its priority, or close it.
Staleness is a prompt to look, not an instruction to close.

GitHub issues get the same 60-day threshold from the **Issue hygiene** workflow,
which labels and comments but never closes. `type/security`, `area/security`,
`priority/urgent`, and `pinned` are exempt, because a security issue going quiet
is not evidence it stopped mattering.

## Review cadence

| When                | What                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Weekly              | Run `pnpm backlog:health`. Fix violations rather than explaining them                       |
| Weekly              | Triage everything with no priority                                                          |
| Per epic completion | Confirm no child is open, then close the parent                                             |
| Monthly             | Re-audit anything stale, and re-audit every open issue in an epic before starting that epic |

The last one is the load-bearing habit. Every one of the readiness issues needed
its description rewritten before it could be implemented, and none of that was
visible from the board.

## What the check does not enforce

- **Estimates.** No open issue carries one. Adding a required field nobody fills
  in produces compliance, not information.
- **Assignees.** An unassigned issue in Todo is normal; an unassigned issue In
  Progress is a conversation, not a lint rule.
- **Description length or format.** Checkable acceptance criteria matter; word
  count does not.
