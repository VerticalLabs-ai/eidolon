import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

/** CalVer (YYYY.M.D): env, newest git tag, or UTC calendar date — matches RELEASING.md / scripts/calver-next-tag.sh */
function getAppVersion(): string {
  const fromEnv = process.env.VITE_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const tag = execSync("git describe --tags --abbrev=0", {
      encoding: "utf8",
      cwd: repoRoot,
    }).trim();
    if (tag) return tag;
  } catch {
    /* not a git checkout or no tags */
  }
  const d = new Date();
  return `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
}

// Clerk ships the publishable key as NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY via the
// Vercel Marketplace integration. Re-expose it to Vite as VITE_CLERK_PUBLISHABLE_KEY
// so the browser bundle can read it via import.meta.env (Vite only inlines
// vars prefixed with VITE_).
const clerkPublishableKey =
  process.env.VITE_CLERK_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
  "";

export default defineConfig({
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(getAppVersion()),
    "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY":
      JSON.stringify(clerkPublishableKey),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3100",
        ws: true,
      },
    },
  },
});
