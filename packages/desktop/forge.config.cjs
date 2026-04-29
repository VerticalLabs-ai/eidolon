const path = require("node:path");

const APP_NAME = "Eidolon";
const APP_BUNDLE_ID = "ai.verticallabs.eidolon";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for signed macOS desktop releases.`);
  }
  return value;
}

function buildMacSignConfig() {
  const requireSigning = process.env.EIDOLON_REQUIRE_MAC_SIGNING === "1";
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  const entitlements = path.resolve(__dirname, "entitlements.mac.plist");

  if (requireSigning && !identity) {
    throw new Error(
      "APPLE_SIGNING_IDENTITY is required when EIDOLON_REQUIRE_MAC_SIGNING=1.",
    );
  }

  return {
    identity: identity || "-",
    identityValidation: Boolean(identity),
    hardenedRuntime: Boolean(identity),
    gatekeeperAssess: false,
    optionsForFile: (filePath) => ({
      ...(filePath.endsWith(`${APP_NAME}.app`) ? { entitlements } : {}),
      hardenedRuntime: Boolean(identity),
    }),
  };
}

function buildMacNotarizeConfig() {
  const requireSigning = process.env.EIDOLON_REQUIRE_MAC_SIGNING === "1";
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE?.trim();
  if (keychainProfile) {
    return {
      keychainProfile,
      keychain: process.env.APPLE_KEYCHAIN?.trim() || undefined,
    };
  }

  const apiKey = process.env.APPLE_API_KEY?.trim();
  const apiKeyId = process.env.APPLE_API_KEY_ID?.trim();
  const apiIssuer = process.env.APPLE_API_ISSUER?.trim();
  if (apiKey || apiKeyId || apiIssuer) {
    if (requireSigning) {
      return {
        appleApiKey: requireEnv("APPLE_API_KEY"),
        appleApiKeyId: requireEnv("APPLE_API_KEY_ID"),
        appleApiIssuer: requireEnv("APPLE_API_ISSUER"),
      };
    }

    if (apiKey && apiKeyId && apiIssuer) {
      return {
        appleApiKey: apiKey,
        appleApiKeyId: apiKeyId,
        appleApiIssuer: apiIssuer,
      };
    }
  }

  const appleId = process.env.APPLE_ID?.trim();
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD?.trim();
  const teamId = process.env.APPLE_TEAM_ID?.trim();
  if (appleId || appleIdPassword || teamId) {
    if (requireSigning) {
      return {
        appleId: requireEnv("APPLE_ID"),
        appleIdPassword: requireEnv("APPLE_APP_SPECIFIC_PASSWORD"),
        teamId: requireEnv("APPLE_TEAM_ID"),
      };
    }

    if (appleId && appleIdPassword && teamId) {
      return { appleId, appleIdPassword, teamId };
    }
  }

  if (requireSigning) {
    throw new Error(
      "Signed macOS desktop releases require notarization credentials. " +
        "Set APPLE_KEYCHAIN_PROFILE, APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, " +
        "or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID.",
    );
  }

  return undefined;
}

const macSignConfig = buildMacSignConfig();
const macNotarizeConfig = buildMacNotarizeConfig();

module.exports = {
  packagerConfig: {
    name: APP_NAME,
    executableName: APP_NAME,
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: "public.app-category.productivity",
    asar: true,
    prune: false,
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/out($|\/)/,
    ],
    ...(macSignConfig ? { osxSign: macSignConfig } : {}),
    ...(macNotarizeConfig ? { osxNotarize: macNotarizeConfig } : {}),
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: APP_NAME,
        format: "ULFO",
        overwrite: true,
      },
    },
  ],
};
