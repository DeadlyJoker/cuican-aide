import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildInstalledBusinessPluginExamples } from "../../../scripts/build-installed-business-plugin-example.mjs";

assert.equal(
  process.versions.node.split(".")[0],
  "24",
  "Use the repository's Node.js 24 toolchain",
);
const app = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ownedRoot = await mkdtemp(
  join(tmpdir(), "crewon-native-configuration-acceptance-"),
);
let child;
let childClosed = false;
let completion;
let interrupted;
let cleanupSafe = true;
let notifyInterruption;
const interruption = new Promise((resolve) => {
  notifyInterruption = resolve;
});
const execute = promisify(execFile);

function stop(signal) {
  interrupted = signal;
  notifyInterruption();
  signalConsumer(signal);
}
function signalConsumer(signal) {
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
  // Serial producers complete before the actual file App and its Control children start.
  for (const script of [
    "build",
    "desktop:runtime:stage",
    "desktop:host:build",
  ]) {
    execFileSync("pnpm", ["--filter", "@crewon/ui", script], {
      cwd: repository,
      stdio: "inherit",
      timeout: 120000,
    });
  }
  const examples = await buildInstalledBusinessPluginExamples(ownedRoot);
  assert.equal(examples.developmentRemoved, true);
  await access(join(examples.v1Directory, "crewon.plugin.json"));
  await access(join(examples.v1Directory, "business.json"));
  await access(join(examples.v1Directory, "node.mjs"));
  const roots = await readdir(ownedRoot);
  assert.ok(!roots.includes("development") && !roots.includes("sdk"));
  if (interrupted)
    throw new Error("installed_plugin_native_configuration_interrupted");
  child = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "electron/desktopPluginConfigurationApp.integration.test.ts",
    ],
    {
      cwd: app,
      detached: process.platform !== "win32",
      stdio: "inherit",
      env: {
        ...process.env,
        CREWON_TEST_PROFESSIONAL_PLUGIN_V1_DIR: examples.v1Directory,
      },
    },
  );
  cleanupSafe = false;
  let spawnError;
  completion = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      childClosed = true;
      resolve({ code, signal });
    });
  });
  const result = await waitBounded(
    Promise.race([
      completion,
      interruption.then(() => {
        throw new Error("installed_plugin_native_configuration_interrupted");
      }),
    ]),
    180000,
    "installed_plugin_native_configuration_consumer_timeout",
  );
  if (spawnError) throw spawnError;
  process.exitCode = result.code ?? (result.signal || interrupted ? 1 : 0);
} finally {
  try {
    if (child) {
      if (!childClosed) signalConsumer("SIGTERM");
      const forced = await retireConsumerGroup();
      if (completion)
        await waitBounded(
          completion,
          5000,
          "installed_plugin_native_configuration_consumer_close_timeout",
        );
      cleanupSafe = childClosed;
      if (forced.length > 0)
        throw new Error(
          "installed_plugin_native_configuration_consumer_required_kill:" +
            forced.join(","),
        );
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (cleanupSafe) {
      await rm(ownedRoot, { recursive: true });
    } else {
      console.error(
        "installed_plugin_native_configuration_unretired_artifacts_retained:" +
          ownedRoot,
      );
    }
  }
}

async function consumerGroupMembers() {
  if (!child?.pid) return new Map();
  if (process.platform === "win32")
    throw new Error(
      "installed_plugin_native_configuration_group_retirement_requires_unix",
    );
  const { stdout } = await execute("ps", ["-axo", "pid=,pgid=,lstart="], {
    maxBuffer: 1024 * 1024,
    timeout: 2000,
  });
  const members = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (match && Number(match[2]) === child.pid)
      members.set(Number(match[1]), match[3].trim());
  }
  return members;
}

async function waitForConsumerGroup(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const members = await consumerGroupMembers();
    if (members.size === 0 || Date.now() >= deadline) return members;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function retireConsumerGroup() {
  const remaining = await waitForConsumerGroup(1500);
  if (remaining.size === 0) return [];
  const current = await consumerGroupMembers();
  const forced = [];
  for (const [pid, started] of remaining) {
    // Never kill a recycled PID merely because it occupied this group previously.
    if (current.get(pid) !== started) continue;
    try {
      process.kill(pid, "SIGKILL");
      forced.push(pid);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const active = await waitForConsumerGroup(5000);
  if (active.size > 0)
    throw new Error(
      "installed_plugin_native_configuration_group_retirement_timeout:" +
        [...active.keys()].join(","),
    );
  return forced;
}

async function waitBounded(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
