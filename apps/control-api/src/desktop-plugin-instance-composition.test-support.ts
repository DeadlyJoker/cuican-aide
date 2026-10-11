import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginAuthority } from "./desktop-plugin-authority.ts";
import {
  loadDesktopPluginConfiguration,
  parseDesktopPluginConfiguration,
} from "./desktop-plugin-configuration.ts";
import { createDesktopPluginSourceRegistry } from "./desktop-plugin-source-registry.ts";
import {
  createDesktopPluginRuntime,
  type DesktopPluginRuntime,
} from "./desktop-plugin-runtime.ts";
import {
  createDesktopPluginInstallationRuntime,
  type DesktopPluginInstallationRuntime,
} from "./desktop-plugin-installation-runtime.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { DesktopPluginTaskServiceBinding } from "./desktop-plugin-task-service-binding.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";

export const actor = {
  tenantId: "instance-tenant",
  spaceId: "instance-space",
  principalId: "instance-native-owner",
  actorId: "instance-user",
};
export const scope = {
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "instance-profile",
};
const clock = { now: () => "2026-10-11T00:00:00.000Z" };
const digester = {
  sha256: (body: string) =>
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
};
const dependency = { service: "test.instance-source", apiVersion: "1" };
type Gate = {
  setupWait?: Promise<void>;
  setupEntered?(): void;
  readWait?: Promise<void>;
  readEntered?(): void;
};
type Probe = {
  counts: Record<string, number>;
  events: string[];
  providerGeneration: number;
  consumers: Array<{ generation: number; version: string; provider: object }>;
  ports: Record<string, { register(factory: { create(): never }): unknown }>;
  gates: Record<string, Gate>;
};
type Spec = {
  id: string;
  kind: "provider" | "consumer" | "independent" | "ui" | "actionConsumer";
  pluginId?: string;
  version?: string;
  requiresTasks?: "1" | "2";
  taskOptional?: boolean;
};
type Source = Readonly<{
  sourceId: string;
  directory: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  kind: Spec["kind"];
}>;
export const standard: readonly Spec[] = [
  { id: "provider", kind: "provider" },
  { id: "consumer", kind: "consumer" },
  { id: "independent", kind: "independent" },
];

