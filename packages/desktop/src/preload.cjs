const { contextBridge, ipcRenderer } = require("electron");

const TRUSTED_APP_HOSTS = new Set([
  "eidolon.verticallabs.ai",
  "staging.eidolon.verticallabs.ai",
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const preloadEnv = globalThis.process?.env ?? {};

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

addTrustedHost(preloadEnv.EIDOLON_DESKTOP_APP_URL);
for (const host of (preloadEnv.EIDOLON_DESKTOP_ALLOWED_HOSTS || "").split(",")) {
  addTrustedHost(host);
}

function isTrustedAppLocation(location) {
  const hostname = location.hostname.toLowerCase();
  if (location.protocol === "http:") {
    return LOOPBACK_HOSTS.has(hostname) && TRUSTED_APP_HOSTS.has(hostname);
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
