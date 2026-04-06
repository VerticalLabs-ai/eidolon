# Releasing

Releases are automated; see the **Releases** section in [README.md](README.md) for the CalVer rules (`YYYY.M.D`, same-day `-2`, `-3`, …, UTC).

## Workflow

- [`.github/workflows/release.yml`](.github/workflows/release.yml) runs on every push to `main` (and on manual `workflow_dispatch`).
- The `verify` job must pass (`npm run typecheck`, `npm run test:run`, `npm run build`) or no tag or release is created.
- The `verify` job computes the next CalVer tag once via [`scripts/calver-next-tag.sh`](scripts/calver-next-tag.sh), uses it for the UI build, and exposes it to `release` as a job output.
- The `release` job consumes that verified tag, pushes it, then creates a GitHub Release with generated notes.

## Retries

If the workflow is re-run for a commit that **already** has a CalVer tag for the current UTC day, the script sets `skip` and the job exits without duplicating the tag or release.

## Manual tags

Avoid creating CalVer tags by hand unless you know what you are doing; the next automated release might conflict or skip unexpectedly. Prefer fixing CI and pushing to `main`, or use `workflow_dispatch` after a green `verify`.

## Local tests and `better-sqlite3`

If `npm run test:run` fails with a Node native module version mismatch for `better-sqlite3`, run `npm rebuild better-sqlite3` (or reinstall with your current Node version). CI runs `npm ci` on Ubuntu with Node 20 and compiles the add-on for that environment.
