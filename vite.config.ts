import vinext from "vinext";
import { defineConfig } from "vite";

/**
 * The local D1 database Miniflare runs for `npm run dev` and the e2e harness.
 * The Worker reads it as `env.DB` (worker/chain.ts); the id is a placeholder
 * that only names the local state directory. Production binds its own D1
 * database to `DB` in the Cloudflare deployment configuration.
 */
const D1_BINDING = "DB";
const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [
    {
      binding: D1_BINDING,
      database_name: "do-not-feed-it",
      database_id: LOCAL_DATABASE_ID,
    },
  ],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  // Production builds opt in to a real Wrangler configuration. Without this,
  // keep the local placeholder binding used by practice and the e2e harness.
  const deploymentConfig = process.env.DNFI_WRANGLER_CONFIG?.trim();

  return {
    // The public URL the social card and canonical tags resolve against
    // (app/layout.tsx). Set DNFI_SITE_URL when building for deployment.
    define: { __DNFI_SITE_URL__: JSON.stringify(process.env.DNFI_SITE_URL?.trim() ?? "") },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        ...(deploymentConfig ? { configPath: deploymentConfig } : { config: localBindingConfig }),
      }),
    ],
  };
});
