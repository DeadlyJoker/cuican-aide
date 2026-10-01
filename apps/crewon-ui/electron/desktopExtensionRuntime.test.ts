import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  challengeDesktopExtensionHost,
  clearDesktopExtensionEnvironment,
  DESKTOP_EXTENSION_CONFIGURATION_FILE,
  DESKTOP_RUNTIME_OWNER,
  desktopExtensionRuntimeEnvironments,
  loadDesktopExtensionRuntimeConfiguration,
  parseDesktopExtensionHostOrigin,
  parseDesktopExtensionRuntimeConfiguration,
  waitForDesktopExtensionHost,
  settleDesktopRuntimeChildren,
} from "./desktopExtensionRuntime.ts";
import { watchRuntimeChildren } from "./runtimeSupervisor.ts";

const schemaVersion = "crewon.desktop-extension-runtime.v0";
const metadata = {
  schemaVersion,
  enabled: true,
  runtimeBindingsPath: null,
  agentVersionAssetsPath: null,
};
const child = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as ChildProcess;

it("accepts only explicit disabled, metadata or a complete prepared pair and copies/freezes inputs", () => {
  expect(Object.isFrozen(DESKTOP_RUNTIME_OWNER)).toBe(true);
  const parsed = parseDesktopExtensionRuntimeConfiguration(metadata);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(parsed).not.toBe(metadata);
  expect(
    parseDesktopExtensionRuntimeConfiguration({
      schemaVersion,
      enabled: false,
    }),
  ).toEqual({ schemaVersion, enabled: false });
  expect(
    parseDesktopExtensionRuntimeConfiguration({
      ...metadata,
      runtimeBindingsPath: "/prepared/bindings.json",
      agentVersionAssetsPath: "/prepared/assets.json",
    }),
  ).toMatchObject({ enabled: true });
  for (const value of [
    null,
    { schemaVersion, enabled: "1" },
    { ...metadata, token: "secret" },
    { ...metadata, actorId: "other" },
    { ...metadata, runtimeBindingsPath: "/one" },
    {
      ...metadata,
      runtimeBindingsPath: "relative",
      agentVersionAssetsPath: "/two",
    },
    {
      ...metadata,
      runtimeBindingsPath: "/path\n",
      agentVersionAssetsPath: "/two",
    },
    Object.create(metadata),
    {
      ...metadata,
      get extra() {
        throw new Error("must-not-evaluate");
      },
    },
  ]) {
    expect(() => parseDesktopExtensionRuntimeConfiguration(value)).toThrow(
      "desktop_extension_runtime_configuration_invalid",
    );
  }
});

