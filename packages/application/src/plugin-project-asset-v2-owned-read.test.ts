import { ThreadApplicationService } from "./thread-application-service.ts";
import { createProjectConversationBinding } from "@crewon/domain";
import { textDigester } from "../../store/src/project-text-store.test-support.ts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import { PROJECT_ASSET_V2_ACTIONS as actions } from "@crewon/contracts/project-assets-v2";
import {
  assetTestOptions,
  projectAssetFixture,
  assetAt,
} from "../../store/src/project-asset.test-support.ts";
import { pluginProjectMetadataOwnerColumns } from "../../store/src/plugin-project-metadata-owner-records.ts";
import { namespaceColumns } from "../../store/src/plugin-project-workspace-store-support.ts";
import { PLUGIN_PROJECT_WORKSPACE_TABLE } from "../../store/src/plugin-project-workspace-schema.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginProjectAssetV2ActionOwner } from "./plugin-project-asset-v2-action-owner.ts";
import { ProjectAssetV2ApplicationService } from "./project-asset-v2-application-service.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedMetadataOutcome,
} from "./plugin-ui-ports.ts";
import { uiTestDescriptor, uiTestBytes } from "./plugin-ui.test-support.ts";
import { issuePluginProjectAssetUiReadScope } from "./plugin-project-asset-ui-read-scope.ts";