/** Real verified modules, Native source identities, original Application and file-backed Profile claim. */
export async function fixture(
  t: TestContext,
  specs: readonly Spec[] = standard,
  nativeConfiguration: "parsed-v1" | "private-file-v3" = "parsed-v1",
) {
  let runtime:
    | DesktopPluginRuntime
    | DesktopPluginInstallationRuntime
    | undefined;
  let store: SqliteRunStore | undefined;
  let authority: DesktopPluginAuthority | undefined;
  let taskBinding: DesktopPluginTaskServiceBinding | undefined;
  const key = `crewon-instance-fixture-${randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  const probe: Probe = {
    counts: {},
    events: [],
    providerGeneration: 0,
    consumers: [],
    ports: {},
    gates: {},
  };
  globals[key] = probe;
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
      await store?.close();
      delete globals[key];
    },
  });
  const sources: Source[] = [];
  for (const spec of specs) {
    const pluginId = spec.pluginId ?? `test.${spec.id}`;
    const version = spec.version ?? "1.0.0";
    const directory = join(files.root, spec.id);
    await mkdir(directory, { mode: 0o700 });
    const setup =
      spec.kind === "provider"
        ? `const generation=++probe.providerGeneration;ctx.services.provide('test.instance-source','1',{generation,version:${JSON.stringify(version)}});`
        : spec.kind === "consumer" || spec.kind === "actionConsumer"
          ? `const provider=ctx.services.get('test.instance-source','1');probe.consumers.push({generation:provider.generation,version:provider.version,provider});${spec.kind === "actionConsumer" ? `ctx.services.provide(${JSON.stringify(pluginId)},'1',{actions:[{contributionId:'workbench',action:'read',kind:'read'}],async invoke(){probe.gates[id]?.readEntered?.();if(probe.gates[id]?.readWait)await probe.gates[id].readWait;return {generation:provider.generation,version:provider.version};}});` : ""}`
          : "";
    const code =
      spec.kind === "ui"
        ? "export default {apiVersion:'crewon.plugin-ui.v1',mount(){return {update(){},dispose(){}};}};"
        : `export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(pluginId)},async setup(ctx){const probe=globalThis[${JSON.stringify(key)}];const id=${JSON.stringify(spec.id)};const count=probe.counts[id]=(probe.counts[id]??0)+1;probe.events.push(id+':setup:'+count);const port=ctx.services.get('crewon.execution','1');probe.ports[id]=port;port.register({create(){throw new Error('instance_test_must_not_execute_a_Run');}});${setup}probe.gates[id]?.setupEntered?.();if(probe.gates[id]?.setupWait)await probe.gates[id].setupWait;return {dispose(){probe.events.push(id+':dispose:'+count);}};}};`;
    const bytes = Buffer.from(code);
    const entry = spec.kind === "ui" ? "ui.mjs" : "node.mjs";
    const ui =
      spec.kind === "actionConsumer"
        ? Buffer.from(
            "export default {apiVersion:'crewon.plugin-ui.v1',mount(){return {update(){},dispose(){}};}};",
          )
        : null;
    const descriptor: PluginPackageDescriptor = {
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId,
      publisherId: "test.instance-publisher",
      version,
      title: "Actual desktop instance composition fixture",
      description:
        "No Worker invocation, provider request or task approval is implied.",
      entrypoints: {
        node: spec.kind === "ui" ? null : entry,
        ui:
          spec.kind === "ui" || spec.kind === "actionConsumer"
            ? { path: "ui.mjs", mode: "trustedModule" }
            : null,
      },
      businessManifestPath: null,
      requires:
        spec.kind === "ui"
          ? []
          : [
              { service: "crewon.execution", apiVersion: "1", optional: false },
              ...(spec.requiresTasks
                ? [
                    {
                      service: "crewon.tasks",
                      apiVersion: spec.requiresTasks,
                      optional: spec.taskOptional === true,
                    },
                  ]
                : []),
              ...(spec.kind === "consumer" || spec.kind === "actionConsumer"
                ? [{ ...dependency, optional: false }]
                : []),
            ],
      provides:
        spec.kind === "provider"
          ? [dependency]
          : spec.kind === "actionConsumer"
            ? [{ service: pluginId, apiVersion: "1" }]
            : [],
      contributions:
        spec.kind === "ui" || spec.kind === "actionConsumer"
          ? [
              {
                id: "workbench",
                kind: "module",
                slot: "main.content",
                title: "Actual UI-only",
              },
            ]
          : [],
      files: [
        {
          path: entry,
          byteLength: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        ...(ui
          ? [
              {
                path: "ui.mjs",
                byteLength: ui.length,
                sha256: createHash("sha256").update(ui).digest("hex"),
              },
            ]
          : []),
      ],
    };
    if (ui) await writeFile(join(directory, "ui.mjs"), ui);
    await writeFile(join(directory, entry), bytes);
    await writeFile(
      join(directory, "crewon.plugin.json"),
      JSON.stringify(descriptor),
    );
    const verified = await verifyLocalPluginPackage({ directory });
    sources.push({
      sourceId: spec.id,
      directory,
      pluginId,
      publisherId: descriptor.publisherId,
      version,
      packageDigest: verified.packageDigest,
      kind: spec.kind,
    });
  }
  const rawConfiguration = {
    schemaVersion:
      nativeConfiguration === "private-file-v3"
        ? "crewon.desktop-plugin-bootstrap.v3"
        : "crewon.desktop-plugin-bootstrap.v1",
    actor,
    scope,
    authorityEpoch: "instance-real-native-source-epoch-01",
    installRoot: files.installRoot,
    sources: sources.map(({ kind: _kind, ...source }) => source),
    publications: sources
      .filter(
        (source) => source.kind === "ui" || source.kind === "actionConsumer",
      )
      .map((source) => ({
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        packageDigest: source.packageDigest,
        publicAssets: ["ui.mjs"],
      })),
    ...(nativeConfiguration === "private-file-v3"
      ? {
          projects: {
            version: "crewon.desktop-project-execution.v1",
            textArtifacts: { version: "crewon.project-text.v1" },
          },
        }
      : {}),
  };
  const configurationPath = join(files.root, "bootstrap.json");
  await writeFile(configurationPath, JSON.stringify(rawConfiguration), {
    mode: 0o600,
  });
  const configuration =
    nativeConfiguration === "private-file-v3"
      ? await loadDesktopPluginConfiguration(configurationPath, { actor })
      : parseDesktopPluginConfiguration(rawConfiguration);
  const databasePath = join(files.root, "control.sqlite");
  let sequence = 0;
  const service = () => {
    assert.ok(runtime);
    return "installation" in runtime ? runtime.installation : runtime.service;
  };
  return {
    ...files,
    databasePath,
    configurationPath,
    probe,
    sources,
    source(id: string) {
      const source = sources.find((entry) => entry.sourceId === id);
      assert.ok(source);
      return source;
    },
    get runtime() {
      assert.ok(runtime);
      return runtime;
    },
    get store() {
      assert.ok(store);
      return store;
    },
    get authority() {
      assert.ok(authority);
      return authority;
    },
    get taskBinding() {
      assert.ok(taskBinding);
      return taskBinding;
    },
    async open(
      mode: "full" | "installation" = "full",
      options: Readonly<{ bindTasks?: true }> = {},
    ) {
      assert.equal(runtime, undefined);
      store = new SqliteRunStore(databasePath);
      if (mode === "full")
        runtime = await createDesktopPluginRuntime(
          { configuration },
          {
            store,
            clock,
            digester,
            identity: new StandaloneIdentity({
              actor,
              sessionToken: "s".repeat(32),
              csrfToken: "c".repeat(32),
              allowedOrigins: ["crewon://desktop"],
            }),
          },
        );
      else {
        const ledger = store.pluginInstallationStore();
        await ledger.migrate();
        await ledger.compositionStore().migrate();
        authority = new DesktopPluginAuthority(configuration);
        const registry = await createDesktopPluginSourceRegistry(configuration);
        if (options.bindTasks)
          taskBinding = new DesktopPluginTaskServiceBinding({
            configuration,
            registry,
            authority,
            store,
          });
        runtime = await createDesktopPluginInstallationRuntime(
          { configuration, registry, authority },
          { store, clock, digester, ...(taskBinding ? { taskBinding } : {}) },
        );
      }
    },
    async close() {
      await runtime?.close();
      runtime = undefined;
      await store?.close();
      store = undefined;
      authority = undefined;
      taskBinding?.close();
      taskBinding = undefined;
    },
    install(source: (typeof sources)[number], revision: number | null = null) {
      return service().install(actor, {
        sourceId: source.sourceId,
        expectedPluginId: source.pluginId,
        expectedPackageDigest: source.packageDigest,
        expectedSelectionRevision: revision,
        idempotencyKey: `instance-install-${++sequence}`,
      });
    },
    select(
      source: (typeof sources)[number],
      revision: number,
      state: "enabled" | "disabled" = "enabled",
      key = `instance-select-${++sequence}`,
    ) {
      return service().select(actor, {
        pluginId: source.pluginId,
        expectedSelectionRevision: revision,
        selectedPackageDigest: source.packageDigest,
        state,
        idempotencyKey: key,
      });
    },
    status() {
      assert.ok(runtime);
      return runtime.compositionStatus.listStatus(actor, {
        afterPluginId: null,
        limit: 50,
      });
    },
    selection(source: (typeof sources)[number]) {
      return service().getSelection(actor, { pluginId: source.pluginId });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
export function byPlugin(
  status: Awaited<ReturnType<Fixture["status"]>>,
  pluginId: string,
) {
  const entry = status.plugins.find(
    (value) => value.selection.pluginId === pluginId,
  );
  assert.ok(entry);
  return entry;
}
export async function enableStandard(f: Fixture) {
  for (const id of ["provider", "consumer", "independent"]) {
    const source = f.source(id);
    await f.install(source);
    assert.equal((await f.select(source, 1)).projection.outcome, "applied");
  }
}
export function hasCause(error: unknown, code: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown; message?: unknown };
  return (
    value.code === code || value.message === code || hasCause(value.cause, code)
  );
}
