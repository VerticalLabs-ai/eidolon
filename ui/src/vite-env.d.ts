/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_ENABLE_WEBSOCKET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
