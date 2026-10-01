// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extensionRecoveryDirectory,
  putExtensionRecoveryFile,
  type ExtensionRecoveryFilePin,
  type ExtensionRecoveryManifest,
} from "@crewon/agent-version/extension-recovery";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  parseExtensionExecutionTarget,
  parseExtensionManifest,
} from "@crewon/domain";
import {
  DesktopExtensionHistoricalHosts,
  type DesktopExtensionHistoricalHostDiagnostic,
  type DesktopExtensionHistoricalHostPeer,
  type DesktopExtensionHistoricalHostsDependencies,
} from "./desktopExtensionHistoricalHosts.ts";
import type { DesktopExtensionHistoricalWorkerLaunchPlan } from "./desktopExtensionHistoricalInputs.ts";
import { prepareDesktopExtensionHistoricalWorker } from "./desktopExtensionHistoricalInputs.ts";
import { createDesktopExtensionHistoricalFixture } from "./desktopExtensionHistoricalInputs.test-support.ts";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";

// Real Node children and real loopback HTTP exercise process ownership and challenges.
// The archive port is a unit fixture; these tests do not attest an actual published Worker.
const archive = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@crewon/agent-version/extension-build", () => ({
  EXTENSION_HISTORICAL_WORK_ITEM_SCOPE: "crewon.extension-work-item-scope.v1",
  resolveRetainedExtensionBuild: (...args: unknown[]) =>
    archive.resolve(...args),
}));
const roots: string[] = [];
const children = new Set<ChildProcess>();
const managers: DesktopExtensionHistoricalHosts[] = [];
const hash = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const schema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const plugin = parseExtensionManifest({
  schemaVersion: "crewon.extension-manifest.v0",
  hostApi: "crewon.extensions.v0",
  pluginId: "example.video",
  version: "0.1.0",
  title: "Lifecycle fixture",
  description: "Node private peer fixture",
  task: { instructions: "Observe the operation.", inputSchema: schema },
  configurationSchema: schema,
  credentialSlots: [],
  resultViews: ["externalOperation"],
  tools: [
    {
      operationId: "observe",
      adapterId: "example.video-api",
      description: "Observe operation",
      inputSchema: schema,
      outputSchema: schema,
      execution: "serial",
      effect: "readOnly",
      recovery: "replaySafe",
      capability: "example.video.query",
    },
  ],
});
const registration = {
  pluginId: plugin.pluginId,
  pluginVersion: plugin.version,
  manifestDigest: hash(extensionCanonicalJson(plugin)),
  implementationDigest: hash("fixture-adapter"),
};
const workerSource = String.raw`
import { createServer } from 'node:http';
const state = JSON.parse(process.env.FIXTURE_STATE);
const mode = process.env.FIXTURE_MODE;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk.toString();
  const request = JSON.parse(body);
  console.log('REQUEST ' + request.operation);
  if (req.url !== '/private/v0/extensions' || req.headers.authorization !== 'Bearer ' + process.env.CREWON_EXTENSION_HOST_TOKEN) { res.writeHead(401); res.end(); return; }
  res.writeHead(200, {'content-type':'application/json'});
  if (mode === 'catalog-hang') { res.write('{'); return; }
  const actor = {...request.actor};
  if (mode.startsWith('owner-')) actor[mode.slice(6)] = 'different-owner';
  const common = {protocol:'crewon.extension-host-response.v0', operation:request.operation, actor};
  if (request.operation === 'catalog') {
    const registration = structuredClone(state.registration);
    if (mode === 'catalog-digest') registration.manifestDigest = 'sha256:' + 'f'.repeat(64);
    if (mode === 'catalog-manifest') registration.manifest.title = '';
    if (mode === 'catalog-implementation') registration.implementationDigest = 'sha256:' + 'e'.repeat(64);
    res.end(JSON.stringify({...common, registrations:mode === 'catalog-missing' ? [] : [registration]})); return;
  }
  const target = structuredClone(state.targets.find(value => value.agentVersionId === request.agentVersionId));
  if (mode.startsWith('target-')) {
    const field = mode.slice(7);
    target[field] = field.endsWith('Digest') ? 'sha256:' + 'd'.repeat(64) : field === 'executionAuthority' ? 'unsupported' : field === 'workspaceBindingId' ? 'different-workspace' : 'different-target';
  }
  res.end(JSON.stringify({...common,registration:request.registration,configurationDigest:request.configuration.contentDigest,agentVersionId:request.agentVersionId,result:{outcome:'ready',target}}));
});
server.listen(0,'127.0.0.1',()=>{
  if (mode !== 'no-ready') console.log('CrewON Extension Host origin http://127.0.0.1:' + server.address().port);
  if (mode === 'fast-exit') setImmediate(() => process.exit(7));
});
process.stdin.on('data', chunk => { if (chunk.toString().includes('exit')) process.exit(8); });
`;

