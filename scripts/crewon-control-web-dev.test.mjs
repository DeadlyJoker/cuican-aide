import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createControlDevEnvironment,
  developmentConfiguredModelId,
  defaultControlDataDirectory,
  developmentAgentVersionId,
  developmentExtensionsEnabled,
  developmentRuntimeWorkerCount,
  developmentRuntimeWorkerEnvironment,
  responsesEndpoint,
  spawnDevelopmentChild,
  stopDevelopmentChildren,
  superviseDevelopmentChildren,
  waitDevelopmentChildExit,
  waitForDevelopmentExtensionHost,
  withDevelopmentChildLifecycle,
} from "./crewon-control-web-dev.mjs";

test("uses the existing desktop development data directory on macOS", () => {
  assert.equal(
    defaultControlDataDirectory("darwin", "/Users/test"),
    "/Users/test/Library/Application Support/ai.crewon.desktop.dev/control-runtime-v0",
  );
});

test("plugin opt-in requires a single Worker while the disabled topology stays unchanged", () => {
  assert.equal(developmentExtensionsEnabled({}, 8), false);
  assert.equal(
    developmentExtensionsEnabled({ CREWON_EXTENSIONS_ENABLED: "0" }, 2),
    false,
  );
  assert.equal(
    developmentExtensionsEnabled({ CREWON_EXTENSIONS_ENABLED: "1" }, 1),
    true,
  );
  assert.throws(
    () => developmentExtensionsEnabled({ CREWON_EXTENSIONS_ENABLED: "1" }, 2),
    /development_extensions_require_single_worker/u,
  );
  for (const flag of ["", "true", "yes", " 1 "]) {
    assert.throws(
      () =>
        developmentExtensionsEnabled({ CREWON_EXTENSIONS_ENABLED: flag }, 1),
      /CREWON_EXTENSIONS_ENABLED_invalid/u,
    );
  }
});

function fakeWorker() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("waits for an actual split ready line and discovers a port-zero listener", async () => {
  const child = fakeWorker();
  const environment = {
    CREWON_EXTENSION_HOST_PORT: "0",
    CREWON_EXTENSION_HOST_ORIGIN: "http://127.0.0.1:3212",
  };
  const ready = waitForDevelopmentExtensionHost({ child, environment });
  child.stdout.write(
    "CrewON Runtime Worker started\nCrewON Extension Host ori",
  );
  child.stdout.write("gin http://127.0.0.1:49221\r\n");
  assert.equal(await ready, "http://127.0.0.1:49221");
  assert.equal(
    environment.CREWON_EXTENSION_HOST_ORIGIN,
    "http://127.0.0.1:3212",
  );
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stdout.listenerCount("end"), 0);
});

test("matches a configured fixed port and rejects substituted origins", async () => {
  const environment = {
    CREWON_EXTENSION_HOST_PORT: "3212",
    CREWON_EXTENSION_HOST_ORIGIN: "http://127.0.0.1:3212",
  };
  const child = fakeWorker();
  const ready = waitForDevelopmentExtensionHost({ child, environment });
  child.stdout.write("CrewON Extension Host origin http://127.0.0.1:3212\n");
  assert.equal(await ready, environment.CREWON_EXTENSION_HOST_ORIGIN);
  assert.throws(
    () =>
      waitForDevelopmentExtensionHost({
        child: fakeWorker(),
        environment: {
          ...environment,
          CREWON_EXTENSION_HOST_ORIGIN: "http://127.0.0.1:3213",
        },
      }),
    /development_extension_host_identity_invalid/u,
  );
  const substituted = fakeWorker();
  const rejection = assert.rejects(
    waitForDevelopmentExtensionHost({ child: substituted, environment }),
    /development_extension_host_identity_invalid/u,
  );
  substituted.stdout.write(
    "CrewON Extension Host origin http://127.0.0.1:3213\n",
  );
  await rejection;
});

