import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createControlDevEnvironment,
  defaultControlDataDirectory,
  developmentAgentVersionId,
  developmentExtensionsEnabled,
  developmentRuntimeWorkerCount,
  developmentRuntimeWorkerEnvironment,
  responsesEndpoint,
  stopDevelopmentChildren,
  waitDevelopmentChildExit,
  waitForDevelopmentExtensionHost,
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
