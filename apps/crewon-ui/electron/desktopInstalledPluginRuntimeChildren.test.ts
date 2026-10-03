import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  INSTALLED_PLUGIN_PEER_PRIVATE_PATH,
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  INSTALLED_PLUGIN_PEER_WIRE_LIMITS,
  parseInstalledPluginPeerRequest,
  parseInstalledPluginPeerResponse,
  type InstalledPluginPeerCatalogEntry,
  type InstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  parseExtensionManifest,
} from "@crewon/domain";
import { extensionManifestFixture } from "../../../packages/domain/src/extension-manifest.test-support.ts";
import { expect, it, vi } from "vitest";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  startDesktopInstalledPluginRuntimeChildren,
  type DesktopInstalledPluginRuntimeChildrenRuntime,
} from "./desktopInstalledPluginRuntimeChildren.ts";

const token = "a".repeat(64);
const scope = {
  tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
  spaceId: DESKTOP_RUNTIME_OWNER.spaceId,
  profileId: "native-profile",
};
type ResponseWriter = (
  request: InstalledPluginPeerRequest,
  response: ServerResponse,
) => void | Promise<void>;
type Projection = Pick<
  InstalledPluginPeerCatalogEntry,
  "identity" | "configuration" | "configuredTarget"
>;
type Fixture = Awaited<ReturnType<typeof fixture>>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function settledWithin(
  promise: Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Real child/HTTP transport fixtures; these declarations are not a loaded plugin or execution grant. */
function catalogEntry(): InstalledPluginPeerCatalogEntry {
  const manifest = parseExtensionManifest(
    extensionManifestFixture("example.native"),
  );
  const digest = (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const manifestDigest = digest(extensionCanonicalJson(manifest));
  const implementationDigest = `sha256:${"1".repeat(64)}`;
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      pluginId: manifest.pluginId,
      revision: 1,
      pluginVersion: manifest.version,
      manifestDigest,
      implementationDigest,
      parameters: { format: "mp4" },
      credentialBindings: [],
      createdByActorId: DESKTOP_RUNTIME_OWNER.actorId,
      createdAt: "2026-10-03T00:00:00.000Z",
    },
    { sha256: digest },
  );
  const result = parseInstalledPluginPeerResponse({
    protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
    requestId: "fixture-entry",
    operation: "catalog",
    actor: DESKTOP_RUNTIME_OWNER,
    scope,
    entries: [
      {
        identity: {
          pluginId: manifest.pluginId,
          publisherId: "example.publisher",
          version: manifest.version,
          packageDigest: `sha256:${"2".repeat(64)}`,
          manifestDigest,
          implementationDigest,
        },
        manifest,
        configuration,
        configuredTarget: {
          executionAuthority: "crewonKernel",
          agentVersionId: "native-plugin-agent",
          agentVersionContentDigest: `sha256:${"3".repeat(64)}`,
          materializationDigest: `sha256:${"4".repeat(64)}`,
          authorityId: "native-authority",
          runtimeGeneration: "native-generation",
          policySnapshotId: "native-policy",
          workspaceBindingId: null,
        },
      },
    ],
  });
  if (result.operation !== "catalog" || !result.entries[0])
    throw new Error("fixture catalog");
  return result.entries[0];
}

function projection(entry: InstalledPluginPeerCatalogEntry): Projection {
  return {
    identity: entry.identity,
    configuration: entry.configuration,
    configuredTarget: entry.configuredTarget,
  };
}
function send(
  response: ServerResponse,
  request: InstalledPluginPeerRequest,
  entries: readonly InstalledPluginPeerCatalogEntry[] = [],
) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      ...request,
      protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
      entries,
    }),
  );
}