test("rejects malformed listener identity without normalizing loopback aliases", async () => {
  for (const origin of [
    "http://localhost:3212",
    "http://127.1:3212",
    "http://2130706433:3212",
    "http://127.0.0.1:3212/",
    "http://127.0.0.1:3212/path",
    "https://127.0.0.1:3212",
    "http://owner@127.0.0.1:3212",
    "http://127.0.0.1:0",
    "http://127.0.0.1:3212?token=secret",
  ]) {
    const child = fakeWorker();
    const rejection = assert.rejects(
      waitForDevelopmentExtensionHost({
        child,
        environment: { CREWON_EXTENSION_HOST_PORT: "0" },
      }),
      /development_extension_host_identity_invalid/u,
    );
    child.stdout.write(`CrewON Extension Host origin ${origin}\n`);
    await rejection;
    assert.equal(child.listenerCount("exit"), 0);
  }
});

test("ready wait fails on exit, startup error, stdout end, deadline, cancellation and excess output", async () => {
  for (const [event, expected] of [
    ["exit", /exited_before_ready/u],
    ["error", /start_failed/u],
    ["end", /stdout_closed_before_ready/u],
  ]) {
    const child = fakeWorker();
    const rejection = assert.rejects(
      waitForDevelopmentExtensionHost({
        child,
        environment: { CREWON_EXTENSION_HOST_PORT: "0" },
      }),
      expected,
    );
    if (event === "end") child.stdout.end();
    else child.emit(event, new Error("private-peer-secret"));
    await rejection;
    assert.equal(child.listenerCount("exit"), 0);
  }
  const timed = fakeWorker();
  await assert.rejects(
    waitForDevelopmentExtensionHost({
      child: timed,
      environment: { CREWON_EXTENSION_HOST_PORT: "0" },
      deadlineMs: 10,
    }),
    /ready_timeout/u,
  );
  assert.equal(timed.stdout.listenerCount("data"), 0);
  const cancelled = fakeWorker();
  const controller = new AbortController();
  const cancellation = assert.rejects(
    waitForDevelopmentExtensionHost({
      child: cancelled,
      environment: { CREWON_EXTENSION_HOST_PORT: "0" },
      signal: controller.signal,
    }),
    /startup_cancelled/u,
  );
  controller.abort();
  await cancellation;
  const noisy = fakeWorker();
  const overflow = assert.rejects(
    waitForDevelopmentExtensionHost({
      child: noisy,
      environment: { CREWON_EXTENSION_HOST_PORT: "0" },
    }),
    /stdout_limit/u,
  );
  noisy.stdout.write(Buffer.alloc(128 * 1024 + 1, "a"));
  await overflow;
});

test("failed listener startup closes the already spawned clean Node child", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "process.stdout.write('CrewON Extension Host origin http://localhost:3212\\n'); setInterval(() => {}, 1000);",
    ],
    {
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const managed = [{ child, name: "extension startup fixture" }];
  t.after(() => stopDevelopmentChildren(managed));
  await assert.rejects(
    waitForDevelopmentExtensionHost({
      child,
      environment: { CREWON_EXTENSION_HOST_PORT: "0" },
      deadlineMs: 2000,
    }),
    /development_extension_host_identity_invalid/u,
  );
  await stopDevelopmentChildren(managed);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await stopDevelopmentChildren(managed);
});

test("supervision observes already completed children and failed spawns", async () => {
  const exited = fakeWorker();
  exited.pid = 123;
  exited.exitCode = 2;
  assert.deepEqual(
    await waitDevelopmentChildExit({ child: exited, name: "fast Worker" }),
    { code: 2, name: "fast Worker", signal: null },
  );
  const signalled = fakeWorker();
  signalled.pid = 124;
  signalled.signalCode = "SIGTERM";
  assert.deepEqual(
    await waitDevelopmentChildExit({
      child: signalled,
      name: "stopped Worker",
    }),
    { code: null, name: "stopped Worker", signal: "SIGTERM" },
  );
  assert.deepEqual(
    await waitDevelopmentChildExit({
      child: fakeWorker(),
      name: "failed Worker",
    }),
    { code: 1, name: "failed Worker", signal: null },
  );
  assert.equal(exited.listenerCount("exit"), 0);
});

