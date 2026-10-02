import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { build } from "esbuild";
import {
  ExtensionTaskApplicationService,
  PluginUiApplicationService,
  PluginUiCommittedTaskAuthority,
  type CommitExtensionTurnResult,
  type ExtensionGenerationCreditQuote,
  type PluginUiAuthorizationPort,
  type PluginUiJsonValue,
} from "@crewon/application";
import type { PluginSelection } from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "../../store/src/extension-configuration-service.test-support.ts";
import {
  scope,
  timestamp,
} from "../../store/src/extension-store.test-support.ts";
import { extensionStoreDigester } from "../../store/src/extension-store-records.ts";
import { seedThread } from "../../store/src/thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../store/src/plugin-installation-store.test-support.ts";
import { installLocalPluginPackage } from "./local-plugin-package-installer.ts";
import { LocalPluginUiPackageReader } from "./plugin-ui-package-reader.ts";
import { PluginNodeHost } from "./plugin-node-host.ts";
import { PluginTaskActionBridge } from "./plugin-task-action-bridge.ts";

export { actor };
export const threadId = "installed-plugin-paid-thread";
export const commandInput = Object.freeze({
  threadId,
  expectedThreadRevision: 1,
  idempotencyKey: "installed-image-one",
  input: { prompt: "An independently installed task bridge fixture." },
});
export const creditScope = Object.freeze({
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId: "installed-plugin-fixture-pool",
});
// Test funding and quote only; these are not a product price or production payment policy.
const quote = Object.freeze({
  poolId: creditScope.poolId,
  priceRevision: 1,
  quotedCredits: "30",
});
const tables = [
  "messages",
  "model_history_items",
  "run_snapshots",
  "extension_run_bindings",
  "plugin_task_admissions",
  "extension_credit_admissions",
  "plugin_credit_reservations",
  "plugin_credit_entries",
  "outbox",
  "work_items",
] as const;

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real SQLite, installed/bundled ESM and application services; current policies are explicit fixtures. */
export async function taskActionFixture(t: TestContext) {
  const f = await configurationServiceFixture(t, "sqlite");
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  await seedThread(f.first.parent, { ...actor, threadId });
  await f.first.store.migrateCredits();
  const ledger = f.first.parent.pluginInstallationStore();
  await ledger.migrate();
  await f.first.store.migratePluginAdmissions();
  const credits = f.first.parent.pluginCreditStore();
  await credits.grant({
    scope: creditScope,
    grantId: "installed-plugin-fixture-funding",
    credits: "100",
  });

  const root = await mkdtemp(join(tmpdir(), "crewon-task-bridge-installed-"));
  await chmod(root, 0o700);
  const source = join(root, "developer");
  const installRoot = join(root, "installed");
  await mkdir(source, { mode: 0o700 });
  await mkdir(installRoot, { mode: 0o700 });
  const profile = Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "installed-task-profile",
  });
  const state = {
    epoch: "installed-task-epoch-1",
    denyUi: false,
    now: timestamp,
    selection: null as PluginSelection | null,
    quote: { ...quote } as ExtensionGenerationCreditQuote,
    quoteCalls: 0,
    quoteGate: null as Promise<void> | null,
    quoteEntered: null as (() => void) | null,
    afterCommit: null as
      | ((result: CommitExtensionTurnResult) => Promise<void>)
      | null,
    readGate: null as Promise<void> | null,
    readEntered: null as (() => void) | null,
    useSecondConnection: false,
    accepted: [] as CommitExtensionTurnResult[],
  };
  const tasksFor = (storage: typeof f.first) =>
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      store: storage.parent,
      extensions: storage.store,
      operations: f.operations,
      ids: { nextId: () => randomUUID() },
      creditQuotes: {
        async quoteGeneration() {
          state.quoteCalls++;
          state.quoteEntered?.();
          await state.quoteGate;
          return { ...state.quote };
        },
      },
    });
  const firstTasks = tasksFor(f.first);
  const secondTasks = tasksFor(f.second);
  const authority = new PluginUiCommittedTaskAuthority({
    extensions: f.first.store,
    runs: f.first.parent,
    digester: extensionStoreDigester,
  });
  const authorization: PluginUiAuthorizationPort = {
    authorize: async () =>
      state.denyUi
        ? { outcome: "deny", reasonCode: "fixture_ui_denied" }
        : { outcome: "allow", authorityEpoch: state.epoch },
  };
  const profiles = { resolve: async () => profile };
  const bridge = new PluginTaskActionBridge({
    tasks: {
      async createTaskFromPlugin(...args) {
        const result = await (
          state.useSecondConnection ? secondTasks : firstTasks
        ).createTaskFromPlugin(...args);
        state.accepted.push(result);
        await state.afterCommit?.(result);
        return result;
      },
    },
    committedTasks: authority,
    profiles,
    authorization,
    // This fixture has one coordinated selection writer. The projection is replaced only by its real
    // confirmed SQLite result; production ownership/identity policies are not exercised here.
    currentSelection: ({ scope: requested, pluginId }) =>
      JSON.stringify(requested) === JSON.stringify(profile) &&
      pluginId === scope.pluginId
        ? state.selection
        : null,
    clock: { now: () => state.now },
    ids: { nextId: () => randomBytes(32).toString("base64url") },
  });
  const nodeHost = new PluginNodeHost({
    services: [
      bridge.hostService(),
      {
        service: "fixture.lifecycle",
        apiVersion: "1",
        value: {
          async read() {
            state.readEntered?.();
            await state.readGate;
            return { value: "read fixture" };
          },
        },
      },
    ],
  });
  t.after(async () => {
    bridge.close();
    try {
      await nodeHost.close();
    } finally {
      await removeOwnedTree(root);
    }
  });

  await writeFile(
    join(source, "entry.ts"),
    `
import { definePlugin, CREWON_TASKS_SERVICE, CREWON_TASKS_API_VERSION, type PluginTaskService, type PluginActionsService } from '@crewon/plugin-sdk/node';
export default definePlugin({apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(scope.pluginId)},setup(context){
  const tasks = context.services.get<PluginTaskService>(CREWON_TASKS_SERVICE,CREWON_TASKS_API_VERSION);
  const lifecycle = context.services.get<{read():Promise<{value:string}>}>('fixture.lifecycle','1');
  const actions:PluginActionsService = {
    actions:[{contributionId:'workbench',action:'image.generate',kind:'generateTask'},{contributionId:'workbench',action:'image.read',kind:'read'}],
    async invoke({invocationRef,action,input}){
      if(action==='image.read') return lifecycle.read();
      const request=input as {threadId:string;expectedThreadRevision:number;idempotencyKey:string;input:Record<string,string>};
      return tasks.createTask({invocationRef,threadId:request.threadId,expectedThreadRevision:request.expectedThreadRevision,idempotencyKey:request.idempotencyKey,input:request.input});
    }
  };
  context.services.provide(${JSON.stringify(scope.pluginId)},'1',actions);
}});
`,
  );
  await build({
    entryPoints: [join(source, "entry.ts")],
    outfile: join(source, "entry.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
    nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
  });
  await rm(join(source, "entry.ts"));
  await writeFile(
    join(source, "ui.mjs"),
    "export default {apiVersion:'crewon.plugin-ui.v1',pluginId:'crewon.comfyui-krea2',mount(){return {update(){},dispose(){}}}};",
  );
  const files = await Promise.all(
    ["entry.mjs", "ui.mjs"].map(async (path) => {
      const bytes = await readFile(join(source, path));
      return {
        path,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
  await writeFile(
    join(source, "crewon.plugin.json"),
    JSON.stringify({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId: scope.pluginId,
      version: "0.1.0",
      title: "Installed task fixture",
      description:
        "Real installed bundle; no provider execution or production policy.",
      publisherId: "example.fixture",
      entrypoints: {
        node: "entry.mjs",
        ui: { path: "ui.mjs", mode: "trustedModule" },
      },
      businessManifestPath: null,
      requires: [
        { service: "crewon.tasks", apiVersion: "1", optional: false },
        { service: "fixture.lifecycle", apiVersion: "1", optional: false },
      ],
      provides: [{ service: scope.pluginId, apiVersion: "1" }],
      contributions: [
        {
          id: "workbench",
          kind: "module",
          slot: "main.content",
          title: "Task fixture",
        },
      ],
      files,
    }),
  );
  const installed = await installLocalPluginPackage({
    directory: source,
    installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const saved = await ledger.recordInstalledPackage(
    installationRecipe("fixture-install", {
      actor,
      scope: profile,
      pluginId: scope.pluginId,
      version: installed.descriptor.version,
      publisherId: installed.descriptor.publisherId,
      packageDigest: installed.packageDigest,
    }),
  );
  const enabled = await ledger.commitSelection(
    selectionRecipe(saved.selection, "fixture-enable", { actor }),
  );
  state.selection = enabled.selection;
  await rm(source, { recursive: true, force: true });
  await nodeHost.activate({
    installRoot,
    expectedPluginId: scope.pluginId,
    expectedPackageDigest: installed.packageDigest,
    authorizeActivation: () => "allow",
  });
  const packages = new LocalPluginUiPackageReader({
    profile,
    installRoot,
    authorizePublication: async () => ["ui.mjs"],
  });
  const service = new PluginUiApplicationService({
    store: ledger,
    profiles,
    authorization,
    packages,
    actions: bridge.actions(nodeHost),
    committedTasks: authority,
    clock: { now: () => state.now },
    ids: { nextId: () => randomBytes(32).toString("base64url") },
  });
  const openMount = () =>
    service.openMount(actor, {
      pluginId: scope.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: enabled.selection.revision,
      expectedPackageDigest: installed.packageDigest,
    });
  const lease = await openMount();
  const invoke = (
    action = "image.generate",
    input: PluginUiJsonValue = commandInput,
  ) => service.invoke(actor, { mountRef: lease.mountRef, action, input });
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, await f.count(table)]),
      ),
    );
  const disable = async () => {
    assert.ok(state.selection);
    const result = await ledger.commitSelection(
      selectionRecipe(state.selection, "fixture-disable", {
        actor,
        state: "disabled",
      }),
    );
    state.selection = result.selection;
    nodeHost.deactivate(scope.pluginId);
    assert.deepEqual(
      await ledger.loadSelection({ scope: profile, pluginId: scope.pluginId }),
      state.selection,
    );
  };
  return {
    ...f,
    extensionState: f.state,
    bridge,
    nodeHost,
    authority,
    service,
    ledger,
    credits,
    profile,
    installed,
    enabled,
    state,
    lease,
    invoke,
    counts,
    disable,
  };
}

async function removeOwnedTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwnedTree(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
