import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  parseInstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  startDesktopInstalledPluginRuntimeChildren,
  type DesktopInstalledPluginRuntimeChildrenRuntime,
} from "./desktopInstalledPluginRuntimeChildren.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const received = deferred();
  const release = deferred();
  const finished = deferred();
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = parseInstalledPluginPeerRequest(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.write(
        JSON.stringify({
          protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
          operation: "catalog",
          requestId: message.requestId,
          actor: message.actor,
          scope: message.scope,
          entries: [],
        }),
      );
      received.resolve();
      await release.promise;
      response.end();
    } finally {
      finished.resolve();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture actual origin");
  const origin = `http://127.0.0.1:${address.port}`;
  const children: ChildProcess[] = [];
  const closes: Promise<void>[] = [];
  function child(line?: string) {
    const source = `${line === undefined ? "" : `console.log(${JSON.stringify(line)});`}process.stdin.resume();`;
    const current = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    closes.push(
      new Promise<void>((resolve) => current.once("close", () => resolve())),
    );
    children.push(current);
    return current;
  }
  const controller = new AbortController();
  const challengedEnvironment = {
    ORIGINAL_CONTROL: "kept",
    CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH:
      "/native-owned/activation.json",
  };
  const runtime: DesktopInstalledPluginRuntimeChildrenRuntime = {
    worker: { ORIGINAL_WORKER: "kept" },
    control: { ORIGINAL_CONTROL: "kept" },
    token: "a".repeat(64),
    scope: {
      tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
      spaceId: DESKTOP_RUNTIME_OWNER.spaceId,
      profileId: "native-activation-profile",
    },
    expectedCatalogEntries: [],
    assertCurrent: vi.fn(),
    withdraw: vi.fn(),
    controlAfterPeer: vi.fn(() => challengedEnvironment),
  };
  const spawnControl = vi.fn((_environment: NodeJS.ProcessEnv) => child());
  const start = () =>
    startDesktopInstalledPluginRuntimeChildren({
      runtime,
      signal: controller.signal,
      spawnWorker: () => child(`CrewON Installed Plugin Peer origin ${origin}`),
      spawnControl,
      trackChild: () => {},
      deadlineMs: 10_000,
    });
  async function close() {
    release.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const current of children) {
      current.stdin?.end();
      if (current.exitCode === null && current.signalCode === null)
        current.kill("SIGTERM");
    }
    await Promise.all(closes);
  }
  return {
    runtime,
    origin,
    received,
    release,
    finished,
    controller,
    challengedEnvironment,
    spawnControl,
    start,
    close,
  };
}

it("issues v3 Control inputs only after the actual catalog response body closes", async () => {
  const f = await fixture();
  const starting = f.start();
  try {
    await f.received.promise;
    await delay(20);
    expect(f.runtime.controlAfterPeer).not.toHaveBeenCalled();
    expect(f.spawnControl).not.toHaveBeenCalled();
    f.release.resolve();
    await starting;
    await f.finished.promise;
    expect(f.runtime.controlAfterPeer).toHaveBeenCalledExactlyOnceWith({
      origin: f.origin,
    });
    expect(f.spawnControl).toHaveBeenCalledExactlyOnceWith(
      f.challengedEnvironment,
    );
  } finally {
    f.release.resolve();
    await starting.catch(() => {});
    await f.close();
  }
});

it("never issues v3 input or starts Control after withdrawal during an unfinished actual catalog body", async () => {
  const f = await fixture();
  const starting = f.start();
  const observed = starting.catch((error: unknown) => error);
  try {
    await f.received.promise;
    f.controller.abort(new Error("fixture revoked"));
    f.release.resolve();
    expect(await observed).toBeInstanceOf(Error);
    expect(f.runtime.controlAfterPeer).not.toHaveBeenCalled();
    expect(f.spawnControl).not.toHaveBeenCalled();
    expect(f.runtime.withdraw).toHaveBeenCalledOnce();
  } finally {
    f.release.resolve();
    await observed;
    await f.close();
  }
});

it("rechecks the owner after generating v3 input before starting Control", async () => {
  const f = await fixture();
  let created = false;
  vi.mocked(f.runtime.controlAfterPeer!).mockImplementation(() => {
    created = true;
    return f.challengedEnvironment;
  });
  vi.mocked(f.runtime.assertCurrent).mockImplementation(() => {
    if (created) throw new Error("fixture file replaced");
  });
  const starting = f.start();
  const observed = starting.catch((error: unknown) => error);
  try {
    await f.received.promise;
    f.release.resolve();
    expect(await observed).toEqual(new Error("fixture file replaced"));
    expect(f.runtime.controlAfterPeer).toHaveBeenCalledOnce();
    expect(f.spawnControl).not.toHaveBeenCalled();
    expect(f.runtime.withdraw).toHaveBeenCalledOnce();
  } finally {
    f.release.resolve();
    await observed;
    await f.close();
  }
});
