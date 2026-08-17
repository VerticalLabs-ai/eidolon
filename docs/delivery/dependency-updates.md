# Dependency update automation

Eidolon uses [Renovate](https://docs.renovatebot.com/) to keep dependencies
current with minimal manual toil. Renovate scans the repository, proposes
update pull requests, and tracks pending work on a dependency dashboard issue.

## How it is installed

Renovate can run as either the **Renovate GitHub App** or a **GitHub Actions
workflow**.

### Option 1: Renovate GitHub App (preferred)

1. Open the [Renovate GitHub App](https://github.com/apps/renovate) page.
2. Click **Configure** and select the `VerticalLabs-ai` organization.
3. Choose **Only select repositories** and pick `eidolon`.
4. Save the installation.

Once installed, Renovate reads `renovate.json` at the repository root and opens
update PRs automatically. No additional workflow is required.

### Option 2: GitHub Actions workflow

If the GitHub App is not available, Renovate runs from
`.github/workflows/renovate.yml`. The workflow is scheduled weekly and can also
be triggered manually from the **Actions** tab.

The workflow uses `.github/renovate-global.json` as the self-hosted configuration
file, which specifies the repository to process (`VerticalLabs-ai/eidolon`).
Renovate then reads the repository-level `renovate.json` at the repository root
for per-repository settings.

The workflow requires a `RENOVATE_TOKEN` repository secret with the following
permissions:

- `contents:write` to create and update branches
- `pull-requests:write` to open and update PRs
- `issues:write` to maintain the dependency dashboard

Create the secret at **Settings → Secrets and variables → Actions** in the
GitHub repository.

## How it operates

- Renovate scans the repository on its schedule and after dependency-related
  changes land on the default branch.
- It groups patch and minor updates for `pnpm` managed dependencies into a
  single PR to reduce noise.
- Major updates and other ecosystem updates are opened as separate PRs.
- Each PR branch follows the `renovate/<package>` naming convention, which is
  exempt from the strict PR naming check in `.github/workflows/pr-naming.yml`.
- Renovate rebases open PRs automatically when the base branch changes, unless
  the PR has been edited by a human.

## Configuration overview

The root `renovate.json` controls all behavior:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "minimumReleaseAge": "3 days",
  "dependencyDashboard": true,
  "rangeStrategy": "pin",
  "packageRules": [
    {
      "matchManagers": ["pnpm"],
      "groupName": "pnpm dependencies",
      "matchUpdateTypes": ["patch", "minor"]
    }
  ]
}
```

Key settings:

- `extends: ["config:recommended"]` applies Renovate's recommended defaults,
  including sensible grouping and scheduling. Automerge is **not** enabled by
  this preset; all updates require manual review and merge.
- `minimumReleaseAge: "3 days"` waits three days after a release is published
  before proposing an update. This reduces the risk of adopting a dependency
  release that is quickly yanked or patched.
- `dependencyDashboard: true` creates a GitHub issue that lists all pending,
  in-progress, and blocked updates.
- `rangeStrategy: "pin"` pins version ranges to exact versions so the lockfile
  and source code agree on the exact dependency versions in use.
- The `packageRules` entry groups `pnpm` patch and minor updates into a single
  PR.

## How to review and update the setup

1. Check the dependency dashboard issue for the current list of pending updates.
2. Review each Renovate PR individually. Read the release notes linked in the PR
   description and verify that CI passes.
3. For patch and minor grouped PRs, approve and merge if the test suite is
   green and the changes are low risk.
4. For major updates, run the application locally or in a staging environment
   before merging, because major versions may include breaking changes.
5. To change Renovate behavior, edit `renovate.json` and open a normal PR. The
   `renovate-config` test in `server/src/__tests__/renovate-config.test.ts`
   validates that the file remains valid JSON and keeps the required settings.
6. If Renovate becomes too noisy or too quiet, adjust `minimumReleaseAge`,
   `packageRules`, or scheduling in `renovate.json` and document the rationale in
   the PR description.
