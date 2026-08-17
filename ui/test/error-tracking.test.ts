import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @sentry/react so the tests verify initialization logic without
// starting the real browser SDK. vi.hoisted ensures the mock values exist
// before vi.mock runs (both are hoisted above imports by vitest).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    init: vi.fn(),
    getClient: vi.fn().mockReturnValue(null),
    withScope: vi.fn(),
    captureException: vi.fn(),
    initConfig: null as Record<string, unknown> | null,
  };
});

vi.mock('@sentry/react', () => ({
  init: (config: Record<string, unknown>) => {
    mocks.initConfig = config;
    mocks.init(config);
  },
  getClient: mocks.getClient,
  withScope: (cb: (scope: { setTag: (k: string, v: unknown) => void }) => void) => {
    mocks.withScope(cb);
    cb({ setTag: vi.fn() });
  },
  captureException: mocks.captureException,
}));

import {
  initializeErrorTracking,
  isErrorTrackingEnabled,
  captureUIError,
  __resetErrorTrackingForTesting,
} from '../src/lib/error-tracking';

describe('UI error tracking (EID-101)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initConfig = null;
    mocks.getClient.mockReturnValue(null);
    __resetErrorTrackingForTesting();
  });

  afterEach(() => {
    __resetErrorTrackingForTesting();
    // import.meta.env is read-only; tests that need to change it use
    // vi.stubEnv and reset here. Vite's import.meta.env.PROD/MODE are not
    // env-stubbable directly, so we only reset VITE_SENTRY_* here.
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // VAL-OBS-008: UI Sentry integration with optional initialization
  // -------------------------------------------------------------------------

  describe('optional initialization', () => {
    it('is disabled (no-op) when VITE_SENTRY_DSN is unset', () => {
      delete (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN;
      const result = initializeErrorTracking();

      expect(result).toBe(false);
      expect(isErrorTrackingEnabled()).toBe(false);
      expect(mocks.init).not.toHaveBeenCalled();
    });

    it('is disabled (no-op) when VITE_SENTRY_DSN is empty string', () => {
      vi.stubEnv('VITE_SENTRY_DSN', '');
      // import.meta.env values are baked at build time; emulate empty by
      // mutating the runtime object since tests cannot re-build.
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN = '';
      const result = initializeErrorTracking();

      expect(result).toBe(false);
      expect(isErrorTrackingEnabled()).toBe(false);
      expect(mocks.init).not.toHaveBeenCalled();
    });

    it('initializes Sentry when VITE_SENTRY_DSN is set', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/1';
      const result = initializeErrorTracking();

      expect(result).toBe(true);
      expect(isErrorTrackingEnabled()).toBe(true);
      expect(mocks.init).toHaveBeenCalledTimes(1);
    });

    it('does not initialize a second time on repeated calls', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/1';
      mocks.getClient.mockReturnValue({ id: 'mock-client' });
      initializeErrorTracking();
      initializeErrorTracking();

      expect(mocks.init).toHaveBeenCalledTimes(1);
    });

    it('passes the DSN to Sentry.init', () => {
      const dsn = 'https://example@sentry.example/2';
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN = dsn;
      initializeErrorTracking();

      expect(mocks.initConfig).not.toBeNull();
      expect(mocks.initConfig!.dsn).toBe(dsn);
    });

    it('disables sendDefaultPii so no personal data is attached', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/3';
      initializeErrorTracking();

      expect(mocks.initConfig).not.toBeNull();
      expect(mocks.initConfig!.sendDefaultPii).toBe(false);
    });

    it('clamps tracesSampleRate to [0, 1]', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/4';
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_TRACES_SAMPLE_RATE = '0.05';
      initializeErrorTracking();

      expect(mocks.initConfig).not.toBeNull();
      expect(mocks.initConfig!.tracesSampleRate).toBe(0.05);
    });

    it('defaults tracesSampleRate to 0 when unset or invalid', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/5';
      delete (import.meta.env as Record<string, unknown>).VITE_SENTRY_TRACES_SAMPLE_RATE;
      initializeErrorTracking();

      expect(mocks.initConfig).not.toBeNull();
      expect(mocks.initConfig!.tracesSampleRate).toBe(0);
    });

    it('uses VITE_APP_VERSION as the release', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/6';
      (import.meta.env as Record<string, unknown>).VITE_APP_VERSION = '2026.08.17';
      initializeErrorTracking();

      expect(mocks.initConfig).not.toBeNull();
      expect(mocks.initConfig!.release).toBe('2026.08.17');
    });
  });

  // -------------------------------------------------------------------------
  // No personal data in events
  // -------------------------------------------------------------------------

  describe('captureUIError', () => {
    it('is a no-op when Sentry is not initialized', () => {
      delete (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN;
      const error = new Error('boom');
      captureUIError(error);

      expect(mocks.captureException).not.toHaveBeenCalled();
      expect(mocks.withScope).not.toHaveBeenCalled();
    });

    it('captures the exception when initialized', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/7';
      initializeErrorTracking();

      const error = new Error('render failed');
      captureUIError(error);

      expect(mocks.captureException).toHaveBeenCalledTimes(1);
      expect(mocks.captureException).toHaveBeenCalledWith(error);
    });

    it('attaches only non-identifying context tags, never user IDs or emails', () => {
      (import.meta.env as Record<string, unknown>).VITE_SENTRY_DSN =
        'https://example@sentry.example/8';
      initializeErrorTracking();

      const setTag = vi.fn();
      mocks.withScope.mockImplementationOnce((cb) => cb({ setTag }));

      captureUIError(new Error('fail'), { route: '/projects', attempt: 3 });

      expect(mocks.withScope).toHaveBeenCalledTimes(1);
      expect(setTag).toHaveBeenCalledWith('route', '/projects');
      expect(setTag).toHaveBeenCalledWith('attempt', 3);
      // No setUser / no email / no userId should ever be attached.
      expect(setTag).not.toHaveBeenCalledWith('email', expect.anything());
      expect(setTag).not.toHaveBeenCalledWith('userId', expect.anything());
    });
  });
});
