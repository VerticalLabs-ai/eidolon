const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(value) {
  const trimmed = value?.trim();
  if (!trimmed) {return null;}

  try {
    const url = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return url.hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase().split("/")[0].split(":")[0] || null;
  }
}

function normalizeOrigin(value) {
  const trimmed = value?.trim();
  if (!trimmed) {return null;}

  try {
    const url = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function formatOriginHost(hostname) {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

module.exports = {
  formatOriginHost,
  isLoopbackHost,
  normalizeHost,
  normalizeOrigin,
};