it("loads bounded regular configuration files and rejects symlinks and invalid UTF-8", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-desktop-extension-config-"),
  );
  const path = join(directory, DESKTOP_EXTENSION_CONFIGURATION_FILE);
  try {
    expect(loadDesktopExtensionRuntimeConfiguration(directory).enabled).toBe(
      false,
    );
    writeFileSync(path, JSON.stringify(metadata));
    expect(loadDesktopExtensionRuntimeConfiguration(directory)).toEqual(
      metadata,
    );
    writeFileSync(path, Buffer.from([0xff]));
    expect(() => loadDesktopExtensionRuntimeConfiguration(directory)).toThrow();
    writeFileSync(path, " ".repeat(16385));
    expect(() => loadDesktopExtensionRuntimeConfiguration(directory)).toThrow();
    rmSync(path);
    const target = join(directory, "target.json");
    writeFileSync(target, JSON.stringify(metadata));
    symlinkSync(target, path);
    expect(() => loadDesktopExtensionRuntimeConfiguration(directory)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("clears ambient plugin/bootstrap settings and partitions only fresh native private authority", () => {
  const ambient = {
    CREWON_EXTENSIONS_ENABLED: "1",
    CREWON_EXTENSIONS_UNKNOWN: "stale",
    CREWON_EXTENSION_FUTURE: "secret",
    CREWON_EXTENSION_HOST_TOKEN: "old",
    CREWON_EXTENSION_HOST_ORIGIN: "http://evil",
    CREWON_NATIVE_WORKSPACE_BOOTSTRAP: "1",
    CREWON_NATIVE_RUNTIME_BOOTSTRAP: "1",
    CREWON_AGENT_VERSION_ID: "default",
    CREWON_PRINCIPAL_ID: "other",
    CREWON_MODEL_ID: "model",
  };
  expect(clearDesktopExtensionEnvironment(ambient)).toEqual({
    CREWON_AGENT_VERSION_ID: "default",
    CREWON_PRINCIPAL_ID: "other",
    CREWON_MODEL_ID: "model",
  });
  const disabled = desktopExtensionRuntimeEnvironments({
    configuration: parseDesktopExtensionRuntimeConfiguration({
      schemaVersion,
      enabled: false,
    }),
    sharedEnvironment: ambient,
    workerEnvironment: ambient,
  });
  expect(disabled.enabled).toBe(false);
  expect(disabled.release.CREWON_EXTENSIONS_ENABLED).toBeUndefined();
  const prepared = parseDesktopExtensionRuntimeConfiguration({
    ...metadata,
    runtimeBindingsPath: "/prepared/bindings",
    agentVersionAssetsPath: "/prepared/assets",
  });
  const input = {
    configuration: prepared,
    sharedEnvironment: ambient,
    workerEnvironment: {
      ...ambient,
      CREWON_AGENT_PLATFORM_API_KEY: "worker-only",
    },
  };
  const a = desktopExtensionRuntimeEnvironments(input),
    b = desktopExtensionRuntimeEnvironments(input);
  expect(a.enabled && b.enabled && a.token !== b.token).toBe(true);
  expect(a.release.CREWON_EXTENSION_HOST_TOKEN).toBeUndefined();
  expect(a.release.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH).toBe(
    "/prepared/bindings",
  );
  expect(a.worker.CREWON_EXTENSION_HOST_PORT).toBe("0");
  expect(a.worker.CREWON_AGENT_PLATFORM_API_KEY).toBe("worker-only");
  const control = a.control("http://127.0.0.1:12345");
  expect(control.CREWON_EXTENSION_RUNTIME_BINDINGS_PATH).toBeUndefined();
  expect(control.CREWON_EXTENSION_HOST_PORT).toBeUndefined();
  expect(control.CREWON_AGENT_PLATFORM_API_KEY).toBeUndefined();
  expect(control.CREWON_PRINCIPAL_ID).toBe(DESKTOP_RUNTIME_OWNER.principalId);
  expect(control.CREWON_AGENT_VERSION_ID).toBe("default");
  expect(a.release.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT).toBeUndefined();
  const packaged = desktopExtensionRuntimeEnvironments({
    ...input,
    retainedBuild: { dataRoot: "/native-data" },
  });
  expect(packaged.release.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT).toBe(
    "/native-data",
  );
  expect(
    packaged.worker.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT,
  ).toBeUndefined();
  expect(
    packaged.control("http://127.0.0.1:12345")
      .CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT,
  ).toBeUndefined();
  const packagedDisabled = desktopExtensionRuntimeEnvironments({
    configuration: parseDesktopExtensionRuntimeConfiguration({
      schemaVersion,
      enabled: false,
    }),
    sharedEnvironment: ambient,
    workerEnvironment: ambient,
    retainedBuild: { dataRoot: "/native-data" },
  });
  expect(
    packagedDisabled.release.CREWON_EXTENSION_BUILD_ARCHIVE_DATA_ROOT,
  ).toBeUndefined();
});

it("accepts only a canonical literal loopback origin", () => {
  expect(parseDesktopExtensionHostOrigin("http://127.0.0.1:65535")).toBe(
    "http://127.0.0.1:65535",
  );
  for (const value of [
    "http://localhost:1234",
    "http://127.1:1234",
    "http://127.0.0.1:0",
    "http://127.0.0.1:0123",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:1234/",
    "http://user@127.0.0.1:1234",
    "https://127.0.0.1:1234",
  ])
    expect(() => parseDesktopExtensionHostOrigin(value)).toThrow();
});

it("bounds ready output and removes listeners on ready, malformed identity, exit, abort and timeout", async () => {
  const c = child();
  const signal = new AbortController();
  const pending = waitForDesktopExtensionHost(c, {
    signal: signal.signal,
    deadlineMs: 1000,
  });
  c.stdout!.emit(
    "data",
    Buffer.from(
      "CrewON Runtime Worker started\nCrewON Extension Host origin http://127.0.0.1:",
    ),
  );
  c.stdout!.emit("data", Buffer.from("12345\n"));
  expect(await pending).toBe("http://127.0.0.1:12345");
  expect(c.listenerCount("exit")).toBe(0);
  expect(c.stdout!.listenerCount("data")).toBe(0);
  for (const event of ["malformed", "output", "exit", "abort", "timeout"]) {
    const c = child(),
      a = new AbortController();
    const p = waitForDesktopExtensionHost(c, {
      signal: a.signal,
      deadlineMs: 1000,
    });
    const assertion = expect(p).rejects.toThrow();
    if (event === "malformed")
      c.stdout!.emit(
        "data",
        Buffer.from("CrewON Extension Host origin http://evil:1234\n"),
      );
    if (event === "output")
      c.stdout!.emit("data", Buffer.alloc(128 * 1024 + 1));
    if (event === "exit") c.emit("exit", 1, null);
    if (event === "abort") a.abort();
    await assertion;
    expect(c.listenerCount("exit")).toBe(0);
    expect(c.stdout!.listenerCount("data")).toBe(0);
  }
});

it("challenges the actual private peer token and strict complete owner echo with bounded response", async () => {
  let mode = "valid";
  let calls = 0;
  const token = "a".repeat(64);
  const server = createServer(async (req, res) => {
    calls++;
    expect(req.url).toBe("/private/v0/extensions");
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    expect(JSON.parse(raw)).toEqual({
      protocol: "crewon.extension-host-request.v0",
      operation: "catalog",
      actor: DESKTOP_RUNTIME_OWNER,
    });
    res.writeHead(mode === "401" ? 401 : 200, {
      "content-type": "application/json",
    });
    const actor = {
      ...DESKTOP_RUNTIME_OWNER,
      ...(mode === "owner" ? { principalId: "other" } : {}),
    };
    res.end(
      mode === "limit"
        ? " ".repeat(128 * 1024 + 1)
        : JSON.stringify({
            protocol:
              mode === "protocol"
                ? "other"
                : "crewon.extension-host-response.v0",
            operation: "catalog",
            actor,
            registrations: [],
            ...(mode === "extra" ? { extra: true } : {}),
          }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const input = {
    origin: `http://127.0.0.1:${address.port}`,
    token,
    signal: new AbortController().signal,
    deadlineMs: 1000,
  };
  try {
    await challengeDesktopExtensionHost(input);
    for (mode of ["401", "owner", "protocol", "extra", "limit"])
      await expect(challengeDesktopExtensionHost(input)).rejects.toThrow();
    expect(calls).toBe(6);
    await expect(
      challengeDesktopExtensionHost({ ...input, token: "short" }),
    ).rejects.toThrow("desktop_extension_host_token_invalid");
    expect(calls).toBe(6);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("observes children that exit before supervision attaches and removes all handlers on stop", async () => {
  const c = child();
  Object.assign(c, { exitCode: 1 });
  const callback = vi.fn();
  const stop = watchRuntimeChildren([{ child: c, name: "Worker" }], callback);
  await Promise.resolve();
  expect(callback).toHaveBeenCalledExactlyOnceWith({
    name: "Worker",
    code: 1,
    signal: null,
  });
  stop();
  expect(c.listenerCount("error")).toBe(0);
  expect(c.listenerCount("exit")).toBe(0);
});

it("attempts all child shutdowns after one failure and keeps live handles owned", async () => {
  const release = child(),
    worker = child(),
    control = child();
  const failure = new Error("runtime_child_shutdown_timeout");
  const attempts: ChildProcess[] = [];
  const result = await settleDesktopRuntimeChildren(
    [release, worker, control],
    async (current) => {
      attempts.push(current);
      if (current === release) throw failure;
      Object.assign(current, { signalCode: "SIGTERM" });
    },
  );
  expect(attempts).toEqual([release, worker, control]);
  expect(result.failures).toEqual([failure]);
  expect(result.terminal.has(release)).toBe(false);
  expect([...result.terminal]).toEqual([worker, control]);
});