test("supervision waits for future exit and removes completion listeners", async () => {
  const child = fakeWorker();
  child.pid = 125;
  const completion = waitDevelopmentChildExit({ child, name: "live Worker" });
  child.emit("exit", 0, null);
  assert.deepEqual(await completion, {
    code: 0,
    name: "live Worker",
    signal: null,
  });
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("supervision catches a real child that exits immediately after reporting ready", async (t) => {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "process.stdout.write('CrewON Extension Host origin http://127.0.0.1:49221\\n');",
    ],
    { env: {}, stdio: ["ignore", "pipe", "ignore"] },
  );
  const managed = { child, name: "fast ready Worker" };
  t.after(() => stopDevelopmentChildren([managed]));
  assert.equal(
    await waitForDevelopmentExtensionHost({
      child,
      environment: { CREWON_EXTENSION_HOST_PORT: "0" },
      deadlineMs: 2000,
    }),
    "http://127.0.0.1:49221",
  );
  // Force supervisor registration to happen after the real exit event.
  await waitDevelopmentChildExit(managed);
  assert.deepEqual(await waitDevelopmentChildExit(managed), {
    code: 0,
    name: managed.name,
    signal: null,
  });
});

test("builds a provider Responses endpoint without discarding the base path", () => {
  assert.equal(
    responsesEndpoint("https://provider.example/v1"),
    "https://provider.example/v1/responses",
  );
  assert.throws(
    () => responsesEndpoint("http://provider.example/v1"),
    /HTTPS or loopback HTTP/u,
  );
});

test("creates a workspace-free TypeScript runtime environment", () => {
  const environment = createControlDevEnvironment({
    agentVersionId: "agent-version-1",
    apiKey: "a".repeat(32),
    baseEnvironment: {
      CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH: "/private/bindings.json",
      CREWON_CONTROL_DATABASE_URL: "postgres://forbidden",
      CREWON_WORKSPACE_BINDING_ID: "workspace-1",
    },
    controlPort: 3210,
    csrfToken: "c".repeat(64),
    dataDirectory: "/runtime data",
    modelId: "gpt-5.5",
    probePort: 3211,
    probeToken: "p".repeat(64),
    providerBaseUrl: "https://provider.example/v1",
    providerId: "provider-1",
    runtimeGeneration: "runtime-1",
    sessionToken: "s".repeat(64),
    uiOrigin: "http://127.0.0.1:5175",
  });

  assert.deepEqual(
    {
      agentVersionId: environment.CREWON_AGENT_VERSION_ID,
      controlDatabase: environment.CREWON_CONTROL_DB_PATH,
      modelId: environment.CREWON_MODEL_ID,
      nativeWorkspace: environment.CREWON_NATIVE_WORKSPACE_READ_ENABLED,
      providerProbeOrigin: environment.CREWON_PROVIDER_PROBE_WORKER_ORIGIN,
      responsesEndpoint: environment.CREWON_RESPONSES_ENDPOINT,
      runtimeBindings:
        environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH ?? null,
      workspaceBinding: environment.CREWON_WORKSPACE_BINDING_ID ?? null,
    },
    {
      agentVersionId: "agent-version-1",
      controlDatabase: "/runtime data/control.sqlite",
      modelId: "gpt-5.5",
      nativeWorkspace: "0",
      providerProbeOrigin: "http://127.0.0.1:3211",
      responsesEndpoint: "https://provider.example/v1/responses",
      runtimeBindings: "/runtime data/agent-version-runtime-bindings.json",
      workspaceBinding: null,
    },
  );
});

test("versions the local AgentVersion identity with the runtime fingerprint", () => {
  assert.equal(
    developmentAgentVersionId("a".repeat(64)),
    "local-web-aaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.notEqual(
    developmentAgentVersionId("a".repeat(64)),
    developmentAgentVersionId("b".repeat(64)),
  );
  assert.throws(
    () => developmentAgentVersionId("not-a-fingerprint"),
    /fingerprint is invalid/u,
  );
});

test("keeps local runtime concurrency explicit and bounded", () => {
  assert.equal(developmentRuntimeWorkerCount(undefined), 1);
  assert.equal(developmentRuntimeWorkerCount(" 2 "), 2);
  for (const invalid of ["0", "9", "1.5", "many"]) {
    assert.throws(
      () => developmentRuntimeWorkerCount(invalid),
      /CREWON_CONTROL_DEV_RUNTIME_WORKER_COUNT_invalid/u,
    );
  }
});