beforeEach(() => {
  archive.resolve.mockReset();
  archive.resolve.mockResolvedValue({
    historicalWorkItemScope: "crewon.extension-work-item-scope.v1",
  });
});
afterEach(async () => {
  for (const manager of managers.splice(0))
    await manager.stop().catch(() => undefined);
  await Promise.allSettled(
    [...children].map((child) => terminate(child, "SIGKILL")),
  );
  children.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  mode = "valid",
  count = 1,
  root?: string,
  suffix = mode,
) {
  const dataRoot =
    root ??
    mkdtempSync(join(realpathSync(tmpdir()), "crewon-historical-hosts-"));
  if (root === undefined) roots.push(dataRoot);
  const selection = { dataRoot, capsuleId: hash(`capsule-${suffix}`) };
  const directory = await extensionRecoveryDirectory({
    selection,
    create: true,
  });
  const targets = Array.from({ length: count }, (_, index) =>
    parseExtensionExecutionTarget({
      executionAuthority: "crewonKernel",
      agentVersionId: `old-${suffix}-${index}`,
      agentVersionContentDigest: hash(`version-${suffix}-${index}`),
      materializationDigest: hash(`tools-${suffix}-${index}`),
      authorityId: "retained-authority",
      runtimeGeneration: "retained-generation",
      policySnapshotId: "retained-policy",
      workspaceBindingId: null,
    }),
  );
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: DESKTOP_RUNTIME_OWNER.tenantId,
      spaceId: DESKTOP_RUNTIME_OWNER.spaceId,
      ...registration,
      revision: 1,
      parameters: {},
      credentialBindings: [],
      createdByActorId: DESKTOP_RUNTIME_OWNER.actorId,
      createdAt: "2026-10-02T00:00:00.000Z",
    },
    { sha256: hash },
  );
  const bindings = targets.map((target, index) => ({
    agentVersionId: target.agentVersionId,
    extensionConfigPath: join(
      directory,
      `snapshot-${String(index).padStart(2, "0")}.json`,
    ),
  }));
  const catalogRegistration = {
    manifest: plugin,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
  };
  for (const [index, target] of targets.entries())
    targets[index] = parseExtensionExecutionTarget({
      ...target,
      materializationDigest: hash(
        extensionCanonicalJson({
          schemaVersion: "crewon.agent-version-materialization.v0",
          binding: bindings[index],
          extension: {
            schemaVersion: "crewon.extension-runtime-config.v0",
            configuration,
            approvalRequirement: "none",
            registration: catalogRegistration,
          },
          mcpStdioConfig: null,
          deviceToolConfig: null,
          remoteMcpConfig: null,
        }),
      ),
    });
  const documents = new Map<string, unknown>([
    [
      "plugin-bindings.json",
      {
        bindings,
      },
    ],
    ["plugin-assets.json", { fixtureMetadata: true }],
    ["base-bindings.json", { fixtureMetadata: true }],
    ["bootstrap.json", { fixtureMetadata: true }],
    ["release.json", { fixtureMetadata: true }],
    ...targets.map(
      (_, index) =>
        [
          `snapshot-${String(index).padStart(2, "0")}.json`,
          {
            schemaVersion: "crewon.extension-runtime-config.v0",
            configuration,
            approvalRequirement: "none",
          },
        ] as const,
    ),
  ]);
  const files: ExtensionRecoveryFilePin[] = [];
  for (const [file, document] of documents)
    files.push(
      await putExtensionRecoveryFile({
        selection,
        file: file as ExtensionRecoveryFilePin["file"],
        bytes: Buffer.from(JSON.stringify(document)),
      }),
    );
  const manifest: ExtensionRecoveryManifest = {
    schemaVersion: "crewon.extension-recovery-capsule.v0",
    capsuleId: selection.capsuleId,
    owner: DESKTOP_RUNTIME_OWNER,
    implementationDigest: hash("fixture-source"),
    buildIdentityDigest: hash("fixture-build"),
    providerBinding: {
      providerId: "old-provider",
      endpoint: "https://provider.example/v1",
      responsesEndpoint: "https://provider.example/v1/responses",
      credentialRequired: false,
    },
    releaseId: "old-release",
    registrations: [registration],
    targets,
    files,
  };
  const workerPath = join(dataRoot, `worker-${suffix}.mjs`);
  writeFileSync(
    workerPath,
    workerSource
      .replace(
        "const state = JSON.parse(process.env.FIXTURE_STATE);",
        `const state = ${JSON.stringify({ targets, registration: catalogRegistration })};`,
      )
      .replace(
        "const mode = process.env.FIXTURE_MODE;",
        `const mode = ${JSON.stringify(mode)};`,
      ),
  );
  const token = "a".repeat(64);
  const environment: NodeJS.ProcessEnv = {
    CREWON_PRINCIPAL_ID: DESKTOP_RUNTIME_OWNER.principalId,
    CREWON_ACTOR_ID: DESKTOP_RUNTIME_OWNER.actorId,
    CREWON_TENANT_ID: DESKTOP_RUNTIME_OWNER.tenantId,
    CREWON_SPACE_ID: DESKTOP_RUNTIME_OWNER.spaceId,
    CREWON_EXTENSIONS_ENABLED: "1",
    CREWON_EXTENSION_EXECUTION_MODE: "historical",
    CREWON_EXTENSION_HOST_PORT: "0",
    CREWON_EXTENSION_HOST_TOKEN: token,
    CREWON_CONTROL_SECURITY_MODE: "standalone",
  };
  const plan: DesktopExtensionHistoricalWorkerLaunchPlan = {
    outcome: "ready",
    manifest,
    workerPath,
    environment,
    token,
    deadlineMs: 1000,
  };
  return { dataRoot, directory, plan };
}
async function terminate(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("fixture_child_shutdown_timeout"));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", exited);
      child.off("close", exited);
    };
    const exited = () => {
      cleanup();
      resolve();
    };
    child.once("exit", exited);
    child.once("close", exited);
    child.kill(signal);
  });
}
async function waitFor(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2500)
      throw new Error("fixture_condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function harness(
  plans: readonly DesktopExtensionHistoricalWorkerLaunchPlan[],
  options: Partial<DesktopExtensionHistoricalHostsDependencies> = {},
) {
  const owned = new Set<ChildProcess>();
  const updates: Array<readonly DesktopExtensionHistoricalHostPeer[]> = [];
  const diagnostics: DesktopExtensionHistoricalHostDiagnostic[] = [];
  const spawned: Array<{
    child: ChildProcess;
    environment: NodeJS.ProcessEnv;
    operations: string[];
  }> = [];
  const manager = new DesktopExtensionHistoricalHosts({
    dataRoot:
      options.dataRoot ?? join(realpathSync(tmpdir()), "unused-native-root"),
    launchPlans: async () => plans,
    spawnWorker: (entry, environment) => {
      const child = spawn(process.execPath, [entry], {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      const operations: string[] = [];
      child.stdout?.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n"))
          if (line.startsWith("REQUEST ")) operations.push(line.slice(8));
      });
      child.stderr?.on("data", () => undefined);
      spawned.push({ child, environment, operations });
      return child;
    },
    terminate,
    trackChild: (child) => owned.add(child),
    releaseChild: (child) => owned.delete(child),
    onPeersChanged: async (peers) => {
      updates.push(peers);
    },
    onDiagnostic: (code) => diagnostics.push(code),
    ...options,
  });
  managers.push(manager);
  return { manager, owned, updates, diagnostics, spawned };
}

