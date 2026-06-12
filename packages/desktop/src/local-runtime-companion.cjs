const { spawn } = require("node:child_process");

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_OPENJARVIS_PRESETS = [
  "chat-simple",
  "morning-digest",
  "deep-research",
  "scheduled-monitor",
  "code-assistant",
];

function parseJsonObject(value, label) {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizePresetCommands(value) {
  const parsed = parseJsonObject(value, "EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS");
  const commands = {};

  for (const [preset, argv] of Object.entries(parsed)) {
    if (!DEFAULT_OPENJARVIS_PRESETS.includes(preset)) continue;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part) => typeof part === "string" && part.trim())
    ) {
      throw new Error(`OpenJarvis preset "${preset}" must be a non-empty argv array`);
    }
    commands[preset] = argv.map((part) => part.trim());
  }

  return commands;
}

function readLocalRuntimeConfig(env = process.env) {
  const appUrl = env.EIDOLON_DESKTOP_APP_URL || "http://localhost:3100";
  const apiHealthUrl =
    env.EIDOLON_DESKTOP_LOCAL_API_HEALTH_URL || "http://localhost:3100/api/health";
  const openJarvisHealthUrl = env.EIDOLON_DESKTOP_OPENJARVIS_HEALTH_URL || "";
  const presetCommands = normalizePresetCommands(
    env.EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS,
  );

  return {
    appUrl,
    services: [
      {
        id: "eidolon-api",
        label: "Eidolon local API",
        url: apiHealthUrl,
        required: true,
      },
      {
        id: "openjarvis",
        label: "OpenJarvis local service",
        url: openJarvisHealthUrl,
        required: false,
      },
    ],
    openJarvis: {
      presets: DEFAULT_OPENJARVIS_PRESETS,
      presetCommands,
    },
  };
}

async function checkService(service, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
  if (!service.url) {
    return {
      ...service,
      status: "unconfigured",
      latencyMs: null,
      error: null,
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(service.url, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      ...service,
      status: response.ok ? "healthy" : "error",
      latencyMs: Date.now() - startedAt,
      statusCode: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ...service,
      status: "unavailable",
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getLocalRuntimeStatus(config = readLocalRuntimeConfig()) {
  const services = await Promise.all(
    config.services.map((service) => checkService(service)),
  );
  const configuredPresets = Object.keys(config.openJarvis.presetCommands);

  return {
    desktop: true,
    appUrl: config.appUrl,
    generatedAt: new Date().toISOString(),
    services,
    openJarvis: {
      configured: configuredPresets.length > 0,
      presets: config.openJarvis.presets.map((preset) => ({
        id: preset,
        configured: configuredPresets.includes(preset),
      })),
    },
  };
}

async function launchOpenJarvisPreset(preset, config = readLocalRuntimeConfig()) {
  if (!config.openJarvis.presets.includes(preset)) {
    throw new Error(`Unsupported OpenJarvis preset: ${preset}`);
  }

  const argv = config.openJarvis.presetCommands[preset];
  if (!argv) {
    throw new Error(
      `No launch command configured for OpenJarvis preset "${preset}". Set EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS.`,
    );
  }

  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({
        preset,
        pid: child.pid ?? null,
        launchedAt: new Date().toISOString(),
      });
    });
  });
}

module.exports = {
  DEFAULT_OPENJARVIS_PRESETS,
  getLocalRuntimeStatus,
  launchOpenJarvisPreset,
  readLocalRuntimeConfig,
};
