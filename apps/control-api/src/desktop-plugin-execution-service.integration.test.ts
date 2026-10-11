import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ApplicationError } from "@crewon/application";
import {
  CREWON_CREATIVE_PROJECTS_SERVICE,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import {
  PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
  verifyLocalPluginPackage,
  type PluginUiHostServiceAvailabilityPort,
} from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import {
  createDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import {
  createDesktopPluginRuntime,
  type DesktopPluginRuntime,
} from "./desktop-plugin-runtime.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";

const actor = Object.freeze({
  principalId: "execution-native-owner",
  actorId: "execution-native-user",
  tenantId: "execution-tenant",
  spaceId: "execution-space",
});
const scope = Object.freeze({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "execution-native-profile",
});
const clock = { now: () => "2026-10-11T00:00:00.000Z" };
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
type Probe = {
  port?: Readonly<{
    register(factory: Readonly<{ create(): never }>): unknown;
  }>;
  createCalls: number;
  entered?(): void;
  gate?: Promise<void>;
};
type SourceSpec = Readonly<{
  sourceId: string;
  pluginId?: string;
  requires?: PluginPackageDescriptor["requires"];
  uiOnly?: boolean;
  probe?: Probe;
}>;

async function fixture(t: TestContext, specs: readonly SourceSpec[]) {
  let store: SqliteRunStore | undefined;
  let runtime:
    | DesktopPluginRuntime
    | DesktopPluginInstallationRuntime
    | undefined;
  let authority: DesktopPluginAuthority | undefined;
  const probes = globalThis as unknown as Record<string, unknown>;
  const keys: string[] = [];
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
      await store?.close();
      for (const key of keys) delete probes[key];
    },
  });
  const sources = await Promise.all(
    specs.map(async (spec) => {
      const probeKey = `crewon-execution-fixture-${randomUUID()}`;
      keys.push(probeKey);
      const probe = spec.probe ?? { createCalls: 0 };
      probes[probeKey] = probe;
      const pluginId = spec.pluginId ?? `test.${spec.sourceId}`;
      const directory = join(files.root, spec.sourceId);
      await mkdir(directory, { mode: 0o700 });
      const code = spec.uiOnly
        ? "export default {apiVersion:'crewon.plugin-ui.v1',mount(){return {update(){},dispose(){}};}};"
        : [
            "import {appendFileSync} from 'node:fs';",
            `const log=value=>appendFileSync(${JSON.stringify(files.marker)},${JSON.stringify(spec.sourceId)}+':'+value+'\\n');`,
            `export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},async setup(context){`,
            `const probe=globalThis[${JSON.stringify(probeKey)}];log('setup');`,
            "const port=context.services.get('crewon.execution','1');probe.port=port;",
            "port.register({create(){probe.createCalls++;throw new Error('installation_must_not_execute_factory');}});",
            "probe.entered?.();if(probe.gate)await probe.gate;",
            "return {dispose(){log('dispose');}};}};",
          ].join("");
      const entry = spec.uiOnly ? "ui.mjs" : "node.mjs";
      const bytes = Buffer.from(code);
      const descriptor: PluginPackageDescriptor = {
        schemaVersion: "crewon.plugin-package.v1",
        hostApi: "crewon.plugin-host.v1",
        pluginId,
        publisherId: "test.execution-publisher",
        version: "1.0.0",
        title: "Actual installation execution service fixture",
        description:
          "Verified local setup registration, without a Worker or model request.",
        entrypoints: {
          node: spec.uiOnly ? null : entry,
          ui: spec.uiOnly ? { path: entry, mode: "trustedModule" } : null,
        },
        businessManifestPath: null,
        requires: spec.requires ?? [
          { service: "crewon.execution", apiVersion: "1", optional: false },
        ],
        provides: [],
        contributions: spec.uiOnly
          ? [
              {
                id: "workbench",
                kind: "module",
                slot: "main.content",
                title: "UI fixture",
              },
            ]
          : [],
        files: [
          {
            path: entry,
            byteLength: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      };
      await writeFile(join(directory, entry), bytes);
      await writeFile(
        join(directory, "crewon.plugin.json"),
        JSON.stringify(descriptor),
      );
      const verified = await verifyLocalPluginPackage({ directory });
      return {
        sourceId: spec.sourceId,
        directory,
        pluginId,
        publisherId: descriptor.publisherId,
        version: descriptor.version,
        packageDigest: verified.packageDigest,
        probe,
        uiOnly: spec.uiOnly === true,
      };
    }),
  );
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "native-execution-approved-epoch-fixture-01",
    installRoot: files.installRoot,
    sources: sources.map(
      ({ probe: _probe, uiOnly: _uiOnly, ...source }) => source,
    ),
    publications: sources
      .filter((source) => source.uiOnly)
      .map((source) => ({
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      })),
  });
  const databasePath = join(files.root, "control.sqlite");
  let sequence = 0;
  const service = () => {
    assert.ok(runtime);
    return "installation" in runtime ? runtime.installation : runtime.service;
  };
  return {
    ...files,
    sources,
    get store() {
      assert.ok(store);
      return store;
    },
    get runtime() {
      assert.ok(runtime);
      return runtime;
    },
    get authority() {
      assert.ok(authority);
      return authority;
    },
    async openRuntime() {
      assert.equal(runtime, undefined);
      store = new SqliteRunStore(databasePath);
      runtime = await createDesktopPluginRuntime(
        { configuration },
        {
          store,
          identity: new StandaloneIdentity({
            actor,
            sessionToken: "s".repeat(32),
            csrfToken: "c".repeat(32),
            allowedOrigins: ["crewon://desktop"],
          }),
          clock,
          digester,
        },
      );
    },
    async openInstallation(
      hostUiServices?: PluginUiHostServiceAvailabilityPort,
    ) {
      assert.equal(runtime, undefined);
      store = new SqliteRunStore(databasePath);
      const ledger = store.pluginInstallationStore();
      await ledger.migrate();
      await ledger.compositionStore().migrate();
      authority = new DesktopPluginAuthority(configuration);
      const registry = await createDesktopPluginSourceRegistry(configuration);
      runtime = await createDesktopPluginInstallationRuntime(
        { configuration, registry, authority },
        {
          store,
          clock,
          digester,
          ...(hostUiServices === undefined ? {} : { hostUiServices }),
        },
      );
    },
    async close() {
      await runtime?.close();
      runtime = undefined;
      await store?.close();
      store = undefined;
    },
    install(source: (typeof sources)[number]) {
      return service().install(actor, {
        sourceId: source.sourceId,
        expectedPluginId: source.pluginId,
        expectedPackageDigest: source.packageDigest,
        expectedSelectionRevision: null,
        idempotencyKey: `execution-install-${++sequence}`,
      });
    },
    select(
      source: (typeof sources)[number],
      revision: number,
      state: "enabled" | "disabled",
      key = `execution-select-${++sequence}`,
    ) {
      return service().select(actor, {
        pluginId: source.pluginId,
        expectedSelectionRevision: revision,
        state,
        selectedPackageDigest: source.packageDigest,
        idempotencyKey: key,
      });
    },
    async events() {
      try {
        return await readFile(files.marker, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    },
  };
}

test("actual desktop setup registers factories, publishes the exact host tuple, cleans on disable and recovers only on a new authorized selection", async (t) => {
  const f = await fixture(t, [
    { sourceId: "execution" },
    { sourceId: "sibling" },
  ]);
  const [source, sibling] = f.sources;
  assert.ok(source && sibling);
  await f.openRuntime();
  await f.install(source);
  await f.install(sibling);
  assert.equal(await f.events(), "");
  const enabled = await f.select(
    source,
    1,
    "enabled",
    "execution-original-enable",
  );
  assert.equal(enabled.projection.outcome, "applied");
  const ledger = f.store.pluginInstallationStore();
  const original = await ledger.compositionStore().loadCurrent({ scope });
  assert.ok(original);
  assert.deepEqual(original.hostServices, [
    PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
  ]);
  assert.deepEqual(original.edges, [
    {
      consumerPluginId: source.pluginId,
      service: "crewon.execution",
      apiVersion: "1",
      provider: {
        kind: "host",
        implementationId: "crewon.execution-registry.v1",
        implementationRevision: 1,
      },
    },
  ]);
  assert.equal(source.probe.createCalls, 0);
  assert.ok(source.probe.port);
  const retired = source.probe.port;
  assert.equal(
    (await f.select(source, 2, "disabled")).projection.outcome,
    "applied",
  );
  assert.deepEqual(
    (await ledger.compositionStore().loadCurrent({ scope }))?.nodes,
    [],
  );
  assert.throws(
    () =>
      retired.register({
        create() {
          throw new Error("unexpected");
        },
      }),
    /plugin_execution_registration_closed/u,
  );
  assert.match(await f.events(), /execution:dispose/u);
  await f.select(source, 3, "enabled");
  const beforeClose = await f.events();
  const beforeCold = await ledger.compositionStore().loadCurrent({ scope });
  assert.ok(source.probe.port);
  const closingPort = source.probe.port;
  await f.close();
  assert.throws(
    () =>
      closingPort.register({
        create() {
          throw new Error("unexpected");
        },
      }),
    /plugin_execution_registry_closed/u,
  );
  const afterClose = await f.events();
  assert.notEqual(afterClose, beforeClose);
  await f.openRuntime();
  assert.equal(await f.events(), afterClose);
  assert.equal(
    (await f.select(source, 1, "enabled", "execution-original-enable")).mutation
      .disposition,
    "replayed",
  );
  assert.equal(await f.events(), afterClose);
  assert.deepEqual(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    beforeCold,
  );
  assert.equal(
    (await f.select(sibling, 1, "enabled")).projection.outcome,
    "applied",
  );
  const restored = await f.store
    .pluginInstallationStore()
    .compositionStore()
    .loadCurrent({ scope });
  assert.ok(restored);
  assert.deepEqual(restored.hostServices, original.hostServices);
  assert.deepEqual(
    restored.nodes.map((node) => node.pluginId),
    [source.pluginId, sibling.pluginId],
  );
  assert.equal((await f.events()).split("execution:setup").length - 1, 3);
  assert.equal((await f.events()).split("sibling:setup").length - 1, 1);
  assert.equal(source.probe.createCalls + sibling.probe.createCalls, 0);
  assert.deepEqual(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadLock({ scope, lockDigest: original.lockDigest }),
    original,
  );
});

for (const requirement of [
  { service: "crewon.execution", apiVersion: "2", optional: false },
  { service: "crewon.tasks", apiVersion: "1", optional: false },
  { service: "unknown.service", apiVersion: "1", optional: false },
]) {
  test(`actual Node selection rejects unavailable ${requirement.service} API ${requirement.apiVersion} before setup`, async (t) => {
    const f = await fixture(t, [
      { sourceId: "blocked", requires: [requirement] },
    ]);
    const source = f.sources[0]!;
    await f.openRuntime();
    await f.install(source);
    await assert.rejects(
      f.select(source, 1, "enabled"),
      /plugin_dependency_unavailable/u,
    );
    assert.equal(await f.events(), "");
    assert.equal(
      (
        await f.store
          .pluginInstallationStore()
          .loadSelection({ scope, pluginId: source.pluginId })
      )?.state,
      "disabled",
    );
    assert.equal(
      await f.store
        .pluginInstallationStore()
        .compositionStore()
        .loadCurrent({ scope }),
      null,
    );
  });
}

test("a service call without its exact declared dependency still fails despite the real execution catalog", async (t) => {
  const f = await fixture(t, [{ sourceId: "undeclared", requires: [] }]);
  const source = f.sources[0]!;
  await f.openRuntime();
  await f.install(source);
  await assert.rejects(
    f.select(source, 1, "enabled"),
    (error) =>
      error instanceof ApplicationError &&
      error.code === "plugin_installation_host_unavailable" &&
      error.cause instanceof Error &&
      error.cause.message === "plugin_dependency_undeclared",
  );
  assert.equal(source.probe.port, undefined);
  assert.equal(source.probe.createCalls, 0);
  assert.equal(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    null,
  );
});

test("current Native authority withdrawn while actual setup awaits prevents selection and cleans the real registration", async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const probe: Probe = { createCalls: 0, gate, entered };
  const f = await fixture(t, [{ sourceId: "suspended", probe }]);
  const source = f.sources[0]!;
  await f.openInstallation();
  await f.install(source);
  const selecting = f.select(source, 1, "enabled");
  // Attach the rejection observer before releasing real asynchronous setup.
  const rejected = assert.rejects(
    selecting,
    (error) =>
      error instanceof ApplicationError &&
      error.code === "plugin_installation_profile_unavailable",
  );
  try {
    await reached;
    assert.ok(probe.port);
    f.authority.withdraw();
  } finally {
    release();
  }
  await rejected;
  assert.equal(
    (
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: source.pluginId })
    )?.state,
    "disabled",
  );
  assert.equal(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    null,
  );
  assert.match(await f.events(), /suspended:dispose/u);
  assert.throws(
    () =>
      probe.port!.register({
        create() {
          throw new Error("unexpected");
        },
      }),
    /plugin_execution_registry_closed/u,
  );
  assert.equal(probe.createCalls, 0);
});

