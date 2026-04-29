# Eidolon Desktop

Native macOS shell for the hosted Eidolon app.

## Development

```bash
pnpm desktop:dev
```

By default the app opens `https://eidolon.verticallabs.ai`. To point at another approved Eidolon host:

```bash
EIDOLON_DESKTOP_APP_URL=https://staging.eidolon.verticallabs.ai pnpm desktop:dev
```

Loopback `http://localhost:<port>` URLs are accepted for local development. Non-loopback app URLs must use HTTPS.

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
