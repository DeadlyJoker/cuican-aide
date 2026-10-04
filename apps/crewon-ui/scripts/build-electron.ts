import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { loadEnv } from "vite";
import { desktopAccountOriginForBuild } from "../electron/desktopAccountOrigin.ts";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(uiRoot, "dist-electron");
const environment = loadEnv("production", uiRoot, "");
const trustedAccountOrigin = desktopAccountOriginForBuild({
  baseUrl: environment.VITE_AGENT_PLATFORM_BASE_URL,
  apiBaseUrl: environment.VITE_AGENT_PLATFORM_API_BASE_URL,
  runtimeBaseUrl: environment.VITE_AGENT_PLATFORM_RUNTIME_BASE_URL,
  proxyTarget: environment.CREWON_AGENT_PLATFORM_TARGET,
});

await mkdir(outputRoot, { recursive: true });

await Promise.all([
  build({
    entryPoints: [resolve(uiRoot, "electron/runtimeLogWriter.ts")],
    outfile: resolve(outputRoot, "runtimeLogWriter.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
    legalComments: "none",
  }),
  build({
    entryPoints: [resolve(uiRoot, "electron/main.ts")],
    outfile: resolve(outputRoot, "main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron", "electron-updater"],
    define: {
      __CREWON_DESKTOP_TRUSTED_ACCOUNT_ORIGIN__:
        JSON.stringify(trustedAccountOrigin),
    },
    sourcemap: true,
    legalComments: "none",
  }),
  build({
    entryPoints: [resolve(uiRoot, "electron/preload.ts")],
    outfile: resolve(outputRoot, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: true,
    legalComments: "none",
  }),
]);

process.stdout.write(`Electron TypeScript host built in ${outputRoot}\n`);
