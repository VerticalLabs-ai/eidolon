/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_ENABLE_WEBSOCKET?: string;
  // ─── UI Sentry error tracking (optional) ──────────────────────────────
  // DSN for the UI Sentry project. Error tracking stays disabled when unset.
  readonly VITE_SENTRY_DSN?: string;
  // Optional Sentry environment label (defaults to import.meta.env.MODE).
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  // Optional transaction sample rate, 0 to 1. Defaults to 0.
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
