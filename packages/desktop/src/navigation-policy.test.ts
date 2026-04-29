import { describe, expect, it } from "vitest";

import {
  buildAuthFlowHosts,
  buildAllowedHosts,
  isAllowedNavigationUrl,
  resolveAppUrl,
  shouldKeepNavigationInApp,
} from "./navigation-policy.cjs";

describe("desktop navigation policy", () => {
  it("allows production and staging Eidolon hosts", () => {
    const allowedHosts = buildAllowedHosts({
      appUrl: new URL("https://eidolon.verticallabs.ai"),
    });

    expect(
      isAllowedNavigationUrl("https://eidolon.verticallabs.ai/login", allowedHosts),
    ).toBe(true);
    expect(
      isAllowedNavigationUrl("https://staging.eidolon.verticallabs.ai", allowedHosts),
    ).toBe(true);
  });

  it("blocks external and non-web navigation", () => {
    const allowedHosts = buildAllowedHosts({
      appUrl: new URL("https://eidolon.verticallabs.ai"),
    });

    expect(isAllowedNavigationUrl("https://example.com", allowedHosts)).toBe(false);
    expect(isAllowedNavigationUrl("file:///etc/passwd", allowedHosts)).toBe(false);
    expect(isAllowedNavigationUrl("eidolon://settings", allowedHosts)).toBe(false);
  });

  it("keeps Clerk and Google auth redirects inside the desktop window", () => {
    const allowedHosts = buildAllowedHosts({
      appUrl: new URL("https://eidolon.verticallabs.ai"),
    });
    const authFlowHosts = buildAuthFlowHosts();

    expect(
      shouldKeepNavigationInApp(
        "https://accounts.eidolon.verticallabs.ai/sign-in",
        { allowedHosts, authFlowHosts },
      ),
    ).toBe(true);
    expect(
      shouldKeepNavigationInApp("https://accounts.google.com/o/oauth2/v2/auth", {
        allowedHosts,
        authFlowHosts,
      }),
    ).toBe(true);
    expect(
      shouldKeepNavigationInApp("https://example.com/docs", {
        allowedHosts,
        authFlowHosts,
      }),
    ).toBe(false);
  });

  it("allows loopback http only when the loopback host is explicitly in scope", () => {
    const allowedHosts = buildAllowedHosts({
      appUrl: new URL("http://localhost:3000"),
    });

    expect(isAllowedNavigationUrl("http://localhost:3000", allowedHosts)).toBe(true);
    expect(isAllowedNavigationUrl("http://127.0.0.1:3000", allowedHosts)).toBe(false);
  });

  it("rejects non-https app URLs outside loopback development", () => {
    expect(() => resolveAppUrl("http://eidolon.verticallabs.ai")).toThrow(
      "https URL",
    );
  });
});