async function fixture(
  writer: ResponseWriter = (request, response) => send(response, request),
) {
  const requests: InstalledPluginPeerRequest[] = [];
  const requestArrived = deferred();
  const failures: unknown[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        expect(request.url).toBe(INSTALLED_PLUGIN_PEER_PRIVATE_PATH);
        expect(request.method).toBe("POST");
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        const buffers: Buffer[] = [];
        for await (const chunk of request) buffers.push(Buffer.from(chunk));
        const parsed = parseInstalledPluginPeerRequest(
          JSON.parse(Buffer.concat(buffers).toString("utf8")),
        );
        requests.push(parsed);
        requestArrived.resolve();
        await writer(parsed, response);
      })().catch((error: unknown) => {
        failures.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const children: ChildProcess[] = [];
  const closes = new Map<ChildProcess, Promise<void>>();
  const tracked: ChildProcess[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const spawnChild = (line: string | null, source?: string) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        source ??
          `${line === null ? "" : `console.log(${JSON.stringify(line)});`}process.stdin.resume();`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    closes.set(
      child,
      new Promise<void>((resolve) => child.once("close", () => resolve())),
    );
    children.push(child);
    return child;
  };
  const workerEnvironment = { NATIVE_WORKER: "initial" };
  const controlEnvironment = { NATIVE_CONTROL: "initial" };
  const runtime: DesktopInstalledPluginRuntimeChildrenRuntime = {
    worker: workerEnvironment,
    control: controlEnvironment,
    token,
    scope,
    expectedCatalogEntries: [],
    assertCurrent: vi.fn(),
    withdraw: vi.fn(),
  };
  const spawnWorker = vi.fn((environment: NodeJS.ProcessEnv) => {
    environments.push(environment);
    return spawnChild(`CrewON Installed Plugin Peer origin ${origin}`);
  });
  const spawnControl = vi.fn((environment: NodeJS.ProcessEnv) => {
    environments.push(environment);
    return spawnChild(null);
  });
  const trackChild = vi.fn((child: ChildProcess) => tracked.push(child));
  const controller = new AbortController();
  const start = (
    options: Partial<
      Parameters<typeof startDesktopInstalledPluginRuntimeChildren>[0]
    > = {},
  ) =>
    startDesktopInstalledPluginRuntimeChildren({
      runtime,
      signal: controller.signal,
      spawnWorker,
      spawnControl,
      trackChild,
      deadlineMs: 2_000,
      ...options,
    });
  async function close() {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const child of children) {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
    for (const child of children) {
      const closed = closes.get(child)!;
      if (!(await settledWithin(closed, 2_000))) {
        child.kill("SIGKILL");
        if (!(await settledWithin(closed, 2_000)))
          throw new Error("fixture child physical retirement timeout");
        throw new Error("fixture child needed forced retirement");
      }
    }
    expect(failures).toEqual([]);
  }
  return {
    origin,
    server,
    runtime,
    workerEnvironment,
    controlEnvironment,
    environments,
    children,
    tracked,
    spawnChild,
    spawnWorker,
    spawnControl,
    trackChild,
    controller,
    requests,
    requestArrived,
    start,
    close,
  };
}

async function withFixture(
  run: (value: Fixture) => Promise<void>,
  writer?: ResponseWriter,
) {
  const value = await fixture(writer);
  try {
    await run(value);
  } finally {
    await value.close();
  }
}

it("tracks Worker before the actual v1 catalog challenge and starts original Control after its exact echo", async () => {
  const release = deferred();
  await withFixture(
    async (value) => {
      const pending = value.start();
      await value.requestArrived.promise;
      expect(value.tracked).toEqual([value.children[0]]);
      expect(value.spawnControl).not.toHaveBeenCalled();
      expect(value.requests[0]).toMatchObject({
        operation: "catalog",
        actor: DESKTOP_RUNTIME_OWNER,
        scope,
      });
      expect(value.requests[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
      value.workerEnvironment.NATIVE_WORKER = "changed";
      value.controlEnvironment.NATIVE_CONTROL = "changed";
      release.resolve();
      const result = await pending;
      expect(value.tracked).toEqual([result.worker, result.control]);
      expect(value.environments).toEqual([
        { NATIVE_WORKER: "initial" },
        { NATIVE_CONTROL: "initial" },
      ]);
      expect(Object.keys(value.environments[1]!)).not.toContain(
        "CREWON_INSTALLED_PLUGIN_PEER_TOKEN",
      );
      expect(value.runtime.controlAfterPeer).toBeUndefined();
      for (const name of [
        "CREWON_DESKTOP_INSTALLED_PLUGIN_ACTIVATION_CONFIG_PATH",
        "CREWON_DESKTOP_INSTALLED_PLUGIN_PEER_TOKEN",
      ])
        expect(Object.keys(value.environments[1]!)).not.toContain(name);
      expect(value.runtime.withdraw).not.toHaveBeenCalled();
      expect(value.runtime.assertCurrent).toHaveBeenCalledTimes(6);
      // The fifth ownership check follows Control environment capture and precedes spawning.
      // The final check still verifies that both tracked children remain live after spawning.
      const checks = vi.mocked(value.runtime.assertCurrent).mock
        .invocationCallOrder;
      const controlSpawn = value.spawnControl.mock.invocationCallOrder[0]!;
      expect(checks[4]!).toBeLessThan(controlSpawn);
      expect(checks[5]!).toBeGreaterThan(controlSpawn);
    },
    async (request, response) => {
      await release.promise;
      send(response, request);
    },
  );
});

it("accepts an actual parsed manifest and exact configuration/full-eight-field target metadata", async () => {
  const entry = catalogEntry();
  await withFixture(
    async (value) => {
      await value.start({
        runtime: {
          ...value.runtime,
          expectedCatalogEntries: [projection(entry)],
        },
      });
      expect(value.spawnControl).toHaveBeenCalledOnce();
      expect(value.requests).toHaveLength(1);
    },
    (request, response) => send(response, request, [entry]),
  );
});

it("accepts disabled empty catalog without treating expected metadata as IO readiness", async () => {
  await withFixture(async (value) => {
    await value.start({
      runtime: {
        ...value.runtime,
        expectedCatalogEntries: [projection(catalogEntry())],
      },
    });
    expect(value.requests.map((request) => request.operation)).toEqual([
      "catalog",
    ]);
    expect(value.spawnControl).toHaveBeenCalledOnce();
  });
});

it.each(["requestId", "actor", "scope"])(
  "rejects mismatched %s echo before spawning Control",
  async (field) => {
    await withFixture(
      async (value) => {
        await expect(value.start()).rejects.toThrow("response_echo_mismatch");
        expect(value.spawnControl).not.toHaveBeenCalled();
        expect(value.runtime.withdraw).toHaveBeenCalledOnce();
      },
      (request, response) => {
        const patch =
          field === "requestId"
            ? { requestId: "another-request" }
            : field === "actor"
              ? {
                  actor: { ...request.actor, principalId: "another-principal" },
                }
              : { scope: { ...request.scope, profileId: "another-profile" } };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...request,
            protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
            entries: [],
            ...patch,
          }),
        );
      },
    );
  },
);

