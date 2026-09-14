import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { cpus, totalmem } from "node:os";
import { createSoakModelServer } from "./soak/model-server.ts";
import { prepareSoak } from "./soak/prepare.ts";
import { soakEnvironment } from "./soak/environment.ts";
import {
  assertSoakTurnNotFailed,
  soakReadClient,
  verifySoakTurn,
} from "./soak/turn-evidence.ts";
import {
  assertSoakFreeSpace,
  measureSoakDisk,
  readSoakRuntimeMetrics,
  soakJournal,
  MAX_SOAK_DISK_BYTES,
  MIN_FREE_DISK_BYTES,
} from "./soak/observations.ts";
import type { SoakDesktopState } from "./soak/protocol.ts";
import { acquireSoakLease } from "./soak/lease.ts";
import { soakPrompt, SOAK_TOOL_STEPS } from "./soak/tool-fixture.ts";
import { verifySoakToolReceipts } from "./soak/tool-evidence.ts";
import { createSoakTrend } from "./soak/trend.ts";
import {
  RENDERER_HEAP_SNAPSHOT_BYTES,
  RENDERER_HEAP_DEADLINE_MS,
  RENDERER_HEAP_WARM_TURNS,
} from "./soak/renderer-heap.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const durationSeconds = Number(process.argv[2] ?? "60");
const profile = process.argv[3] ?? "baseline";
const rendererHeap = process.argv[4] === "--renderer-heap";
if (
  process.argv.length > 5 ||
  (process.argv[4] !== undefined && !rendererHeap) ||
  (rendererHeap && (durationSeconds < 300 || durationSeconds > 3600)) ||
  !Number.isSafeInteger(durationSeconds) ||
  durationSeconds < 30 ||
  durationSeconds > 604800 ||
  !["baseline", "recovery", "tools"].includes(profile)
)
  throw new Error("soak_arguments_invalid");
if (process.platform === "win32")
  throw new Error("soak_process_tree_cleanup_not_supported_on_windows");
const output = join(repository, ".crewon/soak-runs");
mkdirSync(output, { recursive: true });
assertSoakFreeSpace(output);
const retainedHistory = await measureSoakDisk(output);
if (
  Math.max(retainedHistory.logicalBytes, retainedHistory.allocatedBytes) >
  1024 ** 3
)
  throw new Error("soak_retained_history_guard");
const root = mkdtempSync(join(output, "run-"));
const token = randomBytes(32).toString("hex");
const journal = soakJournal(root, "observations"),
  turns = soakJournal(root, "turns");
const trend = createSoakTrend(root);
const releaseLease = acquireSoakLease(output, root);
const provider = await createSoakModelServer({
  faultEvery: profile === "recovery" ? 17 : undefined,
}).catch((error) => {
  releaseLease();
  throw error;
});
const stop = new AbortController();
const onSignal = () => stop.abort(new Error("soak_interrupted"));
process.once("SIGTERM", onSignal);
process.once("SIGINT", onSignal);
let child: ReturnType<typeof spawn> | null = null;
let endpoint: string | null = null,
  spawnError: Error | null = null;
let submitted = 0,
  completed = 0,
  samples = 0,
  maxSampleGapMs = 0,
  lastSampleAt = 0,
  peakObservedRssBytes = 0;
