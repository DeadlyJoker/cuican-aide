import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const app = fileURLToPath(new URL("../", import.meta.url));
const ownedRoot = await mkdtemp(
  join(tmpdir(), "crewon-ui-installed-task-context-"),
);
let child;
let childClosed = false;
let completion;
let interrupted;

function stop(signal) {
  interrupted = signal;
  if (!child?.pid || childClosed) return;
  try {
    // Own only this consumer's process group. Vitest workers must stop before their artifacts are removed.
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
  // This shared producer owns the single SDK pack/prepack, then builds with the public tarball.
  // It physically finishes and removes development projects/dependencies before the consumer starts.
  const examples = await buildInstalledBusinessPluginExamples(ownedRoot, {
    includeKrea: true,
  });
  assert.equal(examples.developmentRemoved, true);
  assert.equal(typeof examples.kreaV1Directory, "string");
  assert.ok(examples.kreaV1Directory.length > 0);
  await access(join(examples.kreaV1Directory, "crewon.plugin.json"));
  await access(join(examples.kreaV1Directory, "ui.mjs"));
  const roots = await readdir(ownedRoot);
  assert.ok(!roots.includes("development") && !roots.includes("sdk"));
  if (interrupted) throw new Error("installed_plugin_task_context_interrupted");
  child = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "src/components/plugins/InstalledPluginModuleTaskContext.integration.test.tsx",
    ],
    {
      cwd: app,
      detached: process.platform !== "win32",
      stdio: "inherit",
      env: {
        ...process.env,
        CREWON_TEST_KREA_PLUGIN_DIR: examples.kreaV1Directory,
      },
    },
  );
  let spawnError;
  completion = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    // `close` follows process termination and stdio closure, rather than only its exit notification.
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
  // The root is created by this invocation and never points at a user's installation or preview.
  await rm(ownedRoot, { recursive: true });
}