test("UI-only service availability cannot admit tasks or invent its Node implementation", async (t) => {
  const f = await fixture(t, [
    {
      sourceId: "ui-tasks",
      uiOnly: true,
      requires: [{ service: "crewon.tasks", apiVersion: "1", optional: false }],
    },
  ]);
  const source = f.sources[0]!;
  await f.openInstallation({ isAvailable: () => true });
  await f.install(source);
  await assert.rejects(
    f.select(source, 1, "enabled"),
    /plugin_ui_only_services_unsupported/u,
  );
  assert.equal(
    (
      await f.store
        .pluginInstallationStore()
        .loadSelection({ scope, pluginId: source.pluginId })
    )?.state,
    "disabled",
  );
  assert.equal(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    null,
  );
  assert.equal(await f.events(), "");
});

test("a supported UI-only availability probe preserves UI selection but cannot publish a missing Node dependency", async (t) => {
  const f = await fixture(t, [
    {
      sourceId: "ui-projects",
      uiOnly: true,
      requires: [
        {
          service: CREWON_CREATIVE_PROJECTS_SERVICE,
          apiVersion: CREWON_CREATIVE_PROJECTS_API_VERSION,
          optional: false,
        },
      ],
    },
  ]);
  const source = f.sources[0]!;
  await f.openInstallation({ isAvailable: () => true });
  await f.install(source);
  const selected = await f.select(source, 1, "enabled");
  assert.equal(selected.mutation.disposition, "committed");
  assert.equal(selected.projection.outcome, "applied");
  assert.equal(f.runtime.compositionState(actor).outcome, "unavailable");
  assert.equal(
    await f.store
      .pluginInstallationStore()
      .compositionStore()
      .loadCurrent({ scope }),
    null,
  );
  assert.equal(await f.events(), "");
});

test("UI-only metadata without Node requirements remains publishable with the real installation catalog", async (t) => {
  const f = await fixture(t, [
    { sourceId: "ui-basic", uiOnly: true, requires: [] },
  ]);
  const source = f.sources[0]!;
  await f.openRuntime();
  await f.install(source);
  const selected = await f.select(source, 1, "enabled");
  assert.equal(selected.projection.outcome, "applied");
  assert.equal(f.runtime.compositionState(actor).outcome, "published");
  const lock = await f.store
    .pluginInstallationStore()
    .compositionStore()
    .loadCurrent({ scope });
  assert.ok(lock);
  assert.deepEqual(lock.hostServices, [
    PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
  ]);
  assert.equal(lock.nodes[0]?.pluginId, source.pluginId);
  assert.deepEqual(lock.edges, []);
  assert.equal(await f.events(), "");
});
