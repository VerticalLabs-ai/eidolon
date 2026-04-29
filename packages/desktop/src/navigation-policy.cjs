const DEFAULT_APP_URL = "https://eidolon.verticallabs.ai";
const DEFAULT_ALLOWED_HOSTS = [
  "eidolon.verticallabs.ai",
  "staging.eidolon.verticallabs.ai",
];
const DEFAULT_AUTH_FLOW_HOSTS = [
  "accounts.eidolon.verticallabs.ai",
  "clerk.eidolon.verticallabs.ai",
  "accounts.google.com",
];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return url.hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase().split("/")[0].split(":")[0] || null;
  }
}

function parseHostList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map(normalizeHost)
    .filter(Boolean);
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function resolveAppUrl(rawUrl = process.env.EIDOLON_DESKTOP_APP_URL) {
  const appUrl = new URL(rawUrl?.trim() || DEFAULT_APP_URL);
  const isHttps = appUrl.protocol === "https:";
  const isLocalHttp = appUrl.protocol === "http:" && isLoopbackHost(appUrl.hostname);

  if (!isHttps && !isLocalHttp) {
    throw new Error(
      "EIDOLON_DESKTOP_APP_URL must be an https URL, except loopback http URLs for local development.",
    );
  }

  return appUrl;
}

function buildAllowedHosts(options = {}) {
  const appUrl = options.appUrl || resolveAppUrl();
  return new Set([
    ...DEFAULT_ALLOWED_HOSTS,
    appUrl.hostname.toLowerCase(),
    ...parseHostList(options.extraHosts ?? process.env.EIDOLON_DESKTOP_ALLOWED_HOSTS),
  ]);
}

function buildAuthFlowHosts(options = {}) {
  return new Set([
    ...DEFAULT_AUTH_FLOW_HOSTS,
    ...parseHostList(options.extraHosts ?? process.env.EIDOLON_DESKTOP_AUTH_HOSTS),
  ]);
}

function isAllowedNavigationUrl(rawUrl, allowedHosts = buildAllowedHosts()) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname) && allowedHosts.has(url.hostname.toLowerCase());
  }

  if (url.protocol !== "https:") {
    return false;
  }

  return allowedHosts.has(url.hostname.toLowerCase());
}

function isAllowedAuthFlowUrl(rawUrl, authFlowHosts = buildAuthFlowHosts()) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  return url.protocol === "https:" && authFlowHosts.has(url.hostname.toLowerCase());
}

function shouldKeepNavigationInApp(rawUrl, options = {}) {
  return (
    isAllowedNavigationUrl(rawUrl, options.allowedHosts) ||
    isAllowedAuthFlowUrl(rawUrl, options.authFlowHosts)
  );
}

module.exports = {
  DEFAULT_APP_URL,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_AUTH_FLOW_HOSTS,
  buildAuthFlowHosts,
  buildAllowedHosts,
  isAllowedNavigationUrl,
  isAllowedAuthFlowUrl,
  resolveAppUrl,
  shouldKeepNavigationInApp,
};
