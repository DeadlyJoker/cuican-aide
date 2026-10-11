import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  PluginUiApplicationService,
  PluginUiCommittedTaskAuthority,
} from "@crewon/application";
import {
  LocalPluginUiPackageReader,
  PluginTaskActionBridge,
} from "@crewon/plugin-host";
import {
  actor,
  scope,
  fixture,
} from "./desktop-plugin-instance-composition.test-support.ts";

test(
  "real mounted UI borrows the original Native profile consumer and its shared provider, without setup or cleanup leaks",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t, [
      { id: "provider", kind: "provider" },
      { id: "reader", kind: "actionConsumer" },
    ]);
    await f.open("installation");
    const runtime = f.runtime;
    assert.ok("service" in runtime);
    for (const source of f.sources) {
      await f.install(source);
      await f.select(source, 1);
    }
    const source = f.source("reader");
    const ledger = f.store.pluginInstallationStore();
    const selection = await ledger.loadSelection({
      scope,
      pluginId: source.pluginId,
    });
    assert.ok(selection);
    const committedTasks = new PluginUiCommittedTaskAuthority({
      extensions: f.store.extensionStore(),
      runs: f.store,
      digester: {
        sha256: (text) =>
          `sha256:${createHash("sha256").update(text).digest("hex")}`,
      },
    });
    const clock = { now: () => "2026-10-11T00:00:00.000Z" };
    const authorization = {
      async authorize() {
        return {
          outcome: "allow" as const,
          authorityEpoch: "instance-real-native-source-epoch-01",
        };
      },
    };
    const profiles = {
      async resolve() {
        return scope;
      },
    };
    const bridge = new PluginTaskActionBridge({
      tasks: {
        async createTaskFromPlugin() {
          throw new Error("read_must_not_create_task");
        },
      },
      committedTasks,
      profiles,
      authorization,
      currentSelection: ({ scope: requested, pluginId }) =>
        requested.profileId === scope.profileId && pluginId === source.pluginId
          ? selection
          : null,
      clock,
      ids: { nextId: () => randomBytes(32).toString("base64url") },
    });
    const ui = new PluginUiApplicationService({
      store: ledger,
      profiles,
      authorization,
      packages: new LocalPluginUiPackageReader({
        profile: scope,
        installRoot: f.installRoot,
        authorizePublication: async () => ["ui.mjs"],
      }),
      actions: bridge.actionsFromBorrower({
        borrow(context, authorizeBorrow) {
          return runtime.borrowNode({
            actor: context.actor,
            scope: context.scope,
            pluginId: context.package.pluginId,
            packageDigest: context.package.packageDigest,
            authorizeBorrow,
          });
        },
      }),
      committedTasks,
      clock,
      ids: { nextId: () => randomBytes(32).toString("base64url") },
    });
    t.after(() => bridge.close());
    const mount = await ui.openMount(actor, {
      pluginId: source.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: selection.revision,
      expectedPackageDigest: source.packageDigest,
    });
    const invoke = () =>
      ui.invoke(actor, {
        mountRef: mount.mountRef,
        action: "read",
        input: null,
      });
    const events = [...f.probe.events];
    assert.deepEqual(await invoke(), { generation: 1, version: "1.0.0" });
    assert.deepEqual(f.probe.events, events);
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.probe.gates.reader = { readEntered: entered, readWait: gate };
    const pending = invoke();
    void pending.catch(() => {});
    try {
      await started;
      await f.select(f.source("provider"), 2, "disabled");
    } finally {
      resume();
    }
    await assert.rejects(pending);
    await assert.rejects(invoke());
    // Profile.close really waits on borrowed handles; this would hang if the bridge only released the raw lease.
    await f.close();
  },
);
