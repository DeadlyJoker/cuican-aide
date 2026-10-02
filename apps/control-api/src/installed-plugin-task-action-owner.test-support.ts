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
import type { TestContext } from "node:test";
import {
  ExtensionTaskApplicationService,
  PluginUiApplicationService,
  PluginUiCommittedTaskAuthority,
  type ActorContext,
  type CommitExtensionTurnResult,
  type PluginUiActionContext,
  type PluginUiAuthorizationPort,
  type PluginUiJsonValue,
} from "@crewon/application";
import type { PluginProfileScope } from "@crewon/domain";
import {
  installLocalPluginPackage,
  LocalPluginUiPackageReader,
} from "@crewon/plugin-host";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import {
  scope,
  timestamp,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { InstalledPluginTaskActionOwner } from "./installed-plugin-task-action-owner.ts";

export { actor, scope };
export const commandInput = Object.freeze({
  threadId: "production-owned-plugin-thread",
  expectedThreadRevision: 1,
  idempotencyKey: "production-owned-plugin-generate",
  input: {
    prompt:
      "An actual installed package task through an owned production action port.",
  },
});
export const creditScope = Object.freeze({
  tenantId: actor.tenantId,
  principalId: actor.principalId,
  poolId: "explicit-test-funding",
});
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Actual immutable installer bytes, SQLite services and live invocation capabilities. Policies/prices are explicit test fixtures. */
export async function ownedActionFixture(
  t: TestContext,
  options: {
    backend?: "sqlite" | "postgres";
    maximumPackages?: number;
    setupFailure?: boolean;
    cleanupFailure?: boolean;
  } = {},
) {
  const storage = await configurationServiceFixture(
    t,
    options.backend ?? "sqlite",
  );
  await storage.seedDeployment();
  await storage.service.saveConfiguration(actor, saveCommand);
  await storage.service.setActivation(actor, activateCommand);
  await seedThread(storage.first.parent, {
    ...actor,
    threadId: commandInput.threadId,
  });
  await storage.first.store.migrateCredits();
  const ledger = storage.first.parent.pluginInstallationStore();
  await ledger.migrate();
  await storage.first.store.migratePluginAdmissions();
  const credits = storage.first.parent.pluginCreditStore();
  await credits.grant({
    scope: creditScope,
    grantId: "explicit-test-grant",
    credits: "100",
  });
  const root = await mkdtemp(join(tmpdir(), "crewon-owned-actions-"));
  await chmod(root, 0o700);
  const installRoot = join(root, "installed");
  await mkdir(installRoot, { mode: 0o700 });
  const profile: PluginProfileScope = Object.freeze({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "production-action-fixture",
  });
  const state = {
    actor: { ...actor } as ActorContext | null,
    profile: { ...profile },
    epoch: "owned-action-epoch-1",
    denyUi: false,
    allowPackage: true,
    packageReads: 0,
    actorReads: 0,
    quoteCalls: 0,
    setups: 0,
    disposals: 0,
    calls: 0,
    execution: undefined as unknown,
    setupFailure: options.setupFailure ?? false,
    cleanupFailure: options.cleanupFailure ?? false,
    setupGate: null as Promise<void> | null,
    setupEntered: null as (() => void) | null,
    readGate: null as Promise<void> | null,
    readEntered: null as (() => void) | null,
    disposalGate: null as Promise<void> | null,
    disposalEntered: null as (() => void) | null,
    quoteGate: null as Promise<void> | null,
    quoteEntered: null as (() => void) | null,
    onPackage: null as (() => Promise<void>) | null,
    afterCommit: null as
      | ((result: CommitExtensionTurnResult) => Promise<void>)
      | null,
    lastContext: null as PluginUiActionContext | null,
    accepted: [] as CommitExtensionTurnResult[],
  };
  const key = `__crewon_owned_action_fixture_${randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = state;
  const install = async (version = "0.1.0") => {
    const source = join(root, `developer-${randomUUID()}`);
    await mkdir(source, { mode: 0o700 });
    const node = `
const state=globalThis[${JSON.stringify(key)}];
export default {apiVersion:'crewon.plugin-host.v1',pluginId:${JSON.stringify(scope.pluginId)},async setup(context){
  state.setups++;
  context.onDispose(async()=>{state.disposals++;state.disposalEntered?.();await state.disposalGate;if(state.cleanupFailure)throw new Error('actual-fixture-dispose-failed');});
  const tasks=context.services.getOptional('crewon.tasks','1');
  state.execution=context.services.getOptional('crewon.execution','1');
  state.setupEntered?.();await state.setupGate;
  if(state.setupFailure)throw new Error('actual-fixture-setup-failed');
  context.services.provide(${JSON.stringify(scope.pluginId)},'1',{
    actions:[{contributionId:'workbench',action:'image.generate',kind:'generateTask'},{contributionId:'workbench',action:'image.read',kind:'read'}],
    async invoke({invocationRef,action,input}){
      state.calls++;
      if(action==='image.read'){state.readEntered?.();await state.readGate;return {value:'installed-read'};}
      return tasks.createTask({invocationRef,...input});
    }
  });
}};`;
    await writeFile(join(source, "entry.mjs"), node);
    await writeFile(
      join(source, "ui.mjs"),
      `export default {apiVersion:'crewon.plugin-ui.v1',pluginId:${JSON.stringify(scope.pluginId)},mount(){return {update(){},dispose(){}}}};`,
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
        version,
        title: "Owned action fixture",
        description:
          "Actual installed tasks owner. Explicit test policy and funding only.",
        publisherId: "example.fixture",
        entrypoints: {
          node: "entry.mjs",
          ui: { path: "ui.mjs", mode: "trustedModule" },
        },
        businessManifestPath: null,
        requires: [
          { service: "crewon.tasks", apiVersion: "1", optional: true },
          { service: "crewon.execution", apiVersion: "1", optional: true },
        ],
        provides: [{ service: scope.pluginId, apiVersion: "1" }],
        contributions: [
          {
            id: "workbench",
            kind: "module",
            slot: "main.content",
            title: "Owned fixture",
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
    const prior = await ledger.loadSelection({
      scope: profile,
      pluginId: scope.pluginId,
    });
    const saved = await ledger.recordInstalledPackage(
      installationRecipe(`install-${version}`, {
        actor,
        scope: profile,
        pluginId: scope.pluginId,
        version: installed.descriptor.version,
        publisherId: installed.descriptor.publisherId,
        packageDigest: installed.packageDigest,
        expectedSelectionRevision: prior?.revision ?? null,
      }),
    );
    const enabled = await ledger.commitSelection(
      selectionRecipe(saved.selection, `enable-${version}`, {
        actor,
        packageDigest: installed.packageDigest,
      }),
    );
    await rm(source, { recursive: true });
    return { ...installed, selection: enabled.selection };
  };
  const installed = await install();
  const tasks = new ExtensionTaskApplicationService({
    ...storage.dependencies,
    store: storage.first.parent,
    extensions: storage.first.store,
    operations: storage.operations,
    ids: { nextId: () => randomUUID() },
    creditQuotes: {
      async quoteGeneration() {
        state.quoteCalls++;
        state.quoteEntered?.();
        await state.quoteGate;
        return {
          poolId: creditScope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        };
      },
    },
  });
  // This instrumentation awaits the original actual transaction; it never supplies a synthetic receipt.
  const createTask = tasks.createTaskFromPlugin.bind(tasks);
  tasks.createTaskFromPlugin = async (...args) => {
    const result = await createTask(...args);
    state.accepted.push(result);
    await state.afterCommit?.(result);
    return result;
  };
  const committedTasks = new PluginUiCommittedTaskAuthority({
    extensions: storage.first.store,
    runs: storage.first.parent,
    digester: extensionStoreDigester,
  });
  const authorization: PluginUiAuthorizationPort = {
    authorize: async () =>
      state.denyUi
        ? { outcome: "deny", reasonCode: "fixture_denied" }
        : { outcome: "allow", authorityEpoch: state.epoch },
  };
  const profiles = { resolve: async () => ({ ...state.profile }) };
  const dependencies = {
    installRoot,
    installations: ledger,
    tasks,
    committedTasks,
    authorization,
    profiles,
    resolveActor: async (_owner: unknown, _signal: AbortSignal) => {
      state.actorReads++;
      return state.actor === null ? null : { ...state.actor };
    },
    authorizePackage: async (
      _input: unknown,
      _signal: AbortSignal,
    ): Promise<"allow" | "deny"> => {
      state.packageReads++;
      await state.onPackage?.();
      return state.allowPackage ? "allow" : "deny";
    },
    clock: { now: () => timestamp },
    ids: { nextId: () => randomBytes(32).toString("base64url") },
    maximumPackages: options.maximumPackages,
  };
  const owner = new InstalledPluginTaskActionOwner(dependencies);
  t.after(async () => {
    try {
      await owner.close();
    } catch {
      /* An intentionally failed real disposer is asserted by its test. */
    }
    delete globals[key];
    await removeOwnedTree(root);
  });
  const service = new PluginUiApplicationService({
    store: ledger,
    clock: dependencies.clock,
    ids: dependencies.ids,
    profiles: { resolve: profiles.resolve.bind(profiles) },
    authorization: { authorize: authorization.authorize.bind(authorization) },
    packages: new LocalPluginUiPackageReader({
      profile,
      installRoot,
      authorizePublication: async () => ["ui.mjs"],
    }),
    actions: {
      invoke: (context) => {
        state.lastContext = context;
        return owner.actions.invoke(context);
      },
    },
    committedTasks: owner.committedTasks,
  });
  const open = async (who = actor) => {
    const selection = await ledger.loadSelection({
      scope: profile,
      pluginId: scope.pluginId,
    });
    if (!selection?.selectedPackageDigest)
      throw new Error("fixture_selection_missing");
    return service.openMount(who, {
      pluginId: scope.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: selection.revision,
      expectedPackageDigest: selection.selectedPackageDigest,
    });
  };
  const lease = await open();
  const invoke = (
    action = "image.generate",
    input: PluginUiJsonValue = commandInput,
    who = actor,
    mount = lease,
  ) => service.invoke(who, { mountRef: mount.mountRef, action, input });
  const disable = async () => {
    const selection = await ledger.loadSelection({
      scope: profile,
      pluginId: scope.pluginId,
    });
    if (!selection) throw new Error("fixture_selection_missing");
    return ledger.commitSelection(
      selectionRecipe(selection, `disable-${randomUUID()}`, {
        actor,
        state: "disabled",
      }),
    );
  };
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "messages",
          "run_snapshots",
          "extension_run_bindings",
          "plugin_task_admissions",
          "extension_credit_admissions",
          "plugin_credit_reservations",
          "plugin_credit_entries",
        ].map(async (table) => [table, await storage.count(table)]),
      ),
    );
  return {
    ...storage,
    owner,
    state,
    dependencies,
    ledger,
    credits,
    profile,
    installRoot,
    installed,
    install,
    service,
    open,
    lease,
    invoke,
    disable,
    counts,
  };
}

async function removeOwnedTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await removeOwnedTree(join(directory, entry.name));
  await rm(directory, { recursive: true, force: true });
}