test("gives each local worker a unique owner and only one probe listener", () => {
  const base = {
    CREWON_PROVIDER_PROBE_PORT: "3211",
    CREWON_PROVIDER_PROBE_TOKEN: "p".repeat(64),
    CREWON_PROVIDER_PROBE_PROVIDER_ID: "provider-1",
    CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID: "runtime-1",
    CREWON_PROVIDER_PROBE_ENDPOINT: "https://provider.example/v1",
    CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT: "CREWON_MODEL_API_KEY",
    CREWON_MODEL_API_KEY: "a".repeat(32),
  };
  const primary = developmentRuntimeWorkerEnvironment(base, 0);
  const secondary = developmentRuntimeWorkerEnvironment(base, 1);

  assert.equal(primary.CREWON_WORKER_OWNER_ID, "control-web-runtime-worker-1");
  assert.equal(primary.CREWON_PROVIDER_PROBE_PORT, "3211");
  assert.equal(
    secondary.CREWON_WORKER_OWNER_ID,
    "control-web-runtime-worker-2",
  );
  assert.equal(secondary.CREWON_PROVIDER_PROBE_PORT, undefined);
  assert.equal(secondary.CREWON_PROVIDER_PROBE_TOKEN, undefined);
  assert.equal(secondary.CREWON_PROVIDER_PROBE_ENDPOINT, undefined);
  assert.equal(secondary.CREWON_MODEL_API_KEY, base.CREWON_MODEL_API_KEY);
  assert.throws(
    () => developmentRuntimeWorkerEnvironment(base, -1),
    /development_runtime_worker_index_invalid/u,
  );
});

function listeningGrandchildCode({
  ignoreTermination = false,
  terminateAfterMs = 0,
} = {}) {
  return `
    import { createServer } from "node:net";
    ${ignoreTermination ? 'process.on("SIGTERM", () => {});' : ""}
    ${terminateAfterMs > 0 ? `process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${terminateAfterMs}));` : ""}
    const listener = createServer((socket) => socket.end());
    listener.listen(0, "127.0.0.1", () => {
      console.log(JSON.stringify({ pid: process.pid, port: listener.address().port }));
    });
  `;
}

function wrapperCode({
  exitAfterReady = false,
  ignoreTermination = false,
  terminateAfterMs = 0,
} = {}) {
  const grandchild = listeningGrandchildCode({
    ignoreTermination,
    terminateAfterMs,
  });
  return `
    import { spawn } from "node:child_process";
    const grandchild = spawn(process.execPath,
      ["--input-type=module", "--eval", ${JSON.stringify(grandchild)}],
      { env: {}, stdio: ["ignore", "pipe", "inherit"] });
    grandchild.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      ${exitAfterReady ? "process.exit(0);" : ""}
    });
    setInterval(() => {}, 1000);
  `;
}

function waitFixtureListener(child) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdout.off("data", received);
      child.off("exit", exited);
      child.off("error", failed);
      if (error) reject(error);
      else resolve(value);
    };
    const received = (chunk) => {
      buffered += chunk.toString();
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        try {
          finish(null, JSON.parse(buffered.slice(0, end)));
        } catch (error) {
          finish(error);
        }
      }
    };
    const exited = () => finish(new Error("fixture_exited_before_ready"));
    const failed = (error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("fixture_ready_timeout")),
      5000,
    );
    child.stdout.on("data", received);
    child.once("exit", exited);
    child.once("error", failed);
  });
}

function fixturePortAcceptsConnections(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("fixture_connection_timeout"));
    });
  });
}

async function fixtureListener(t) {
  const listener = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return listener.address().port;
}

// POSIX child groups include descendants. Windows deliberately retains direct-child cleanup.
test(
  "an unregistered process-group flag never grants permission to signal a group",
  { timeout: 8000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", listeningGrandchildCode()],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    const managed = { child, name: "unregistered flag", processGroup: true };
    t.after(() => stopDevelopmentChildren([managed], { graceMs: 75 }));
    const ready = await waitFixtureListener(child);
    await stopDevelopmentChildren([managed], { graceMs: 75 });
    assert.equal(await fixturePortAcceptsConnections(ready.port), false);
  },
);

test(
  "owned POSIX group cleanup kills a TERM-resistant grandchild without touching another listener",
  { skip: process.platform === "win32", timeout: 8000 },
  async (t) => {
    const unrelatedPort = await fixtureListener(t);
    const managed = spawnDevelopmentChild(
      "owned wrapper",
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        wrapperCode({ ignoreTermination: true }),
      ],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => stopDevelopmentChildren([managed], { graceMs: 75 }));
    const ready = await waitFixtureListener(managed.child);
    assert.equal(managed.processGroup, true);
    assert.equal(await fixturePortAcceptsConnections(ready.port), true);
    await stopDevelopmentChildren([managed], { graceMs: 75 });
    assert.equal(await fixturePortAcceptsConnections(ready.port), false);
    assert.equal(await fixturePortAcceptsConnections(unrelatedPort), true);
    // A second cleanup is safe even after the recorded group no longer exists.
    await stopDevelopmentChildren([managed], { graceMs: 75 });
  },
);

