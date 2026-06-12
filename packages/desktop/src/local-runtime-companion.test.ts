import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPENJARVIS_PRESETS,
  getLocalRuntimeStatus,
  launchOpenJarvisPreset,
  readLocalRuntimeConfig,
} from "./local-runtime-companion.cjs";

describe("local runtime companion", () => {
  it("defaults to the local single-host app URL", () => {
    expect(readLocalRuntimeConfig({}).appUrl).toBe("http://localhost:3100");
  });

  it("parses configured OpenJarvis preset commands and ignores unsupported presets", () => {
    const config = readLocalRuntimeConfig({
      EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS: JSON.stringify({
        "morning-digest": ["jarvis", "init", "--preset", "morning-digest"],
        experimental: ["jarvis", "experimental"],
      }),
    });

    expect(config.openJarvis.presets).toEqual(DEFAULT_OPENJARVIS_PRESETS);
    expect(config.openJarvis.presetCommands).toEqual({
      "morning-digest": ["jarvis", "init", "--preset", "morning-digest"],
    });
  });

  it("rejects invalid preset command JSON", () => {
    expect(() =>
      readLocalRuntimeConfig({
        EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS: "{nope",
      }),
    ).toThrow("EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS must be valid JSON");
  });

  it("rejects invalid preset argv shapes", () => {
    expect(() =>
      readLocalRuntimeConfig({
        EIDOLON_DESKTOP_OPENJARVIS_PRESET_COMMANDS: JSON.stringify({
          "morning-digest": "jarvis init",
        }),
      }),
    ).toThrow('OpenJarvis preset "morning-digest" must be a non-empty argv array');
  });

  it("reports unconfigured services without network checks", async () => {
    const status = await getLocalRuntimeStatus({
      appUrl: "http://localhost:3000",
      services: [
        {
          id: "eidolon-api",
          label: "Eidolon local API",
          url: "",
          required: true,
        },
      ],
      openJarvis: {
        presets: DEFAULT_OPENJARVIS_PRESETS,
        presetCommands: {},
      },
    });

    expect(status.services).toEqual([
      expect.objectContaining({
        id: "eidolon-api",
        status: "unconfigured",
        latencyMs: null,
        error: null,
      }),
    ]);
    expect(status.openJarvis.configured).toBe(false);
  });

  it("rejects unsupported or unconfigured preset launches", async () => {
    const config = {
      appUrl: "http://localhost:3000",
      services: [],
      openJarvis: {
        presets: DEFAULT_OPENJARVIS_PRESETS,
        presetCommands: {},
      },
    };

    await expect(launchOpenJarvisPreset("unknown", config)).rejects.toThrow(
      "Unsupported OpenJarvis preset",
    );
    await expect(launchOpenJarvisPreset("morning-digest", config)).rejects.toThrow(
      'No launch command configured for OpenJarvis preset "morning-digest"',
    );
  });

  it("launches a configured preset command", async () => {
    const config = {
      appUrl: "http://localhost:3000",
      services: [],
      openJarvis: {
        presets: DEFAULT_OPENJARVIS_PRESETS,
        presetCommands: {
          "morning-digest": [process.execPath, "-e", "process.exit(0)"],
        },
      },
    };

    await expect(launchOpenJarvisPreset("morning-digest", config)).resolves.toEqual(
      expect.objectContaining({
        preset: "morning-digest",
        pid: expect.any(Number),
      }),
    );
  });
});
