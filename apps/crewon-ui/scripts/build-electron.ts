import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(uiRoot, "dist-electron");

await mkdir(outputRoot, { recursive: true });

await Promise.all([
  build({
    entryPoints: [resolve(uiRoot, "electron/main.ts")],
    outfile: resolve(outputRoot, "main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron", "electron-updater"],
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
