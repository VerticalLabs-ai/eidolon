# Local macOS LaunchAgent

`ai.verticallabs.eidolon.local-server` serves the local built app. Its entry point
is `server/scripts/local-server.mjs`, which loads the existing app environment,
requires a loopback Postgres URL, and waits for authenticated `SELECT 1` before
importing `server/dist/index.js`. URL precedence matches app bootstrap:
`DATABASE_URL`, then `POSTGRES_URL`, then `POSTGRES_URL_NON_POOLING`.

Probes have bounded connection/query timeouts. Failed readiness retries back off
from 5 seconds to at most 60 seconds and report a redacted waiting message.
No Docker commands run: intentionally stopped containers stay stopped. Once the
operator restores the database, the next successful probe starts the app.
The wrapper is not a running-service health monitor. After startup, normal app
behavior and health endpoints apply; launchd restarts a process that exits.
`ThrottleInterval=60` prevents rapid launchd retries for build/config/bootstrap
failures that happen outside the readiness loop.

## Install or update an existing service

This is an upgrade of an existing two-argument Node LaunchAgent, not a generator
for new credentials. Use a clean, reviewed canonical checkout, not a disposable
worktree. Keep the existing server build and Node path. Build with `pnpm build`
only when application sources changed or build outputs are absent.

1. Commit/promote the wrapper and installer into the canonical runtime checkout.
2. Make a mode-0600 backup of the existing plist in an operator-private directory.
3. Prepare a separate candidate (the destination directory must already exist):

   ```bash
   python3 scripts/prepare-local-launchagent.py \
     "$HOME/Library/LaunchAgents/ai.verticallabs.eidolon.local-server.plist" \
     /absolute/private/path/eidolon-candidate.plist \
     --runtime-root "$PWD"
   plutil -lint /absolute/private/path/eidolon-candidate.plist
   ```

4. Compare parsed `EnvironmentVariables`, log paths, and other unrelated settings
   to the backup without printing their values. Only `ProgramArguments`,
   `RunAtLoad`, `KeepAlive`, and `ThrottleInterval` may change.
5. During an authorized local restart, record the exact service PID and use
   `launchctl bootout` on that service. Wait (bounded, e.g. 10 seconds) for that
   PID to exit before reloading: bootout may return before graceful shutdown
   completes, and immediate bootstrap can fail with error 5. Atomically replace
   its plist with the mode-0600 candidate, then bootstrap the exact plist with
   `launchctl bootstrap gui/$(id -u) /absolute/path/to/service.plist`. If bootstrap
   fails, restore the backup and bootstrap it; do not leave the service unloaded.
6. Read back the plist and launchd PID/entry point without dumping environment
   secrets. Verify `/api/ready` and a read-only DB-backed API such as
   `/api/companies`; HTTP 200 from the SPA alone is not functional verification.

Use `launchctl bootout gui/$(id -u)/ai.verticallabs.eidolon.local-server` for a
persistent deliberate app stop. Killing its PID alone requests a KeepAlive
restart. Do not stop shared Docker infrastructure to test this change.

## Regression checks

```bash
node --test server/scripts/local-server.test.mjs
python3 -m unittest discover -s scripts -p test_prepare_local_launchagent.py
```

These cover loopback enforcement, URL precedence, capped waiting/recovery,
credential-safe logs, refused and silent sockets, and atomic secret-preserving
plist preparation. For a real dependency recovery drill without stopping the
database, point a separate readiness-only process at a loopback TCP forwarder
that is initially unavailable, then start forwarding to the local Postgres port.
Do not start a second application scheduler against the live database.