let latest: unknown = null;
let observationOrigin: number | null = null;
let desktopExit: {
  observedAt: string;
  code: number | null;
  signal: NodeJS.Signals | null;
} | null = null;
const state = (value: unknown) => {
  writeFileSync(join(root, "status.json.tmp"), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
  renameSync(join(root, "status.json.tmp"), join(root, "status.json"));
};
const summary = () => ({
  profile,
  desktopExit,
  submitted,
  completed,
  samples,
  maxSampleGapMs,
  peakObservedRssBytes,
  journal: journal.snapshot(),
  turns: turns.snapshot(),
  trend: trend.snapshot(),
  provider: provider.snapshot(),
  latest,
});
process.stdout.write(`SOAK_DIRECTORY=${root}\n`);
const control = async <T = unknown>(
  action: string,
  input = {},
  cleanup = false,
): Promise<T> => {
  if (!endpoint) throw new Error("soak_not_ready");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, ...input }),
    signal: cleanup
      ? AbortSignal.timeout(2000)
      : AbortSignal.any([stop.signal, AbortSignal.timeout(15000)]),
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (!response.body) throw new Error("soak_control_body_missing");
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 128 * 1024) throw new Error("soak_control_body_guard");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok)
    throw new Error(
      `soak_control_${response.status}: ${JSON.stringify(value).slice(0, 500)}`,
    );
  return value as T;
};
const checkAlive = () => {
  stop.signal.throwIfAborted();
  if (spawnError) throw spawnError;
  if (child && (child.exitCode !== null || child.signalCode !== null))
    throw new Error("soak_desktop_exited");
};
const pause = async (milliseconds: number) => {
  await delay(milliseconds, undefined, { signal: stop.signal });
  checkAlive();
};
const record = async () => {
  checkAlive();
  const before = performance.now();
  const desktop = await control<SoakDesktopState>("state");
  const uiProbeMs = performance.now() - before;
  const runtime = await readSoakRuntimeMetrics(root);
  if (
    !["worker", "control", "electron"].every((role) =>
      runtime.some((metric) => metric.role === role),
    )
  )
    throw new Error("soak_runtime_metrics_missing");
  const now = Date.now();
  if (runtime.some((metric) => now - Date.parse(metric.sampledAt) > 90_000))
    throw new Error("soak_runtime_metrics_stale");
  assertSoakFreeSpace(root);
  const disk = await measureSoakDisk(root);
  const harness = process.memoryUsage();
  const observedRssBytes =
    desktop.processes.reduce(
      (sum, entry) => sum + entry.memory.workingSetSize * 1024,
      0,
    ) +
    runtime
      .filter((entry) => entry.role !== "electron")
      .reduce((sum, entry) => sum + entry.memory.rss, 0) +
    harness.rss;
  peakObservedRssBytes = Math.max(peakObservedRssBytes, observedRssBytes);
  if (observedRssBytes > Math.min(4 * 1024 ** 3, totalmem() / 4))
    throw new Error("soak_memory_capacity_guard");
  const gapMs = lastSampleAt ? now - lastSampleAt : null;
  if (gapMs !== null) maxSampleGapMs = Math.max(maxSampleGapMs, gapMs);
  lastSampleAt = now;
  samples++;
  latest = {
    sampledAt: new Date(now).toISOString(),
    gapMs,
    uiProbeMs,
    desktop,
    runtime,
    disk,
    observedRssBytes,
    harness,
  };
  const providerTotals = provider.snapshot();
  const worker = runtime.find((entry) => entry.role === "worker")!;
  const controlRuntime = runtime.find((entry) => entry.role === "control")!;
  const main = runtime.find((entry) => entry.role === "electron")!;
  const tick = performance.now();
  observationOrigin ??= tick;
  trend.observe({
    elapsedMs: tick - observationOrigin,
    sampledAt: new Date(now).toISOString(),
    metrics: {
      observedRssBytes,
      uiProbeMs,
      domNodes: desktop.renderer.nodes,
      rendererHeap: desktop.renderer.heap?.used ?? null,
      controlRss: controlRuntime.memory.rss,
      controlHeap: controlRuntime.memory.heapUsed,
      workerRss: worker.memory.rss,
      workerHeap: worker.memory.heapUsed,
      mainRss: main.memory.rss,
      mainHeap: main.memory.heapUsed,
      harnessRss: harness.rss,
      harnessHeap: harness.heapUsed,
      logicalBytes: disk.logicalBytes,
      allocatedBytes: disk.allocatedBytes,
      sqliteBytes: disk.categories.sqlite ?? 0,
      walBytes: disk.categories.wal ?? 0,
      freeDiskBytes: disk.availableBytes,
      generations: providerTotals.generations,
      retrievals: providerTotals.retrievals,
      inputBytes: providerTotals.inputBytes,
      outputBytes: providerTotals.outputBytes,
      completed,
      submitted,
      prefixComparisons: providerTotals.prefixes.comparisons,
      matchingPrefixes: providerTotals.prefixes.matchingPrefixes,
      configurationChanges: providerTotals.prefixes.configurationChanges,
      toolCallResponses: providerTotals.toolCallResponses,
      compactionResponses: providerTotals.compactionResponses,
      wallSampleGapMs: gapMs,
      mainEventLoopP99Ms: main.eventLoopP99Ms,
      controlEventLoopP99Ms: controlRuntime.eventLoopP99Ms,
      workerEventLoopP99Ms: worker.eventLoopP99Ms,
    },
  });
  journal.append(summary());
};
try {
  state({ phase: "building", root });
  const build = await prepareSoak(root, repository, provider.origin);
  checkAlive();
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        profile,
        syntheticModel: true,
        syntheticAccount: true,
        requestedDurationSeconds: durationSeconds,
        diagnostics: rendererHeap
          ? {
              rendererHeap: {
                explicitGc: true,
                checkpoints: [`after-${RENDERER_HEAP_WARM_TURNS}-turns`, "end"],
                maxSnapshots: 2,
                maxSnapshotBytes: RENDERER_HEAP_SNAPSHOT_BYTES,
                deadlineMs: RENDERER_HEAP_DEADLINE_MS,
              },
              naturalGcEndurance: false,
            }
          : { rendererHeap: false, naturalGcEndurance: true },
        workload: {
          concurrentRuns: 1,
          threads: 1,
          submitIntervalMs: 5000,
          transport: "product-default",
          faultEvery: profile === "recovery" ? 17 : null,
          restartPolicy: "fail-without-restart",
          tools:
            profile === "tools"
              ? { kind: "real-mcp-fixture-read", stepsPerTurn: SOAK_TOOL_STEPS }
              : false,
          interaction: "DOM events through actual React forms",
        },
        guards: {
          diskBytes: MAX_SOAK_DISK_BYTES,
          freeDiskBytes: MIN_FREE_DISK_BYTES,
          observedRssBytes: Math.min(4 * 1024 ** 3, totalmem() / 4),
        },
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryBytes: totalmem(),
        cpu: cpus()[0]?.model,
        build,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const environment = soakEnvironment();
  Object.assign(environment, {
    CREWON_SOAK_ROOT: root,
    CREWON_SOAK_CONTROL_TOKEN: token,
    CREWON_SOAK_RENDERER_HEAP: rendererHeap ? "1" : "0",
    CREWON_SOAK_MODEL_KEY: "synthetic-local-only-never-a-real-provider-key",
    CREWON_REPOSITORY_ROOT: build.frozen,
    CREWON_DESKTOP_WORKSPACE_ROOT: join(root, "workspace"),
    CREWON_SOAK_METRICS_ROOT: join(root, "metrics"),
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, "runtime-metrics.mjs")).href}`,
  });
  state({ phase: "starting", root });
  child = spawn(
    createRequire(import.meta.url)("electron") as string,
    [join(root, "electron-entry.mjs")],
    {
      cwd: build.frozen,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (code, signal) => {
    desktopExit = { observedAt: new Date().toISOString(), code, signal };
  });
  let logBytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      if (logBytes + chunk.length > 1024 * 1024) {
        writeFileSync(join(root, "desktop.log"), "", { mode: 0o600 });
        logBytes = 0;
      }
      appendFileSync(join(root, "desktop.log"), chunk.subarray(0, 65536), {
        mode: 0o600,
      });
      logBytes += Math.min(chunk.length, 65536);
    });
  const startup = Date.now();
  while (!existsSync(join(root, "controller.json"))) {
    checkAlive();
    if (Date.now() - startup > 90000) throw new Error("soak_startup_timeout");
    await pause(250);
  }
  const controller = JSON.parse(
    readFileSync(join(root, "controller.json"), "utf8"),
  );
  if (
    controller.pid !== child.pid ||
    typeof controller.origin !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(controller.origin)
  )
    throw new Error("soak_controller_identity_invalid");
  endpoint = controller.origin;
  let snapshot: SoakDesktopState | null = null,
    loginSubmitted = false;
  while (Date.now() - startup < 90000) {
    try {
      snapshot = await control<SoakDesktopState>("state");
      if (snapshot.renderer.composer) break;
      if (snapshot.renderer.login && !loginSubmitted) {
        await control("login");
        loginSubmitted = true;
      }
    } catch {
      checkAlive();
    }
    await pause(500);
  }
  if (!snapshot?.renderer.composer) throw new Error("soak_composer_not_ready");
  await control("hide");
  const client = soakReadClient(await control("session"));
  await record();
  const started = Date.now();
  const heapCheckpoints: unknown[] = [];
  const heapCheckpoint = async (label: "warm" | "final") => {
    checkAlive();
    const result = await control("rendererHeap", { label });
    heapCheckpoints.push({
      completedTurns: completed,
      elapsedSeconds: (Date.now() - started) / 1000,
      result,
    });
    writeFileSync(
      join(root, "renderer-heap.json"),
      JSON.stringify(
        { explicitGc: true, checkpoints: heapCheckpoints },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  };
  while (Date.now() - started < durationSeconds * 1000) {
    const marker = `SOAK-${profile === "tools" ? "tool-" : ""}${++submitted}`,
      turnStarted = Date.now();
    await control("submit", {
      text: soakPrompt(marker),
    });
    const deadline = Date.now() + 30000;
    let acknowledged = false,
      nextFailureCheck = Date.now() + 3000;
    while (Date.now() < deadline) {
      await pause(500);
      const ack = await control<{ ack: boolean }>("ack", { text: marker });
      if (ack.ack && provider.snapshot().active === 0) {
        acknowledged = true;
        break;
      }
      if (Date.now() >= nextFailureCheck) {
        snapshot = await control<SoakDesktopState>("state");
        const selected = snapshot.renderer.threads.find(
          (thread) => thread.selected,
        );
        if (selected)
          await assertSoakTurnNotFailed(client, selected.id, marker);
        nextFailureCheck = Date.now() + 3000;
      }
    }
    if (!acknowledged) throw new Error("soak_turn_timeout");
    snapshot = await control<SoakDesktopState>("state");
    const selected = snapshot.renderer.threads.find(
      (thread) => thread.selected,
    );
    if (!selected) throw new Error("soak_selected_thread_missing");
    let evidence: Awaited<ReturnType<typeof verifySoakTurn>> | null = null;
    while (!evidence) {
      try {
        evidence = await verifySoakTurn(client, selected.id, marker);
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await pause(250);
      }
    }
    const toolReceipts =
      profile === "tools"
        ? verifySoakToolReceipts(root, evidence.runId, marker)
        : null;
    completed++;
    turns.append({
      completedAt: new Date().toISOString(),
      marker,
      latencyMs: Date.now() - turnStarted,
      ...evidence,
      toolReceipts,
    });
    if (rendererHeap && completed === RENDERER_HEAP_WARM_TURNS)
      await heapCheckpoint("warm");
    if (Date.now() - lastSampleAt >= 30000) await record();
    state({
      phase: "running",
      pid: child.pid,
      startedAt: new Date(started).toISOString(),
      elapsedSeconds: (Date.now() - started) / 1000,
      ...summary(),
    });
    await pause(
      Math.max(
        0,
        Math.min(5000, started + durationSeconds * 1000 - Date.now()),
      ),
    );
  }
  if (rendererHeap) {
    if (completed <= RENDERER_HEAP_WARM_TURNS)
      throw new Error("soak_heap_insufficient_completed_turns");
    await heapCheckpoint("final");
  }
  await record();
  state({
    phase: "durationReached",
    acceptance: "notEvaluated",
    startedAt: new Date(started).toISOString(),
    elapsedSeconds: (Date.now() - started) / 1000,
    ...summary(),
  });
} catch (error) {
  if (endpoint && !stop.signal.aborted)
    await control("screenshot", {}, true).catch(() => {});
  state({
    phase: "failed",
    failedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : "soak_failed",
    ...summary(),
  });
  process.exitCode = 1;
} finally {
  if (endpoint) await control("shutdown", {}, true).catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => child!.once("exit", () => resolve())),
      delay(5000),
    ]);
  }
  let ownedGroupGone = child?.pid === undefined;
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* owned group already gone */
    }
    await delay(1000);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* owned group already gone */
    }
    await delay(250);
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      ownedGroupGone = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  await provider.close();
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  writeFileSync(
    join(root, "cleanup.json"),
    JSON.stringify({
      completedAt: new Date().toISOString(),
      desktopExitCode: child?.exitCode,
      desktopSignal: child?.signalCode,
      desktopExit,
      ownedGroupGone,
    }),
    { mode: 0o600 },
  );
  if (!ownedGroupGone) {
    state({
      phase: "failed",
      error: "soak_process_group_cleanup_unconfirmed",
      ...summary(),
    });
    process.exitCode = 1;
  } else releaseLease();
}
process.stdout.write(`SOAK_STATUS=${join(root, "status.json")}\n`);
