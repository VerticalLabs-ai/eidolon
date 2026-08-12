# Deployment and rollback

## Release

1. Confirm the target commit is on `main` and CI is green.
2. Confirm `pnpm typecheck`, `pnpm test:coverage`, `pnpm build`, lint, duplication,
   dead-code, and changed-file formatting checks pass.
3. The CalVer release workflow creates the tag and GitHub Release automatically.
4. Check the Vercel deployment for the expected commit and verify
   `GET /api/health` returns HTTP 200.

## Rollback

1. Stop promoting new commits to `main`.
2. Open **Actions → Roll back Vercel production → Run workflow** and enter the
   last known-good Eidolon Vercel deployment URL. The workflow requires the
   production environment's `VERCEL_TOKEN` and rejects unrelated deployment
   hosts.
3. If a database migration is involved, do not reverse it blindly. Preserve
   compatible reads/writes, restore from an approved backup, or ship a forward
   fix after assessing the migration.
4. Verify `GET /api/health` and a representative authenticated API request.
5. Record the incident, affected release, user impact, and recovery steps in
   the related issue.