const sql = (value: unknown) => "'" + String(value).replaceAll("'", "''") + "'";
async function fixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  foreign = false,
) {
  const f = await projectAssetFixture(t, backend),
    install = f.installation;
  const candidate = f.creation("v2-owned-read-seed");
  await f.stage(candidate);
  const saved = await f.write(candidate);
  // Original binding writer and Thread manager, with a named Store policy fixture.
  // No model, Run, native allocator or production execution grant is fabricated.
  await f.parent.extensionStore().migrate();
  await f.parent.extensionStore().migratePluginAdmissions();
  const conversationStore = f.parent.projectConversationStore();
  await conversationStore.migrate();
  const g = f.legacyGrant("project.execute").authority;
  assert.ok(g.transaction);
  const threads = new ThreadApplicationService({
    store: f.parent,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => assetAt },
    ids: { nextId: () => randomUUID() },
    digester: textDigester,
    workspaceAdmission: { admit: async () => {} },
  });
  const thread = await threads.prepareCreateThread(f.actor, {
    kind: "thread.create",
    title: "V2 archive context",
    workspaceId: "v2-owned-read-workspace",
    idempotencyKey: "v2-read-bound-thread",
  });
  const event = thread.events[0];
  assert.equal(event?.type, "thread.created");
  assert.ok(event);
  const binding = createProjectConversationBinding(
    {
      bindingId: randomUUID(),
      owner: f.actor,
      profileId: install.profileId,
      projectId: f.project.project.projectId,
      threadId: event.identity.threadId,
      workspaceId: "v2-owned-read-workspace",
      revision: 1,
      state: "active",
      currentInstallation: install,
      createdAt: assetAt,
      updatedAt: assetAt,
    },
    textDigester,
  );
  await conversationStore.commitBinding(
    {
      kind: "create",
      binding,
      expectedRevision: 0,
      receipt: {
        actor: f.actor,
        idempotencyKey: "v2-read-bound-thread",
        requestDigest: textDigester.sha256("v2-read-bound-thread"),
      },
      thread,
    },
    {
      authority: {
        version: "crewon.project-conversation-commit.v1",
        actor: f.actor,
        installation: install,
        selection: f.source.selection,
        package: f.source.package,
        pin: g.transaction.pin,
        assertActive: g.assertActive,
        assertCurrent: g.assertCurrent,
        assertTransactionCurrent: g.transaction.assertCurrent,
      },
    },
  );
  await f.parent.migratePluginProjectOwnership();
  await f.parent.migratePluginProjectWorkspaceNamespaces();
  const owner = {
    ...f.actor,
    profileId: foreign ? "foreign-profile" : install.profileId,
    pluginId: install.pluginId,
    publisherId: install.publisherId,
    projectId: f.project.project.projectId,
  };
  const values = [
    owner.tenantId,
    owner.spaceId,
    owner.principalId,
    owner.actorId,
    owner.profileId,
    owner.pluginId,
    owner.publisherId,
    owner.projectId,
  ];
  const metadata = {
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner,
    createdAt: assetAt,
  };
  const namespace = {
    schemaVersion: "crewon.plugin-project-workspace-namespace.v1",
    owner,
    workspaceId: "v2-owned-read-workspace",
    createdAt: assetAt,
  };
  await f.execute(
    `INSERT INTO ${f.prefix}plugin_project_metadata_owners(${pluginProjectMetadataOwnerColumns.join(",")}) VALUES(${[...values, assetAt, JSON.stringify(metadata)].map(sql).join(",")})`,
  );
  await f.execute(
    `INSERT INTO ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}(${namespaceColumns}) VALUES(${[...values, namespace.workspaceId, assetAt, JSON.stringify(namespace)].map(sql).join(",")})`,
  );
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: install.pluginId,
    version: install.version,
    publisherId: install.publisherId,
    entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
    requires: [
      { service: "crewon.project-assets", apiVersion: "2", optional: false },
      {
        service: "crewon.project-asset-recovery",
        apiVersion: "2",
        optional: true,
      },
    ],
  });
  const assets = new ProjectAssetV2ApplicationService({
    assets: f.assets,
    access: "read-only",
  });
  const state = {
    allowed: true,
    context: null as PluginUiActionContext | null,
    probe: null as ((context: PluginUiActionContext) => Promise<void>) | null,
  };
  const check = async () => {
    if (!state.allowed) throw Error("named_asset_v2_host_withdrawn");
  };
  const ownerPort = new PluginProjectAssetV2ActionOwner({
    assets,
    publications: [
      {
        pluginId: install.pluginId,
        packageDigest: install.packageDigest,
        contributionId: "workbench",
      },
    ],
    authorization: { authorize: check },
  });
  t.after(() => ownerPort.close());
  const scope = {
    tenantId: install.tenantId,
    spaceId: install.spaceId,
    profileId: install.profileId,
  };
  const service = new PluginUiApplicationService({
    store: f.parent.pluginInstallationStore(),
    profiles: { resolve: async () => scope },
    authorization: {
      authorize: async () =>
        state.allowed
          ? { outcome: "allow", authorityEpoch: "v2-read-epoch" }
          : { outcome: "deny", reasonCode: "named_asset_v2_denied" },
    },
    packages: {
      verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
      readAsset: async () => ({
        bytes: uiTestBytes,
        contentType: "text/javascript; charset=utf-8",
      }),
    },
    clock: { now: () => assetAt },
    ids: { nextId: () => randomBytes(32).toString("base64url") },
    committedMetadata: {
      isOutcome: (v: unknown): v is PluginUiCommittedMetadataOutcome =>
        ownerPort.committedMetadata.isOutcome(v),
      verify: (c, o) => ownerPort.committedMetadata.verify(c, o),
    },
    actions: {
      invoke: async (context) => {
        state.context = context;
        await state.probe?.(context);
        return ownerPort.actions.invoke(context);
      },
    },
  });
  const mount = await service.openMount(f.actor, {
    pluginId: install.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: install.selectionRevision,
    expectedPackageDigest: install.packageDigest,
  });
  const invoke = (method: keyof typeof actions, input: unknown) =>
    service.invoke(f.actor, {
      mountRef: mount.mountRef,
      action: actions[method],
      input: input as never,
    });
  return { ...f, saved, state, ownerPort, namespace, assetsV2: assets, invoke };
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: original installed Asset V2 read opens only its protected archive and preserves request scope`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        projectId = f.project.project.projectId,
        assetId = f.saved.asset.assetId;
      await assert.rejects(
        f.assets.listAssets(f.actor, {
          projectId,
          kind: null,
          afterAssetId: null,
          limit: 16,
        }),
      );
      for (const method of [
        "saveCandidate",
        "selectRevision",
        "setLocked",
        "saveReferenceCandidate",
        "selectReference",
        "adoptMediaReference",
      ] as const)
        assert.equal(f.ownerPort.supportsAction(actions[method]), false);
      assert.equal(
        f.ownerPort.supportsAction(
          "crewon.project-asset-recovery.v2.getPending",
        ),
        false,
      );
      await assert.rejects(
        f.assetsV2.mutate(f.actor, {} as never, {} as never),
        /project_asset_v2_read_only/,
      );
      await assert.rejects(
        f.assetsV2.adoptReference(f.actor, {} as never, {} as never),
        /project_asset_v2_read_only/,
      );
      const list = await f.invoke("listAssets", {
        projectId,
        afterAssetId: null,
        limit: 16,
      });
      assert.ok(
        list &&
          typeof list === "object" &&
          "assets" in list &&
          Array.isArray(list.assets),
      );
      assert.equal(list.assets.length, 1);
      const view = await f.invoke("getAsset", { projectId, assetId });
      assert.ok(
        view &&
          typeof view === "object" &&
          "view" in view &&
          view.view !== null,
      );
      let source:
        | Awaited<ReturnType<typeof issuePluginProjectAssetUiReadScope>>
        | undefined;
      f.state.probe = async (context) => {
        const authority = {
          assertCurrent: async () => {},
          assertTransactionCurrent: async () => {},
          assertActive: () => {},
        };
        await assert.rejects(
          issuePluginProjectAssetUiReadScope({
            context: { ...context },
            authority,
          }),
        );
        source = await issuePluginProjectAssetUiReadScope({
          context,
          authority,
        });
        const bound = await f.assets.bindPluginProjectReads(source);
        await assert.rejects(
          bound.getRevision(f.actor, {
            projectId,
            assetId,
            contentRevision: 2,
          }),
          (error) =>
            error instanceof Error &&
            error.cause instanceof Error &&
            error.cause.message === "plugin_project_read_target_mismatch",
        );
        await assert.rejects(
          bound.selectRevision(f.actor, {
            projectId,
            assetId,
            expectedAssetRevision: 1,
            contentRevision: 1,
            idempotencyKey: "read-scope-no-write",
          }),
        );
      };
      const revision = await f.invoke("getRevision", {
        projectId,
        assetId,
        contentRevision: 1,
      });
      assert.ok(
        revision &&
          typeof revision === "object" &&
          "contentRevision" in revision,
      );
      f.state.probe = null;
      assert.ok(source);
      await assert.rejects(f.assets.bindPluginProjectReads(source));
      await assert.rejects(async () =>
        f.ownerPort.actions.invoke({ ...f.state.context! }),
      );
      f.state.allowed = false;
      await assert.rejects(
        f.invoke("listAssets", { projectId, afterAssetId: null, limit: 16 }),
      );
      assert.equal(
        Number(
          (
            await f.query(`SELECT COUNT(*) AS n FROM ${f.prefix}project_assets`)
          )[0]!.n,
        ),
        1,
      );
    },
  );
  test(
    `${backend}: original Asset V2 readonly invocation rejects missing and changed namespace`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend),
        projectId = f.project.project.projectId;
      // Corrupt only this isolated fixture schema; restore the original guards before every read.
      const corrupt = async (statement: string, kind: "update" | "delete") => {
        const trigger = "plugin_project_workspace_namespace_immutable";
        if (backend === "postgres") {
          await f.execute(
            `ALTER TABLE ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} DISABLE TRIGGER ${trigger}`,
          );
          await f.execute(statement);
          await f.execute(
            `ALTER TABLE ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} ENABLE TRIGGER ${trigger}`,
          );
        } else {
          const name = trigger + (kind === "delete" ? "_no_delete" : "");
          const definition = (
            await f.query(
              `SELECT sql FROM sqlite_master WHERE type='trigger' AND name=${sql(name)}`,
            )
          )[0]!.sql as string;
          await f.execute(`DROP TRIGGER ${name}`);
          await f.execute(statement);
          await f.execute(definition);
        }
      };
      await corrupt(
        `DELETE FROM ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} WHERE project_id=${sql(projectId)}`,
        "delete",
      );
      await assert.rejects(
        f.invoke("listAssets", { projectId, afterAssetId: null, limit: 16 }),
      );
      const values = [
        f.namespace.owner.tenantId,
        f.namespace.owner.spaceId,
        f.namespace.owner.principalId,
        f.namespace.owner.actorId,
        f.namespace.owner.profileId,
        f.namespace.owner.pluginId,
        f.namespace.owner.publisherId,
        projectId,
        f.namespace.workspaceId,
        assetAt,
        JSON.stringify(f.namespace),
      ];
      await f.execute(
        `INSERT INTO ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE}(${namespaceColumns}) VALUES(${values.map(sql).join(",")})`,
      );
      await f.invoke("listAssets", {
        projectId,
        afterAssetId: null,
        limit: 16,
      });
      const changedWorkspace = {
        ...f.namespace,
        workspaceId: "changed-workspace",
      };
      await corrupt(
        `UPDATE ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} SET workspace_id='changed-workspace',record_json=${sql(JSON.stringify(changedWorkspace))} WHERE project_id=${sql(projectId)}`,
        "update",
      );
      await assert.rejects(
        f.invoke("listAssets", { projectId, afterAssetId: null, limit: 16 }),
      );
      await corrupt(
        `UPDATE ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} SET workspace_id=${sql(f.namespace.workspaceId)},record_json=${sql(JSON.stringify(f.namespace))} WHERE project_id=${sql(projectId)}`,
        "update",
      );
      await f.invoke("listAssets", {
        projectId,
        afterAssetId: null,
        limit: 16,
      });
      const changed = {
        ...f.namespace,
        owner: { ...f.namespace.owner, publisherId: "foreign.publisher" },
      };
      await corrupt(
        `UPDATE ${f.prefix}${PLUGIN_PROJECT_WORKSPACE_TABLE} SET publisher_id='foreign.publisher',record_json=${sql(JSON.stringify(changed))} WHERE project_id=${sql(projectId)}`,
        "update",
      );
      await assert.rejects(
        f.invoke("listAssets", { projectId, afterAssetId: null, limit: 16 }),
      );
    },
  );
  test(
    `${backend}: genuine Asset V2 UI grant cannot read a foreign plugin profile`,
    assetTestOptions(backend),
    async (t) => {
      const f = await fixture(t, backend, true);
      await assert.rejects(
        f.invoke("listAssets", {
          projectId: f.project.project.projectId,
          afterAssetId: null,
          limit: 16,
        }),
      );
    },
  );
}