test(
  "owned POSIX descendants are cleaned even after the pnpm-like wrapper exited",
  { skip: process.platform === "win32", timeout: 8000 },
  async (t) => {
    const managed = spawnDevelopmentChild(
      "exited wrapper",
      process.execPath,
      ["--input-type=module", "--eval", wrapperCode({ exitAfterReady: true })],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => stopDevelopmentChildren([managed], { graceMs: 75 }));
    const ready = await waitFixtureListener(managed.child);
    assert.equal((await waitDevelopmentChildExit(managed)).code, 0);
    assert.equal(await fixturePortAcceptsConnections(ready.port), true);
    await stopDevelopmentChildren([managed], { graceMs: 75 });
    assert.equal(await fixturePortAcceptsConnections(ready.port), false);
  },
);

test(
  "repeated SIGTERM of the launcher waits for its owned service descendants to release their port",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const helper = new URL(
      "./crewon-development-processes.mjs",
      import.meta.url,
    ).href;
    const fixture = `
      import { spawnDevelopmentChild, superviseDevelopmentChildren } from ${JSON.stringify(helper)};
      const managed = spawnDevelopmentChild("service wrapper", process.execPath,
        ["--input-type=module", "--eval", ${JSON.stringify(wrapperCode({ terminateAfterMs: 150 }))}],
        { env: {}, stdio: ["ignore", "pipe", "ignore"] });
      managed.child.stdout.pipe(process.stdout, { end: false });
      await superviseDevelopmentChildren([managed]);
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", fixture],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    const launcher = { child, name: "test launcher" };
    t.after(() => stopDevelopmentChildren([launcher]));
    const ready = await waitFixtureListener(child);
    assert.equal(await fixturePortAcceptsConnections(ready.port), true);
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 25));
    child.kill("SIGTERM");
    assert.equal((await waitDevelopmentChildExit(launcher)).code, 0, errorText);
    assert.equal(await fixturePortAcceptsConnections(ready.port), false);
  },
);

test(
  "a service startup failure closes all owned listeners and unregisters signal handlers",
  { timeout: 8000 },
  async (t) => {
    const managed = spawnDevelopmentChild(
      "running service",
      process.execPath,
      ["--input-type=module", "--eval", listeningGrandchildCode()],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => stopDevelopmentChildren([managed], { graceMs: 75 }));
    const ready = await waitFixtureListener(managed.child);
    const failed = spawnDevelopmentChild(
      "failed service",
      process.execPath,
      ["--eval", "process.exit(2)"],
      { env: {}, stdio: "ignore" },
    );
    t.after(() => stopDevelopmentChildren([failed], { graceMs: 75 }));
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    await assert.rejects(
      superviseDevelopmentChildren([managed, failed]),
      /failed service exited unexpectedly \(2\)/u,
    );
    assert.deepEqual(
      [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
      before,
    );
    assert.equal(await fixturePortAcceptsConnections(ready.port), false);
  },
);

test(
  "repeated SIGTERM during startup readiness protects descendant cleanup",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const entry = new URL("./crewon-control-web-dev.mjs", import.meta.url).href;
    const fixture = `
      import { spawnDevelopmentChild, withDevelopmentChildLifecycle,
        waitForDevelopmentExtensionHost } from ${JSON.stringify(entry)};
      const children = [];
      try {
        await withDevelopmentChildLifecycle({ children, start: async ({ signal }) => {
          const managed = spawnDevelopmentChild("starting service", process.execPath,
            ["--input-type=module", "--eval", ${JSON.stringify(wrapperCode({ terminateAfterMs: 150 }))}],
            { env: {}, stdio: ["ignore", "pipe", "ignore"] });
          children.push(managed);
          managed.child.stdout.pipe(process.stdout, { end: false });
          await waitForDevelopmentExtensionHost({ child: managed.child,
            environment: { CREWON_EXTENSION_HOST_PORT: "0" }, signal, deadlineMs: 4000 });
        }});
      } catch (error) {
        if (error.message !== "development_extension_startup_cancelled") throw error;
      }
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", fixture],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    const launcher = { child, name: "starting test launcher" };
    t.after(() => stopDevelopmentChildren([launcher]));
    const ready = await waitFixtureListener(child);
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 25));
    child.kill("SIGTERM");
    assert.equal((await waitDevelopmentChildExit(launcher)).code, 0, errorText);
    assert.equal(await fixturePortAcceptsConnections(ready.port), false);
  },
);

