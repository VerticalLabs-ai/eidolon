# Branch protection policy

Eidolon enforces branch protection on both `main` and `staging` via GitHub
repository rulesets. The rulesets are managed through the GitHub REST API
(`gh api repos/VerticalLabs-ai/eidolon/rulesets`) and are verified by
`scripts/verify-branch-protection.mjs`.

## Protected branches

| Branch    | Ruleset name               | Ruleset ID |
| --------- | -------------------------- | ---------- |
| `main`    | Branch protection: main    | 20947029   |
| `staging` | Branch protection: staging | 20947030   |

## Enforced rules

Each ruleset applies the following rules to its target branch:

### Required pull request reviews

- At least **1 approving review** is required before a pull request can be
  merged.
- **Code-owner review** is required for files that have a designated code owner
  in `.github/CODEOWNERS`.
- Stale reviews are not automatically dismissed on push (reviews persist across
  force-pushes to the PR branch).
- Last-push approval and review-thread resolution are not required.

### Status checks

Status checks are intentionally **not required** while GitHub Actions CI is
blocked by the repository billing lock. Requiring `lint` or `typecheck` while
those workflows cannot run would block every pull request. When CI billing is
restored, add the actual workflow check names to both rulesets and update the
verification script in the same change.

### Force-push blocked

The `non_fast_forward` rule prevents force-pushes to the protected branch. No
one, including administrators, can force-push or rewrite history on `main` or
`staging`.

> **Sole exception:** The GitHub Actions bot bypass on `main` (see
> [Enforcement for administrators](#enforcement-for-administrators) below) is
> the **only** exception to the no-force-push/no-rewrite rule on either
> protected branch. It exists solely so the staging-to-main fast-forward
> promotion workflow (`pnpm promote` / `scripts/promote-to-main.sh`) can push
> the promoted commit to `main` without a pull request. It is never used for
> history rewrites, force-pushes, or any other purpose, and no other actor has
> bypass permission on either ruleset.

### Enforcement for administrators

The `staging` ruleset has no bypass actors, so it applies to all users including
repository administrators. The `main` ruleset has exactly one bypass actor:
the GitHub Actions bot identity (`github-actions[bot]`, `actor_id: 41898282`,
`actor_type: User`). GitHub's ruleset API represents this bot as a user actor,
even though it is the GitHub Actions app. This is required because the
promotion workflow performs a reviewed fast-forward directly to `main`.
Human pushes remain blocked by the ruleset.

## Verification

Run the verification script to confirm both rulesets are correctly configured:

```bash
node scripts/verify-branch-protection.mjs
```

The script fetches the rulesets from the GitHub API and checks that each branch
has the required pull-request and force-push rules, no status-check rule while
CI is unavailable, and the correct bypass policy. It exits with code 0 on
success and code 1 if any rule is missing or misconfigured.

## Changing the policy

To modify the branch protection rules:

1. Update the ruleset via the GitHub API:

   ```bash
   gh api repos/VerticalLabs-ai/eidolon/rulesets/<RULESET_ID> \
     --method PUT \
     --field name='Branch protection: <branch>' \
     --field target=branch \
     --field enforcement=active \
     ...
   ```

2. Run `node scripts/verify-branch-protection.mjs` to confirm the change.

3. Update this document to reflect the new policy.

4. Open a pull request with any script or documentation changes.

When CI billing is restored, add the real check contexts (for example, the
`lint` job's emitted check name and a standalone `typecheck` job) to both
rulesets. Do not add placeholder contexts that no workflow emits.

## Relationship to promotion workflow

The promotion workflow (`pnpm promote` / `scripts/promote-to-main.sh`) performs
a fast-forward merge from `staging` to `main`. Because both branches are
protected, promotion must be performed by an actor with bypass permission or
through the GitHub Actions workflow that uses a `GITHUB_TOKEN` with appropriate
permissions. Direct pushes to `main` or `staging` are not permitted; all changes
must go through pull request review.
