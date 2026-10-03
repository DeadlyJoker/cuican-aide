import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstalledBusinessPluginExamples } from "../../../scripts/build-installed-business-plugin-example.mjs";

assert.equal(
  process.versions.node.split(".")[0],
  "24",
  "Use the repository's Node.js 24 toolchain",
);
assert.ok(
  process.env.CREWON_TEST_POSTGRES_URL?.trim(),
  "Set CREWON_TEST_POSTGRES_URL to an isolated test PostgreSQL database",
);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ownedRoot = await mkdtemp(join(tmpdir(), "crewon-full-app-acceptance-"));
let child;
let childClosed = false;
let completion;
let interrupted;

function stop(signal) {
  interrupted = signal;
  if (!child?.pid || childClosed) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
const interrupt = () => stop("SIGINT");
const terminate = () => stop("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);

try {
  // No test consumer is running while the actual UI and single public SDK producer build.
  execFileSync("pnpm", ["--filter", "@crewon/ui", "build"], {
    cwd: repository,
    stdio: "inherit",
    timeout: 120000,
  });
  const examples = await buildInstalledBusinessPluginExamples(ownedRoot);
  assert.equal(examples.developmentRemoved, true);
  for (const directory of [examples.v1Directory, examples.v2Directory]) {
    await access(join(directory, "crewon.plugin.json"));
    await access(join(directory, "ui.mjs"));
    await access(join(directory, "node.mjs"));
  }
  const roots = await readdir(ownedRoot);
  assert.ok(!roots.includes("development") && !roots.includes("sdk"));
  if (interrupted) throw new Error("installed_plugin_full_app_interrupted");
  child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--test",
      "apps/control-api/src/installed-plugin-full-app.browser.integration.test.ts",
    ],
    {
      cwd: repository,
      detached: process.platform !== "win32",
      stdio: "inherit",
      env: {
        ...process.env,
        CREWON_TEST_BUSINESS_PLUGIN_V1_DIR: examples.v1Directory,
        CREWON_TEST_BUSINESS_PLUGIN_V2_DIR: examples.v2Directory,
      },
    },
  );
  let spawnError;
  completion = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    // Artifact cleanup follows physical process and stdio closure.
    child.once("close", (code, signal) => {
      childClosed = true;
      resolve({ code, signal });
    });
  });
  const result = await completion;
  if (spawnError) throw spawnError;
  process.exitCode = result.code ?? (result.signal || interrupted ? 1 : 0);
} finally {
  if (child && !childClosed) stop("SIGTERM");
  if (completion) await completion;
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  await rm(ownedRoot, { recursive: true });
}
