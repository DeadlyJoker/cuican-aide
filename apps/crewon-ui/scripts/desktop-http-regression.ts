import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { setTimeout as delay } from "node:timers/promises";
import { assertSoakFreeSpace, measureSoakDisk } from "./soak/observations.ts";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(ui, "../../.crewon/desktop-http-audit");
if (process.platform === "win32")
  throw new Error("desktop_http_fixture_process_groups_unsupported");
mkdirSync(output, { recursive: true });
assertSoakFreeSpace(output);
const history = await measureSoakDisk(output);
if (Math.max(history.logicalBytes, history.allocatedBytes) > 64 * 1024 * 1024)
  throw new Error("desktop_http_fixture_history_capacity");
const root = mkdtempSync(join(output, "native-"));
const require = createRequire(import.meta.url);
await Promise.all([
  build({
    entryPoints: [join(ui, "scripts/desktop-http-regression-entry.ts")],
    outfile: join(root, "main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron"],
  }),
  build({
    entryPoints: [join(ui, "electron/preload.ts")],
    outfile: join(root, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  }),
  build({
    stdin: {
      contents:
        'import { desktopBridgeFetch } from "./src/lib/desktop/desktopFetch"; import { ControlApiClient, streamRunEvents } from "@crewon/control-client"; Object.assign(globalThis,{fixtureFetch:desktopBridgeFetch,fixtureControlClient:ControlApiClient,fixtureRunEvents:streamRunEvents});',
      resolveDir: ui,
      loader: "ts",
    },
    outfile: join(root, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    define: { "import.meta.env": "{}" },
    target: "chrome120",
  }),
]);
writeFileSync(
  join(root, "index.html"),
  '<!doctype html><meta charset="utf-8"><title>Desktop HTTP regression fixture</title><script src="renderer.js"></script>',
);
const fixtureEnv: NodeJS.ProcessEnv = { CREWON_HTTP_FIXTURE_ROOT: root };
for (const key of [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
])
  if (process.env[key] !== undefined) fixtureEnv[key] = process.env[key];
const child = spawn(require("electron") as string, [join(root, "main.mjs")], {
  env: fixtureEnv,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let logBytes = 0;
for (const stream of [child.stdout!, child.stderr!])
  stream.on("data", (chunk: Buffer) => {
    logBytes += chunk.length;
    if (logBytes <= 64 * 1024) process.stderr.write(chunk);
  });
const timeout = setTimeout(() => {
  if (child.pid)
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
}, 30_000);
let code: number | null = null,
  ownedGroupGone = child.pid === undefined;
try {
  code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
} finally {
  clearTimeout(timeout);
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          ownedGroupGone = true;
          break;
        }
        throw error;
      }
      await delay(50);
    }
  }
  writeFileSync(
    join(root, "cleanup.json"),
    JSON.stringify({
      completedAt: new Date().toISOString(),
      pid: child.pid ?? null,
      exitCode: code,
      ownedGroupGone,
    }) + "\n",
  );
}
if (!ownedGroupGone)
  throw new Error(`desktop_http_fixture_group_remaining:${root}`);
if (code !== 0) throw new Error(`desktop_http_native_failed:${code}:${root}`);
process.stdout.write(readFileSync(join(root, "result.json"), "utf8"));
process.stdout.write(`HTTP_FIXTURE_DIRECTORY=${root}\n`);