test(
  "an already cancelled readiness handoff closes services without waiting for another signal",
  { timeout: 8000 },
  async (t) => {
    const managed = spawnDevelopmentChild(
      "cancelled handoff",
      process.execPath,
      ["--input-type=module", "--eval", listeningGrandchildCode()],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => stopDevelopmentChildren([managed], { graceMs: 75 }));
    const ready = await waitFixtureListener(managed.child);
    const controller = new AbortController();
    controller.abort();
    await superviseDevelopmentChildren([managed], {
      signal: controller.signal,
    });
    assert.equal(await fixturePortAcceptsConnections(ready.port), false);
  },
);

test(
  "partial startup cleanup preserves its failure and unregisters lifecycle handlers",
  { timeout: 8000 },
  async (t) => {
    const children = [];
    t.after(() => stopDevelopmentChildren(children, { graceMs: 75 }));
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    let port;
    const startupError = new Error("fixture_startup_failed");
    await assert.rejects(
      withDevelopmentChildLifecycle({
        children,
        start: async () => {
          const managed = spawnDevelopmentChild(
            "partial service",
            process.execPath,
            ["--input-type=module", "--eval", listeningGrandchildCode()],
            { env: {}, stdio: ["ignore", "pipe", "ignore"] },
          );
          children.push(managed);
          port = (await waitFixtureListener(managed.child)).port;
          throw startupError;
        },
      }),
      (error) => error === startupError,
    );
    assert.equal(await fixturePortAcceptsConnections(port), false);
    assert.deepEqual(
      [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
      before,
    );
  },
);

test(
  "the real Vite configuration fails on an occupied UI port without moving to another port",
  { timeout: 15000 },
  async (t) => {
    const occupiedPort = await fixtureListener(t);
    const uiRoot = fileURLToPath(
      new URL("../apps/crewon-ui/", import.meta.url),
    );
    const uiRequire = createRequire(
      new URL("../apps/crewon-ui/package.json", import.meta.url),
    );
    const viteCli = join(
      dirname(uiRequire.resolve("vite/package.json")),
      "bin",
      "vite.js",
    );
    const managed = spawnDevelopmentChild(
      "occupied Vite",
      process.execPath,
      [
        viteCli,
        "--host",
        "127.0.0.1",
        "--port",
        String(occupiedPort),
        "--mode",
        "test",
      ],
      { cwd: uiRoot, env: {}, stdio: ["ignore", "ignore", "pipe"] },
    );
    t.after(() => stopDevelopmentChildren([managed], { graceMs: 75 }));
    let errorText = "";
    managed.child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    const exit = await waitDevelopmentChildExit(managed);
    assert.equal(exit.code, 1);
    assert.match(
      errorText,
      new RegExp(`Port ${occupiedPort} is already in use`, "u"),
    );
    assert.equal(await fixturePortAcceptsConnections(occupiedPort), true);
  },
);

test("Web development uses the configured gateway selection without a retired hard-coded fallback", () => {
  assert.throws(
    () => developmentConfiguredModelId({}),
    /choose a current gateway model/,
  );
  assert.throws(
    () => developmentConfiguredModelId({ CREWON_MODEL_ID: "  " }),
    /required/,
  );
  assert.equal(
    developmentConfiguredModelId({
      CREWON_MODEL_ID: " gpt-6.1-sol ",
      CREWON_DESKTOP_DEV_PROVIDER_MODEL_ID: "gpt-6-astra",
    }),
    "gpt-6.1-sol",
  );
  assert.equal(
    developmentConfiguredModelId({
      CREWON_DESKTOP_DEV_PROVIDER_MODEL_ID: " gpt-6-astra ",
    }),
    "gpt-6-astra",
  );
});