it.each([
  "configuration",
  "target",
  "identity",
  "duplicate",
  "extra",
  "manifest",
])("rejects returned %s drift", async (kind) => {
  const entry = catalogEntry();
  let actual: readonly InstalledPluginPeerCatalogEntry[] = [entry];
  if (kind === "configuration")
    actual = [
      { ...entry, configuration: { ...entry.configuration, revision: 2 } },
    ];
  if (kind === "target")
    actual = [
      {
        ...entry,
        configuredTarget: {
          ...entry.configuredTarget,
          policySnapshotId: "other-policy",
        },
      },
    ];
  if (kind === "identity")
    actual = [
      {
        ...entry,
        identity: {
          ...entry.identity,
          packageDigest: `sha256:${"5".repeat(64)}`,
        },
      },
    ];
  if (kind === "duplicate") actual = [entry, entry];
  if (kind === "extra")
    actual = [
      entry,
      {
        ...entry,
        configuredTarget: {
          ...entry.configuredTarget,
          agentVersionId: "extra-agent",
        },
      },
    ];
  if (kind === "manifest")
    actual = [
      {
        ...entry,
        manifest: { ...entry.manifest, title: "Changed declaration" },
      },
    ];
  await withFixture(
    async (value) => {
      await expect(
        value.start({
          runtime: {
            ...value.runtime,
            expectedCatalogEntries: [projection(entry)],
          },
        }),
      ).rejects.toThrow(
        kind === "manifest" ? "manifest_mismatch" : "catalog_mismatch",
      );
      expect(value.spawnControl).not.toHaveBeenCalled();
    },
    (request, response) => send(response, request, actual),
  );
});

