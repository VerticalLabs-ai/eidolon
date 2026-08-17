# Feature flag rollout and rollback

Flags exist so a risky change can be turned on for a slice of companies and
turned off again without a deploy. Every flag defaults to off, and a missing or
malformed configuration leaves it off, so a broken value fails closed.

## Configuration

Flags live in the `EIDOLON_FEATURE_FLAGS` environment variable as a JSON object:

```json
{ "analyticsAgentsBatched": { "enabled": true, "rolloutPercentage": 25 } }
```

| Field               | Meaning                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `enabled`           | Master switch. Absent or `false` means off regardless of percentage |
| `rolloutPercentage` | `0`–`100`. Absent or `>= 100` means everyone. `0` means nobody      |

Assignment is a SHA-256 bucket of `flag:subject`, so a given company keeps the
same answer across processes, restarts, and deploys. Widening a rollout only
adds subjects: a company that was on at 10% is still on at 50%. Narrowing
removes subjects in the reverse order.

The subject is the **company id**. Rollout therefore happens per company, not
per user, so every member of a company sees the same behaviour.

## Declared flags

Only flags declared in `FEATURE_FLAGS` (`server/src/services/feature-flags.ts`)
are evaluated for clients. Configuring an undeclared name has no effect and the
name is never returned by the API, so `EIDOLON_FEATURE_FLAGS` can hold entries
for unreleased work without leaking them.

| Flag                     | Effect when enabled                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `analyticsAgentsBatched` | `GET /api/companies/:companyId/analytics/agents` computes task counts in one aggregate query instead of one query per agent. The response is identical either way |

## Reading flag state

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/companies/$COMPANY_ID/flags"
```

```json
{ "data": { "subject": "<companyId>", "flags": { "analyticsAgentsBatched": false } } }
```

The response carries declared names and boolean outcomes only. It never returns
the raw configuration, the rollout percentage, or another company's assignment,
because the first two are operator configuration and the third is not the
caller's business.

## Rolling out

1. Confirm the flag is declared in `FEATURE_FLAGS` and shipped in the running
   build. A flag the build does not know about will not evaluate.
2. Enable it for nobody first, to prove the configuration parses:

   ```json
   { "analyticsAgentsBatched": { "enabled": true, "rolloutPercentage": 0 } }
   ```

   Read the endpoint back for a known company and expect `false`.

3. Widen in steps, checking after each one. `10` → `25` → `50` → `100` is a
   reasonable ladder for a read-path change; use smaller steps for anything that
   writes.
4. After each step, confirm the affected behaviour on a company that is in the
   rollout. Query `/api/companies/$COMPANY_ID/flags` to find out whether a
   specific company is in it rather than guessing from the percentage.
5. Watch `http_request_duration_seconds` and the error rate for the affected
   route on `/api/metrics` between steps. A change that is faster for most
   companies can still be slower for the largest one.

## Rolling back

Set `enabled` to `false`, or lower `rolloutPercentage`, and restart or redeploy
the server so the new environment value is in effect:

```json
{ "analyticsAgentsBatched": { "enabled": false } }
```

Rollback needs no code change, no migration, and no data repair. Because
assignment is deterministic, re-enabling later puts the same companies back in
the same order.

Removing the variable entirely turns every flag off. That is the safest state
and the correct first action if you cannot tell which flag caused an incident.

## Retiring a flag

A permanent flag is not a rollout, it is a branch in production that nobody
tests both halves of. Once a flag has been at 100% through a full release cycle
with no rollback:

1. Delete the disabled code path.
2. Remove the entry from `FEATURE_FLAGS`.
3. Remove the name from `EIDOLON_FEATURE_FLAGS` in every environment.
4. Delete the tests that covered the removed path, and keep the ones that cover
   the surviving behaviour.
