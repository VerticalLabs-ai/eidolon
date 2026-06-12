const { contextBridge, ipcRenderer } = require("electron");

const TRUSTED_APP_HOSTS = new Set([
  "eidolon.verticallabs.ai",
  "staging.eidolon.verticallabs.ai",
]);
const TRUSTED_APP_ORIGINS = new Set();
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const preloadEnv = globalThis.process?.env ?? {};
const DEFAULT_APP_URL = "http://localhost:3100";

function normalizeHost(value) {
  const trimmed = value?.trim();
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

function addTrustedHost(value) {
  const host = normalizeHost(value);
  if (host) TRUSTED_APP_HOSTS.add(host);
}

function normalizeOrigin(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function addTrustedOrigin(value) {
  const origin = normalizeOrigin(value);
  if (origin) TRUSTED_APP_ORIGINS.add(origin);
}

function formatOriginHost(hostname) {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function addTrustedLoopbackOriginForAppHost(value, appUrl) {
  const host = normalizeHost(value);
  if (
    !host ||
    !appUrl ||
    appUrl.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(appUrl.hostname.toLowerCase()) ||
    !LOOPBACK_HOSTS.has(host)
  ) {
    return;
  }

  const port = appUrl.port ? `:${appUrl.port}` : "";
  TRUSTED_APP_ORIGINS.add(
    `${appUrl.protocol}//${formatOriginHost(host)}${port}`.toLowerCase(),
  );
}

const appUrlValue = preloadEnv.EIDOLON_DESKTOP_APP_URL || DEFAULT_APP_URL;
let parsedAppUrl = null;
try {
  parsedAppUrl = new URL(appUrlValue);
} catch {
  parsedAppUrl = null;
}

addTrustedHost(appUrlValue);
addTrustedOrigin(appUrlValue);
for (const host of (preloadEnv.EIDOLON_DESKTOP_ALLOWED_HOSTS || "").split(",")) {
  addTrustedHost(host);
  addTrustedLoopbackOriginForAppHost(host, parsedAppUrl);
}
for (const origin of (preloadEnv.EIDOLON_DESKTOP_ALLOWED_ORIGINS || "").split(",")) {
  addTrustedOrigin(origin);
}

function isTrustedAppLocation(location) {
  const hostname = location.hostname.toLowerCase();
  if (location.protocol === "http:") {
    return (
      LOOPBACK_HOSTS.has(hostname) &&
      TRUSTED_APP_ORIGINS.has(location.origin.toLowerCase())
    );
  }

  return location.protocol === "https:" && TRUSTED_APP_HOSTS.has(hostname);
}

if (isTrustedAppLocation(globalThis.location)) {
  contextBridge.exposeInMainWorld("eidolonDesktop", {
    getRuntimeStatus: () => ipcRenderer.invoke("eidolon:runtime-status"),
    launchOpenJarvisPreset: (preset) =>
      ipcRenderer.invoke("eidolon:launch-openjarvis-preset", preset),
    onRuntimeStatusRefresh: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("eidolon:runtime-status-refresh", listener);
      return () => ipcRenderer.removeListener("eidolon:runtime-status-refresh", listener);
    },
  });
}
