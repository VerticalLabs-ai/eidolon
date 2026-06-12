# Eidolon Desktop

Native macOS shell for Eidolon.

## Development

```bash
pnpm desktop:dev
```

By default the app opens the local single-host Eidolon server at `http://localhost:3100`. To point at another approved Eidolon host:

```bash
EIDOLON_DESKTOP_APP_URL=https://staging.eidolon.verticallabs.ai pnpm desktop:dev
```

For local development against Vite, run the web app on its default port and point the desktop shell at it:

```bash
pnpm run dev
EIDOLON_DESKTOP_APP_URL=http://localhost:5173 pnpm desktop:dev
```

Loopback `http://localhost:<port>` URLs are accepted for local development. Non-loopback app URLs must use HTTPS.

## Local Runtime Companion

The desktop shell exposes a protected preload bridge for the Jarvis Runtime page. It can health-check local services, refresh status from the app menu, and launch explicitly configured OpenJarvis presets.

Menu shortcuts:

```bash
Cmd/Ctrl+Shift+J  # Open Jarvis Runtime
Cmd/Ctrl+Shift+R  # Refresh local runtime status
```

Health-check targets:

```bash
# Defaults to http://localhost:3100/api/health
EIDOLON_DESKTOP_LOCAL_API_HEALTH_URL=

# Optional. Leave empty when OpenJarvis is not running as an HTTP service.
EIDOLON_DESKTOP_OPENJARVIS_HEALTH_URL=
```

OpenJarvis preset launch is disabled unless each preset has an explicit argv array. The app does not infer or shell-expand commands.

```bash
EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS='{
  "morning-digest": ["jarvis", "init", "--preset", "morning-digest"],
  "deep-research": ["jarvis", "run", "--preset", "deep-research"]
}'
```

Supported preset ids:

```bash
chat-simple
morning-digest
deep-research
scheduled-monitor
code-assistant
```

## Packaging

```bash
pnpm desktop:package
pnpm desktop:make:mac
```

The macOS DMG is written under `packages/desktop/out/make/`.

## Signed Releases

For local packaging, the app is ad-hoc signed so the bundle verifies on the build machine. For a public macOS build, install a Developer ID Application certificate in Keychain and provide signing/notarization credentials through environment variables. Do not commit Apple credentials.

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: <Team Name> (<TEAMID>)"
```

Supported notarization options:

```bash
# Keychain profile created with xcrun notarytool store-credentials
APPLE_KEYCHAIN_PROFILE=

# or App Store Connect API key
APPLE_API_KEY=
APPLE_API_KEY_ID=
APPLE_API_ISSUER=

# or Apple ID app-specific password
APPLE_ID=
APPLE_APP_SPECIFIC_PASSWORD=
APPLE_TEAM_ID=
```

Set `EIDOLON_REQUIRE_MAC_SIGNING=1` in release builds so missing signing or notarization configuration fails before a DMG is produced.
