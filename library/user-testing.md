# User-testing fixture guidance

Use the fixture marker for every company created during validation. This makes
cleanup safe and independent of naming conventions.

## Tag on create

When posting to `/api/companies`, set `settings.testFixture` to the boolean
`true` and use the `__mtest__` prefix so fixtures are visible in the sidebar:

```json
{
  "name": "__mtest__ validation run",
  "settings": { "testFixture": true }
}
```

The marker is the cleanup criterion; the name prefix is only for visibility.

## Tear down on finish

After validation completes, remove the tagged companies and their dependent
data:

```bash
pnpm cleanup:fixtures -- --execute
```

The command is a dry run by default. If validation crashes before teardown, use
`--stale-hours N` as a safety net to remove only fixtures older than `N` hours:

```bash
pnpm cleanup:fixtures -- --execute --stale-hours 24
```