it("permits distinct prepared targets of the same package and rejects duplicate expected projections before spawn", async () => {
  const entry = catalogEntry();
  const second = {
    ...entry,
    configuredTarget: {
      ...entry.configuredTarget,
      agentVersionId: "second-agent",
    },
  };
  await withFixture(
    async (value) => {
      await value.start({
        runtime: {
          ...value.runtime,
          expectedCatalogEntries: [projection(entry), projection(second)],
        },
      });
      expect(value.spawnControl).toHaveBeenCalledOnce();
    },
    (request, response) => send(response, request, [second, entry]),
  );
  await withFixture(async (value) => {
    await expect(
      value.start({
        runtime: {
          ...value.runtime,
          expectedCatalogEntries: [projection(entry), projection(entry)],
        },
      }),
    ).rejects.toThrow("catalog_duplicate");
    expect(value.spawnWorker).not.toHaveBeenCalled();
  });
});

it.each([
  "http://localhost:1234",
  "http://127.0.0.1:080",
  "http://127.0.0.1:70000",
  "http://127.0.0.1:1234/",
  "https://127.0.0.1:1234",
])("rejects noncanonical peer origin %s", async (origin) => {
  await withFixture(async (value) => {
    await expect(
      value.start({
        spawnWorker: () =>
          value.spawnChild(`CrewON Installed Plugin Peer origin ${origin}`),
      }),
    ).rejects.toThrow("origin_invalid");
    expect(value.spawnControl).not.toHaveBeenCalled();
    expect(value.requests).toHaveLength(0);
  });
});

it("does not reuse the v0 stdout readiness prefix", async () => {
  await withFixture(async (value) => {
    await expect(
      value.start({
        spawnWorker: () =>
          value.spawnChild(`CrewON Extension Host origin ${value.origin}`),
        deadlineMs: 300,
      }),
    ).rejects.toThrow("deadline_exceeded");
    expect(value.spawnControl).not.toHaveBeenCalled();
    expect(value.requests).toHaveLength(0);
  });
});

it.each(["status", "contentType", "protocol", "bodyLimit", "declaredLimit"])(
  "rejects invalid HTTP %s before Control",
  async (kind) => {
    await withFixture(
      async (value) => {
        await expect(value.start()).rejects.toThrow();
        expect(value.spawnControl).not.toHaveBeenCalled();
        expect(value.runtime.withdraw).toHaveBeenCalledOnce();
      },
      (request, response) => {
        response.writeHead(kind === "status" ? 503 : 200, {
          "content-type":
            kind === "contentType" ? "text/plain" : "application/json",
          ...(kind === "declaredLimit"
            ? {
                "content-length":
                  INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes + 1,
              }
            : {}),
        });
        response.end(
          kind === "bodyLimit"
            ? " ".repeat(INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes + 1)
            : JSON.stringify({
                ...request,
                protocol:
                  kind === "protocol"
                    ? "crewon.extension-host-response.v0"
                    : INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
                entries: [],
              }),
        );
      },
    );
  },
);

it("rejects oversized Worker stdout while retaining its tracked physical child", async () => {
  await withFixture(async (value) => {
    await expect(
      value.start({
        spawnWorker: () =>
          value.spawnChild(
            null,
            `console.log('x'.repeat(${INSTALLED_PLUGIN_PEER_WIRE_LIMITS.messageBytes + 1}));process.stdin.resume();`,
          ),
      }),
    ).rejects.toThrow("stdout_limit");
    expect(value.tracked).toHaveLength(1);
    expect(value.spawnControl).not.toHaveBeenCalled();
  });
});

it("withdraws on actual Worker exit during a pending catalog and never spawns Control", async () => {
  await withFixture(
    async (value) => {
      const pending = value.start();
      const outcome = pending.catch((error: unknown) => error);
      await value.requestArrived.promise;
      value.children[0]!.kill("SIGTERM");
      await expect(outcome).resolves.toBeInstanceOf(Error);
      expect(value.spawnControl).not.toHaveBeenCalled();
      expect(value.runtime.withdraw).toHaveBeenCalledOnce();
    },
    () => {},
  );
});