describe("historical host lifecycle with real Node private peers", () => {
  it.each(["normal", "large-bootstrap"] as const)(
    "accepts actual prepare %s output and passes real current secrets to the selected child before catalog rejects unit metadata",
    async (mode) => {
      const dataRoot = mkdtempSync(
        join(realpathSync(tmpdir()), "crewon-historical-prepared-host-"),
      );
      roots.push(dataRoot);
      const value = await createDesktopExtensionHistoricalFixture({
        dataRoot,
        ...(mode === "large-bootstrap"
          ? {
              modelCatalog: false,
              profileCount: 8,
              profileInstructions: "p".repeat(9000),
              instructions: "i".repeat(32 * 1024),
            }
          : {}),
      });
      const workerPath = join(dataRoot, "protocol-fixture-worker.mjs");
      writeFileSync(
        workerPath,
        workerSource
          .replace(
            "const state = JSON.parse(process.env.FIXTURE_STATE);",
            `const state = ${JSON.stringify({ registration: { manifest: plugin, manifestDigest: registration.manifestDigest, implementationDigest: registration.implementationDigest }, targets: value.manifest.targets })};`,
          )
          .replace(
            "const mode = process.env.FIXTURE_MODE;",
            "const mode = 'valid';",
          ),
      );
      archive.resolve.mockResolvedValue({
        ...value.archive,
        bundles: [{ file: "runtime-worker.mjs", path: workerPath }],
      });
      const plan = await prepareDesktopExtensionHistoricalWorker({
        selection: value.selection,
        resolveProvider:
          mode === "large-bootstrap"
            ? () => ({
                availability: "available",
                apiKey: "k".repeat(32 * 1024),
              })
            : value.resolveProvider,
      });
      expect(plan.outcome).toBe("ready");
      if (plan.outcome !== "ready")
        throw new Error("fixture_preparation_failed");
      expect(Object.getOwnPropertyDescriptor(plan, "toJSON")?.enumerable).toBe(
        false,
      );
      expect(
        Object.getOwnPropertyDescriptor(plan.environment, inspect.custom)
          ?.enumerable,
      ).toBe(false);
      const state = harness([plan], { dataRoot });
      await state.manager.start({ signal: new AbortController().signal });
      expect(state.spawned).toHaveLength(1);
      expect(state.spawned[0]!.environment.CREWON_MODEL_API_KEY).toBe(
        mode === "large-bootstrap"
          ? "k".repeat(32 * 1024)
          : "unit-current-provider-key",
      );
      if (mode === "large-bootstrap") {
        expect(
          Buffer.byteLength(
            state.spawned[0]!.environment.CREWON_DEV_AGENT_PROFILES_JSON!,
          ),
        ).toBeGreaterThan(32 * 1024);
        expect(
          state.spawned[0]!.environment.CREWON_AGENT_INSTRUCTIONS,
        ).toHaveLength(32 * 1024);
      }
      expect(state.spawned[0]!.environment.CREWON_EXTENSION_HOST_TOKEN).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      expect(state.spawned[0]!.environment.CREWON_AGENT_VERSION_ID).toBe(
        "saved-default",
      );
      expect(state.spawned[0]!.operations).toEqual(["catalog"]);
      expect(state.diagnostics).toEqual([
        "desktop_extension_historical_host_unavailable",
      ]);
      expect(state.manager.peers).toEqual([]);
      expect(state.owned.size).toBe(0);
    },
  );

  it("rejects pinned approval changes that no longer materialize the exact target before readiness", async () => {
    const value = await fixture();
    const file = "snapshot-00.json";
    const path = join(value.directory, file);
    const document = JSON.parse(readFileSync(path, "utf8")) as {
      approvalRequirement: string;
    };
    document.approvalRequirement = "perAction";
    const bytes = JSON.stringify(document);
    writeFileSync(path, bytes);
    const plan = {
      ...value.plan,
      manifest: {
        ...value.plan.manifest,
        files: value.plan.manifest.files.map((pin) =>
          pin.file === file ? { ...pin, digest: hash(bytes) } : pin,
        ),
      },
    };
    const state = harness([plan], { dataRoot: value.dataRoot });
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.spawned[0]!.operations).toEqual(["catalog"]);
    expect(state.manager.peers).toEqual([]);
    expect(state.owned.size).toBe(0);
  });

  it("a former lifetime cannot abort a replacement after its host has exited", async () => {
    const value = await fixture();
    const state = harness([value.plan], { dataRoot: value.dataRoot });
    const former = new AbortController();
    await state.manager.start({ signal: former.signal });
    state.manager.ownedChildren[0]!.stdin!.write("exit\n");
    await waitFor(
      () => state.owned.size === 0 && state.updates.at(-1)?.length === 0,
    );
    await state.manager.start({ signal: new AbortController().signal });
    former.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.manager.peers).toHaveLength(1);
    expect(state.owned.size).toBe(1);
  });

  it("owns a failed spawn until its actual no-pid close event", async () => {
    const value = await fixture();
    let child!: ChildProcess;
    let closed = false;
    const released: boolean[] = [];
    const state = harness([value.plan], {
      dataRoot: value.dataRoot,
      spawnWorker: () => {
        child = spawn(join(value.dataRoot, "missing-node-executable"), [], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.add(child);
        child.once("close", () => {
          closed = true;
        });
        return child;
      },
      releaseChild: () => {
        released.push(closed);
      },
    });
    await state.manager.start({ signal: new AbortController().signal });
    expect(child.pid).toBeUndefined();
    expect(released).toEqual([true]);
    expect(state.manager.ownedChildren).toEqual([]);
  });

  it("withdraws a live process error and physically terminates the real child", async () => {
    const value = await fixture();
    const state = harness([value.plan], { dataRoot: value.dataRoot });
    await state.manager.start({ signal: new AbortController().signal });
    state.manager.ownedChildren[0]!.emit(
      "error",
      new Error("private-fixture-process-error"),
    );
    await waitFor(
      () => state.owned.size === 0 && state.updates.at(-1)?.length === 0,
    );
    expect(state.manager.peers).toEqual([]);
    expect(state.diagnostics).toEqual([
      "desktop_extension_historical_host_unavailable",
    ]);
  });

  it("bounds an uncooperative peer callback and blocks duplicate starts until it settles", async () => {
    const value = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let updating = false;
    const state = harness([value.plan], {
      dataRoot: value.dataRoot,
      deadlineMs: 1000,
      onPeersChanged: async () => {
        updating = true;
        await barrier;
      },
    });
    const starting = state.manager.start({
      signal: new AbortController().signal,
    });
    try {
      await waitFor(() => updating);
      const began = Date.now();
      await expect(state.manager.stop()).rejects.toThrow(
        "desktop_extension_historical_shutdown_failed",
      );
      expect(Date.now() - began).toBeLessThan(2000);
      expect(state.owned.size).toBe(0);
      await expect(
        state.manager.start({ signal: new AbortController().signal }),
      ).rejects.toThrow("desktop_extension_historical_stopping");
      expect(state.spawned).toHaveLength(1);
    } finally {
      release();
    }
    await starting;
    await state.manager.stop();
  });

  it("rejects accessors, unknown environment values and oversized groups before invoking getters or spawning", async () => {
    const value = await fixture();
    const getter = vi.fn(() => {
      throw new Error("private-getter");
    });
    const array = [value.plan];
    Object.defineProperty(array, "0", { get: getter, enumerable: true });
    const descriptor = structuredClone(value.plan);
    Object.defineProperty(descriptor, "manifest", {
      get: getter,
      enumerable: true,
    });
    const ambient = {
      ...value.plan,
      environment: {
        ...value.plan.environment,
        CREWON_EXTENSION_HISTORICAL_HOSTS_JSON: "[]",
      },
    };
    const oversized = {
      ...value.plan,
      environment: {
        ...value.plan.environment,
        CREWON_AGENT_INSTRUCTIONS: "x".repeat(128 * 1024 + 1),
      },
    };
    for (const plans of [array, [descriptor], [ambient], [oversized]]) {
      const state = harness(plans, { dataRoot: value.dataRoot });
      await state.manager.start({ signal: new AbortController().signal });
      expect(state.spawned).toEqual([]);
      expect(state.diagnostics).toEqual([
        "desktop_extension_historical_plans_unavailable",
      ]);
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("owns children before challenge, verifies all 32 targets, and refreshes private tokens on restart", async () => {
    const value = await fixture("valid", 32);
    const state = harness([value.plan], { dataRoot: value.dataRoot });
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.owned.size).toBe(1);
    expect(state.manager.peers).toHaveLength(1);
    expect(state.spawned[0]!.operations).toEqual([
      "catalog",
      ...Array(32).fill("readiness"),
    ]);
    expect(state.updates.at(-1)).toEqual(state.manager.peers);
    expect(state.diagnostics).toEqual([]);
    expect(Object.isFrozen(state.manager.peers)).toBe(true);
    expect(Object.isFrozen(state.manager.peers[0])).toBe(true);
    expect(state.spawned[0]!.environment.CREWON_EXTENSION_HOST_TOKEN).not.toBe(
      value.plan.token,
    );
    expect(existsSync(join(value.directory, "manifest.json"))).toBe(false);
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.spawned).toHaveLength(1);
    const firstToken = state.manager.peers[0]!.token;
    await state.manager.stop();
    expect(state.owned.size).toBe(0);
    expect(state.manager.ownedChildren).toEqual([]);
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.spawned).toHaveLength(2);
    expect(state.manager.peers[0]!.token).not.toBe(firstToken);
    expect(value.plan.environment.CREWON_EXTENSION_HOST_TOKEN).toBe(
      value.plan.token,
    );
  });

  it.each(["principalId", "actorId", "tenantId", "spaceId"] as const)(
    "rejects an actual peer with substituted %s",
    async (field) => {
      const value = await fixture(`owner-${field}`);
      const state = harness([value.plan], { dataRoot: value.dataRoot });
      await state.manager.start({ signal: new AbortController().signal });
      expect(state.manager.peers).toEqual([]);
      expect(state.manager.ownedChildren).toEqual([]);
      expect(state.owned.size).toBe(0);
      expect(state.spawned[0]!.operations).toEqual(["catalog"]);
      expect(state.diagnostics).toContain(
        "desktop_extension_historical_host_unavailable",
      );
    },
  );

  it.each([
    "catalog-missing",
    "catalog-digest",
    "catalog-manifest",
    "catalog-implementation",
  ])("rejects %s before target readiness", async (mode) => {
    const value = await fixture(mode);
    const state = harness([value.plan], { dataRoot: value.dataRoot });
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.manager.peers).toEqual([]);
    expect(state.owned.size).toBe(0);
    expect(state.spawned[0]!.operations).toEqual(["catalog"]);
  });

  it.each([
    "executionAuthority",
    "agentVersionId",
    "agentVersionContentDigest",
    "materializationDigest",
    "authorityId",
    "runtimeGeneration",
    "policySnapshotId",
    "workspaceBindingId",
  ] as const)("rejects substituted target %s", async (field) => {
    const value = await fixture(`target-${field}`);
    const state = harness([value.plan], { dataRoot: value.dataRoot });
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.manager.peers).toEqual([]);
    expect(state.owned.size).toBe(0);
    expect(state.spawned[0]!.operations).toEqual(["catalog", "readiness"]);
  });

  it("keeps the healthy peer available when another historical Worker fails or exits", async () => {
    const good = await fixture("valid", 1, undefined, "good");
    const bad = await fixture("catalog-digest", 1, good.dataRoot, "bad");
    const state = harness([good.plan, bad.plan], { dataRoot: good.dataRoot });
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.manager.peers).toHaveLength(1);
    expect(state.owned.size).toBe(1);
    const running = state.manager.ownedChildren[0]!;
    running.stdin!.write("exit\n");
    await waitFor(
      () => state.owned.size === 0 && state.updates.at(-1)?.length === 0,
    );
    expect(state.manager.peers).toEqual([]);
    expect(state.diagnostics).toEqual(
      Array(2).fill("desktop_extension_historical_host_unavailable"),
    );
  });

  it("accepts the full four-host limit with independent fresh capabilities and settles every child", async () => {
    const first = await fixture("valid", 1, undefined, "capacity-0");
    const values = [first];
    for (let index = 1; index < 4; index++)
      values.push(
        await fixture("valid", 1, first.dataRoot, `capacity-${index}`),
      );
    const state = harness(
      values.map((value) => value.plan),
      { dataRoot: first.dataRoot },
    );
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.manager.peers).toHaveLength(4);
    expect(state.owned.size).toBe(4);
    expect(new Set(state.manager.peers.map((peer) => peer.token)).size).toBe(4);
    expect(state.updates.at(-1)).toEqual(state.manager.peers);
    await state.manager.stop();
    expect(state.owned.size).toBe(0);
    expect(state.manager.ownedChildren).toEqual([]);
  });

  it("settles fast exit between stdout readiness and catalog without registering a peer", async () => {
    const value = await fixture("fast-exit");
    const state = harness([value.plan], { dataRoot: value.dataRoot });
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.manager.peers).toEqual([]);
    expect(state.manager.ownedChildren).toEqual([]);
    expect(state.owned.size).toBe(0);
  });

  it.each(["no-ready", "catalog-hang"])(
    "shutdown aborts %s and physically settles the real child",
    async (mode) => {
      const value = await fixture(mode);
      const state = harness([value.plan], { dataRoot: value.dataRoot });
      const controller = new AbortController();
      const starting = state.manager.start({ signal: controller.signal });
      await waitFor(
        () =>
          state.spawned.length === 1 &&
          (mode === "no-ready" ||
            state.spawned[0]!.operations.includes("catalog")),
      );
      controller.abort();
      await starting;
      await state.manager.stop();
      expect(state.owned.size).toBe(0);
      expect(state.manager.ownedChildren).toEqual([]);
      expect(
        state.spawned[0]!.child.exitCode !== null ||
          state.spawned[0]!.child.signalCode !== null,
      ).toBe(true);
      expect(state.manager.peers).toEqual([]);
      expect(state.updates.every((update) => update.length === 0)).toBe(true);
    },
  );

  it("attempts every shutdown, retains failed live ownership, and retries without duplicate spawns", async () => {
    const first = await fixture("valid", 1, undefined, "first");
    const second = await fixture("valid", 1, first.dataRoot, "second");
    let fail = true;
    let retainedChild: ChildProcess | undefined;
    const attempts: ChildProcess[] = [];
    const state = harness([first.plan, second.plan], {
      dataRoot: first.dataRoot,
      terminate: async (child) => {
        attempts.push(child);
        if (fail && child === retainedChild)
          throw new Error("secret-fixture-key");
        await terminate(child);
      },
    });
    await state.manager.start({ signal: new AbortController().signal });
    retainedChild = state.spawned[0]!.child;
    await expect(state.manager.stop()).rejects.toThrow(
      "desktop_extension_historical_shutdown_failed",
    );
    expect(attempts).toHaveLength(2);
    expect(state.manager.ownedChildren).toEqual([state.spawned[0]!.child]);
    expect(state.owned.size).toBe(1);
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.spawned).toHaveLength(2);
    expect(JSON.stringify(state.diagnostics)).not.toContain(
      "secret-fixture-key",
    );
    fail = false;
    await state.manager.stop();
    expect(state.manager.ownedChildren).toEqual([]);
    expect(state.owned.size).toBe(0);
  });

  it("does not apply the completed readiness deadline to a slower Control update", async () => {
    const value = await fixture();
    let publish!: () => void;
    const barrier = new Promise<void>((resolve) => {
      publish = resolve;
    });
    let updating = false;
    const state = harness([value.plan], {
      dataRoot: value.dataRoot,
      onPeersChanged: async () => {
        updating = true;
        await barrier;
      },
    });
    const starting = state.manager.start({
      signal: new AbortController().signal,
    });
    await waitFor(() => updating);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(state.owned.size).toBe(1);
    expect(state.manager.peers).toHaveLength(1);
    publish();
    await starting;
    expect(state.diagnostics).toEqual([]);
  });

  it("keeps validated hosts when Control peer update fails and emits only a fixed diagnostic", async () => {
    const value = await fixture();
    const state = harness([value.plan], {
      dataRoot: value.dataRoot,
      onPeersChanged: async () => {
        throw new Error("private-token-key");
      },
    });
    await state.manager.start({ signal: new AbortController().signal });
    expect(state.manager.peers).toHaveLength(1);
    expect(state.owned.size).toBe(1);
    expect(state.diagnostics).toEqual([
      "desktop_extension_historical_peer_update_failed",
    ]);
  });

  it("fails whole-list capacity and duplicates before spawning any partial group", async () => {
    const value = await fixture();
    for (const plans of [Array(5).fill(value.plan), [value.plan, value.plan]]) {
      const state = harness(plans, { dataRoot: value.dataRoot });
      await state.manager.start({ signal: new AbortController().signal });
      expect(state.spawned).toEqual([]);
      expect(state.diagnostics).toEqual([
        "desktop_extension_historical_plans_unavailable",
      ]);
    }
  });

  it("copies actual enumerable secrets without invoking producer redaction hooks or later mutations", async () => {
    const value = await fixture();
    const plan = structuredClone(value.plan);
    const calls = vi.fn(() => ({ token: "[REDACTED]" }));
    Object.defineProperties(plan, {
      toJSON: { value: calls },
      [inspect.custom]: { value: calls },
    });
    Object.defineProperties(plan.environment, {
      toJSON: { value: calls },
      [inspect.custom]: { value: calls },
    });
    const state = harness([plan], { dataRoot: value.dataRoot });
    const starting = state.manager.start({
      signal: new AbortController().signal,
    });
    await waitFor(() => state.spawned.length === 1);
    plan.environment.CREWON_EXTENSION_HOST_TOKEN = "changed-after-snapshot";
    (
      plan.manifest.targets[0] as { materializationDigest: string }
    ).materializationDigest = hash("changed-after-snapshot");
    await starting;
    expect(state.manager.peers).toHaveLength(1);
    expect(calls).not.toHaveBeenCalled();
    expect(state.spawned[0]!.environment.CREWON_EXTENSION_HOST_TOKEN).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });
});
