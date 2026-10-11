import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import type { PluginUiActionContext } from "@crewon/application";
import { createProjectConversationBinding } from "@crewon/domain";
import { workspaceNamespaceFixture } from "./plugin-project-workspace.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { PLUGIN_PROJECT_WORKSPACE_TABLE as table } from "./plugin-project-workspace-schema.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: explicit namespace migration, genuine installed invocation, replay, bounded paging and cold ownership`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend),
        reads = f.parent.pluginProjectWorkspaceNamespaces();
      assert.deepEqual(Object.keys(reads).sort(), [
        "listNamespaces",
        "loadNamespace",
      ]);
      assert.equal(
        await reads.loadNamespace({ owner: f.namespaceOwner() }),
        null,
      );
      assert.deepEqual(
        await reads.listNamespaces({
          owner: f.namespaceScope,
          afterProjectId: null,
          limit: 1,
        }),
        { namespaces: [], nextProjectId: null },
      );
      const mount = await f.mounted();
      await assert.rejects(mount.write());
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const result = await mount.write();
      assert.equal(
        (result as { disposition: string }).disposition,
        "committed",
      );
      const saved = await reads.loadNamespace({ owner: f.namespaceOwner() });
      assert.ok(saved);
      assert.equal(saved.workspaceId, "workspace-isolated");
      assert.equal(
        ((await mount.write()) as { disposition: string }).disposition,
        "replayed",
      );
      await assert.rejects(
        mount.write(
          f.namespaceRecipe(f.reference.projectId, "workspace-changed"),
        ),
      );
      for (const projectId of ["zz-a", "zz-b"])
        await mount.write(
          f.namespaceRecipe(projectId, `workspace-${projectId}`),
        );
      const first = await reads.listNamespaces({
        owner: f.namespaceScope,
        afterProjectId: null,
        limit: 2,
      });
      assert.equal(first.namespaces.length, 2);
      assert.equal(first.nextProjectId, "zz-a");
      const last = await reads.listNamespaces({
        owner: f.namespaceScope,
        afterProjectId: first.nextProjectId,
        limit: 2,
      });
      assert.deepEqual(
        last.namespaces.map((n) => n.owner.projectId),
        ["zz-b"],
      );
      assert.equal(last.nextProjectId, null);
      await assert.rejects(
        reads.listNamespaces({
          owner: f.namespaceScope,
          afterProjectId: null,
          limit: 51,
        }),
      );
      for (const [key, value] of Object.entries(f.namespaceOwner())) {
        const changed = {
          ...f.namespaceOwner(),
          [key]:
            key === "pluginId" || key === "publisherId"
              ? "other.namespace"
              : `${value}-other`,
        };
        assert.equal(await reads.loadNamespace({ owner: changed }), null);
      }
      const cold = await f.open();
      assert.deepEqual(
        await cold.parent
          .pluginProjectWorkspaceNamespaces()
          .loadNamespace({ owner: f.namespaceOwner() }),
        saved,
      );
      await assert.rejects(
        f.sql(`UPDATE ${f.prefix}${table} SET workspace_id='changed'`),
        /immutable/u,
      );
      await assert.rejects(
        f.sql(`DELETE FROM ${f.prefix}${table}`),
        /immutable/u,
      );
      assert.equal(await f.count(table), 3);
    },
  );

  test(
    `${backend}: ordinary creation/fork cannot borrow an owned workspace; original project transaction creates and replays binding`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const mount = await f.mounted();
      await mount.write();
      const p = await f.prepare(randomUUID(), "workspace-isolated");
      await assert.rejects(
        f.parent.commitThread(p.thread),
        /plugin_project_workspace_scope_conflict/u,
      );
      await assert.rejects(
        f.threads.createThread(f.actor, {
          kind: "thread.create",
          title: "Ordinary",
          workspaceId: "workspace-isolated",
          idempotencyKey: randomUUID(),
        }),
        /plugin_project_workspace_scope_conflict/u,
      );
      assert.equal(
        await f.parent.loadThread({
          tenantId: f.actor.tenantId,
          threadId: p.binding.threadId,
        }),
        null,
      );
      const bound = await f.store.commitBinding(p, { authority: f.authority });
      assert.equal(bound.disposition, "committed");
      assert.equal(
        (await f.store.commitBinding(p, { authority: f.authority }))
          .disposition,
        "replayed",
      );
      await assert.rejects(
        f.parent.commitThread(p.thread),
        /plugin_project_workspace_scope_conflict/u,
      );
      const event = p.thread.events[0]!;
      assert.equal(event.type, "thread.created");
      // Even a replay recipe omitting the workspace cannot retrieve a project creation receipt.
      const concealed = {
        ...p.thread,
        events: [{ ...event, data: { ...event.data, workspaceId: null } }],
      };
      await assert.rejects(
        f.parent.commitThread(concealed),
        /plugin_project_workspace_scope_conflict/u,
      );
      await assert.rejects(
        f.threads.forkThread(f.actor, {
          kind: "thread.fork",
          idempotencyKey: randomUUID(),
          sourceThreadId: p.binding.threadId,
          expectedSourceRevision: 1,
          throughHistorySequence: 0,
        }),
        /plugin_project_workspace_scope_conflict/u,
      );
      assert.equal(await f.count("project_conversation_bindings"), 1);
      const ordinary = await f.threads.createThread(f.actor, {
        kind: "thread.create",
        title: "Original workspace",
        workspaceId: "workspace-normal",
        idempotencyKey: randomUUID(),
      });
      const fork = await f.threads.forkThread(f.actor, {
        kind: "thread.fork",
        idempotencyKey: randomUUID(),
        sourceThreadId: ordinary.state.threadId,
        expectedSourceRevision: 1,
        throughHistorySequence: 0,
      });
      assert.equal(fork.state.workspaceId, "workspace-normal");
    },
  );

  test(
    `${backend}: project binding owner mismatch and final withdrawal roll back Thread, binding and receipt`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      await (await f.mounted()).write();
      const p = await f.prepare(randomUUID(), "workspace-isolated");
      const { schemaVersion: _s, contentDigest: _d, ...body } = p.binding;
      const other = createProjectConversationBinding(
        { ...body, projectId: "different-project" },
        f.digester,
      );
      await assert.rejects(
        f.store.commitBinding(
          { ...p, binding: other },
          { authority: f.authority },
        ),
        /plugin_project_workspace_scope_conflict/u,
      );
      f.state.withdrawAfterChecks = f.state.transactionChecks + 1;
      await assert.rejects(
        f.store.commitBinding(p, { authority: f.authority }),
        /owner_withdrawn/u,
      );
      assert.equal(
        await f.parent.loadThread({
          tenantId: f.actor.tenantId,
          threadId: p.binding.threadId,
        }),
        null,
      );
      assert.equal(
        await f.store.loadMutationReceipt({ ...f.owner, receipt: p.receipt }),
        null,
      );
      assert.equal(await f.count("project_conversation_bindings"), 0);
    },
  );

  test(
    `${backend}: namespace cannot adopt existing conversations or borrow another project workspace`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend);
      await f.threads.createThread(f.actor, {
        kind: "thread.create",
        idempotencyKey: randomUUID(),
        title: "Existing",
        workspaceId: "workspace-existing",
      });
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const mount = await f.mounted();
      await assert.rejects(
        mount.write(
          f.namespaceRecipe("existing-project", "workspace-existing"),
        ),
      );
      await mount.write();
      await assert.rejects(
        mount.write(f.namespaceRecipe("other-project", "workspace-isolated")),
      );
      assert.equal(await f.count(table), 1);
    },
  );

  test(
    `${backend}: detached/fake invocation, revocation and final mount withdrawal cannot persist namespace`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      let getterCalls = 0;
      const fake = Object.defineProperty({}, "actor", {
        get() {
          getterCalls++;
          throw Error("getter");
        },
      }) as PluginUiActionContext;
      await assert.rejects(
        f.parent.recordPluginProjectWorkspaceNamespaceFromPluginUi(
          fake,
          f.namespaceRecipe(),
        ),
      );
      assert.equal(getterCalls, 0);
      const mount = await f.mounted();
      f.namespaceState.beforeWrite = async () => {
        await assert.rejects(
          f.parent.recordPluginProjectWorkspaceNamespaceFromPluginUi(
            { ...f.namespaceState.context! },
            f.namespaceRecipe(),
          ),
        );
        f.namespaceState.allowed = false;
      };
      await assert.rejects(mount.write());
      assert.equal(await f.count(table), 0);
      f.namespaceState.allowed = true;
      f.namespaceState.beforeWrite = null;
      const current = await f.mounted();
      const restore = observeNamespaceInsert(backend, () => {
        void current.service.closeMount(f.actor, {
          mountRef: current.lease.mountRef,
        });
      });
      try {
        await assert.rejects(current.write());
      } finally {
        restore();
      }
      assert.equal(await f.count(table), 0);
      await assert.rejects(
        f.parent.recordPluginProjectWorkspaceNamespaceFromPluginUi(
          f.namespaceState.context!,
          f.namespaceRecipe(),
        ),
      );
      const disabled = await f.installs.commitSelection(
        selectionRecipe(f.enabled.selection, "namespace-disable", {
          actor: f.actor,
          state: "disabled",
        }),
      );
      assert.equal(disabled.selection.state, "disabled");
      await assert.rejects(mount.write());
      assert.equal(await f.count(table), 0);
    },
  );

  test(
    `${backend}: stable owner survives selected package upgrade; corrupt namespace schema fails closed`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      await (await f.mounted()).write();
      const before = await f.parent
        .pluginProjectWorkspaceNamespaces()
        .loadNamespace({ owner: f.namespaceOwner() });
      const next = await f.installs.recordInstalledPackage(
        installationRecipe("namespace-upgrade", {
          scope: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            profileId: f.installation.profileId,
          },
          actor: f.actor,
          pluginId: f.installation.pluginId,
          publisherId: f.installation.publisherId,
          version: "0.2.0",
          expectedSelectionRevision: f.enabled.selection.revision,
        }),
      );
      await f.installs.commitSelection(
        selectionRecipe(next.selection, "namespace-select-upgrade", {
          actor: f.actor,
          packageDigest: next.package.packageDigest,
        }),
      );
      assert.equal(
        ((await (await f.mounted()).write()) as { disposition: string })
          .disposition,
        "replayed",
      );
      assert.deepEqual(
        await f.parent
          .pluginProjectWorkspaceNamespaces()
          .loadNamespace({ owner: f.namespaceOwner() }),
        before,
      );
      await f.sql(
        backend === "sqlite"
          ? "DROP TRIGGER plugin_project_workspace_namespace_immutable"
          : `ALTER TABLE ${f.prefix}${table} DISABLE TRIGGER plugin_project_workspace_namespace_immutable`,
      );
      await assert.rejects(
        f.parent
          .pluginProjectWorkspaceNamespaces()
          .loadNamespace({ owner: f.namespaceOwner() }),
        /schema_invalid/u,
      );
      await assert.rejects(
        f.parent.migratePluginProjectWorkspaceNamespaces(),
        /schema_invalid/u,
      );
      await assert.rejects(
        f.threads.createThread(f.actor, {
          kind: "thread.create",
          title: null,
          workspaceId: "workspace-isolated",
          idempotencyKey: randomUUID(),
        }),
      );
      assert.equal(await f.count(table), 1);
    },
  );

  test(
    `${backend}: actual SQL selection withdrawal between Host preflight and transaction rejects namespace`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const mount = await f.mounted();
      const restore = observeNextTransactionBegin(backend, () =>
        f.second.parent.pluginInstallationStore().commitSelection(
          selectionRecipe(f.enabled.selection, "namespace-selection-race", {
            actor: f.actor,
            state: "disabled",
          }),
        ),
      );
      try {
        await assert.rejects(mount.write());
      } finally {
        restore();
      }
      assert.equal(await f.count(table), 0);
      const selection = await f.installs.loadSelection({
        scope: {
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          profileId: f.installation.profileId,
        },
        pluginId: f.installation.pluginId,
      });
      assert.equal(selection!.state, "disabled");
    },
  );

  test(
    `${backend}: partial namespace schema never becomes an ordinary workspace or migrates silently`,
    options,
    async (t) => {
      const f = await workspaceNamespaceFixture(t, backend);
      await f.sql(
        `CREATE TABLE ${f.prefix}plugin_project_workspace_schema_version(id INTEGER, version INTEGER)`,
      );
      await assert.rejects(
        f.parent
          .pluginProjectWorkspaceNamespaces()
          .loadNamespace({ owner: f.namespaceOwner() }),
        /schema_invalid/u,
      );
      await assert.rejects(
        f.parent.migratePluginProjectWorkspaceNamespaces(),
        /schema_invalid/u,
      );
      await assert.rejects(
        f.threads.createThread(f.actor, {
          kind: "thread.create",
          title: null,
          workspaceId: "workspace-isolated",
          idempotencyKey: randomUUID(),
        }),
      );
    },
  );
}

for (const change of ["deny", "epoch"] as const) {
  test(
    `postgres: original Host ${change} after actual namespace INSERT rolls back before COMMIT`,
    { skip: !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await workspaceNamespaceFixture(t, "postgres");
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const mount = await f.mounted();
      let inserted = 0;
      const restore = observeNamespaceInsert("postgres", () => {
        inserted++;
        if (change === "deny") f.namespaceState.allowed = false;
        else f.namespaceState.epoch = "namespace-test-withdrawn-epoch";
      });
      try {
        await assert.rejects(mount.write());
      } finally {
        restore();
      }
      assert.equal(inserted, 1);
      // A post-commit UI error alone is insufficient: the actual SQL row must be rolled back.
      assert.equal(await f.count(table), 0);
      assert.equal(
        await f.parent
          .pluginProjectWorkspaceNamespaces()
          .loadNamespace({ owner: f.namespaceOwner() }),
        null,
      );
    },
  );
}

/** Observe the actual INSERT, preserving SQL and native receivers, then change the original Host lifecycle/policy. */
function observeNamespaceInsert(
  backend: "sqlite" | "postgres",
  afterInsert: () => void,
): () => void {
  const prototype =
    backend === "sqlite" ? DatabaseSync.prototype : Client.prototype;
  const key = backend === "sqlite" ? "prepare" : "query";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
  Object.defineProperty(prototype, key, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(descriptor.value, this, args);
      if (
        typeof args[0] !== "string" ||
        !/INSERT INTO .*plugin_project_workspace_namespaces/u.test(args[0])
      )
        return result;
      if (backend === "postgres")
        return Promise.resolve(result).then((value) => {
          afterInsert();
          return value;
        });
      const statement = result as { run(...values: unknown[]): unknown },
        run = statement.run.bind(statement);
      statement.run = (...values: unknown[]) => {
        const value = run(...values);
        afterInsert();
        return value;
      };
      return result;
    },
  });
  return () => Object.defineProperty(prototype, key, descriptor);
}

/** The independent original installation writer revokes before the namespace transaction's first SQL fence. */
function observeNextTransactionBegin(
  backend: "sqlite" | "postgres",
  revoke: () => Promise<unknown>,
): () => void {
  const prototype =
    backend === "sqlite" ? DatabaseSync.prototype : Client.prototype;
  const key = backend === "sqlite" ? "exec" : "query";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
  const restore = () => Object.defineProperty(prototype, key, descriptor);
  Object.defineProperty(prototype, key, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      if (args[0] !== "BEGIN IMMEDIATE" && args[0] !== "BEGIN")
        return Reflect.apply(descriptor.value, this, args);
      restore();
      if (backend === "sqlite") {
        // The original unbound SQLite installation writer commits synchronously before returning its Promise.
        void revoke();
        return Reflect.apply(descriptor.value, this, args);
      }
      return Promise.resolve(Reflect.apply(descriptor.value, this, args)).then(
        async (value) => {
          await revoke();
          return value;
        },
      );
    },
  });
  return restore;
}