it.each(["abort", "deadline"])(
  "withdraws on %s and joins actual pending response body",
  async (kind) => {
    await withFixture(
      async (value) => {
        const pending = value.start({
          deadlineMs: kind === "deadline" ? 300 : 2_000,
        });
        const outcome = pending.catch((error: unknown) => error);
        await value.requestArrived.promise;
        if (kind === "abort") value.controller.abort();
        await expect(outcome).resolves.toBeInstanceOf(Error);
        expect(value.runtime.withdraw).toHaveBeenCalledOnce();
        expect(value.spawnControl).not.toHaveBeenCalled();
      },
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"protocol":');
      },
    );
  },
);

it("does not logically retire a transport that ignores cancellation before its actual promise settles", async () => {
  const responseArrived = deferred();
  const release = deferred();
  await withFixture(async (value) => {
    const actualFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (...args: Parameters<typeof fetch>) => {
        const response = await actualFetch(...args);
        responseArrived.resolve();
        await release.promise;
        return response;
      },
    );
    let settled = false;
    const pending = value.start().finally(() => {
      settled = true;
    });
    const outcome = pending.catch((error: unknown) => error);
    await responseArrived.promise;
    value.controller.abort();
    await delay(30);
    expect(value.runtime.withdraw).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(value.spawnControl).not.toHaveBeenCalled();
    release.resolve();
    await expect(outcome).resolves.toBeInstanceOf(Error);
    expect(settled).toBe(true);
  });
});

it("withdraws a known HTTP failure before joining physically gated body cancellation", async () => {
  const cancelling = deferred();
  const release = deferred();
  await withFixture(
    async (value) => {
      const actualFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (...args: Parameters<typeof fetch>) => {
          const response = await actualFetch(...args);
          if (!response.body) throw new Error("fixture response body");
          const actualCancel = response.body.cancel.bind(response.body);
          vi.spyOn(response.body, "cancel").mockImplementation(async () => {
            cancelling.resolve();
            await release.promise;
            await actualCancel();
          });
          return response;
        },
      );
      let settled = false;
      const outcome = value
        .start()
        .finally(() => {
          settled = true;
        })
        .catch((error: unknown) => error);
      try {
        await cancelling.promise;
        expect(value.runtime.withdraw).toHaveBeenCalledOnce();
        expect(value.spawnControl).not.toHaveBeenCalled();
        expect(settled).toBe(false);
      } finally {
        release.resolve();
      }
      await expect(outcome).resolves.toBeInstanceOf(Error);
      expect(settled).toBe(true);
      expect(value.runtime.withdraw).toHaveBeenCalledOnce();
    },
    (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.write('{"unavailable":');
    },
  );
});

it("rechecks genuine owner snapshots after the challenge before dispatching Control", async () => {
  let current = true;
  await withFixture(
    async (value) => {
      await expect(
        value.start({
          runtime: {
            ...value.runtime,
            assertCurrent: () => {
              if (!current) throw new Error("actual_owner_changed");
            },
          },
        }),
      ).rejects.toThrow("actual_owner_changed");
      expect(value.spawnControl).not.toHaveBeenCalled();
      expect(value.runtime.withdraw).toHaveBeenCalledOnce();
    },
    (request, response) => {
      current = false;
      send(response, request);
    },
  );
});

it.each(["aborted", "token", "scope", "accessor"])(
  "rejects invalid startup %s before dispatch",
  async (kind) => {
    await withFixture(async (value) => {
      let runtime = value.runtime;
      if (kind === "aborted") value.controller.abort();
      if (kind === "token")
        runtime = { ...runtime, token: "not-a-private-token" };
      if (kind === "scope")
        runtime = {
          ...runtime,
          scope: { ...scope, tenantId: "another-tenant" },
        };
      const getter = vi.fn(() => "secret");
      if (kind === "accessor")
        runtime = {
          ...runtime,
          worker: Object.defineProperty({}, "UNSAFE", {
            enumerable: true,
            get: getter,
          }),
        };
      await expect(value.start({ runtime })).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(value.spawnWorker).not.toHaveBeenCalled();
      expect(value.spawnControl).not.toHaveBeenCalled();
    });
  },
);
