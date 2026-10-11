import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import {
  PluginUiApplicationService,
  ProjectConversationApplicationService,
  capturePluginUiInvocationCommitAuthority,
  type PluginUiActionContext,
  type PluginProjectReadScope,
  type ProjectConversationCommitAuthority,
  type PluginProjectWorkspacePreparation,
} from "@crewon/application";
import {
  parsePluginTaskAdmissionPin,
  pluginProjectWorkspaceIdentityInput,
} from "@crewon/domain";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  uiTestDescriptor,
  uiTestBytes,
} from "../../application/src/plugin-ui.test-support.ts";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import { committedTaskContext } from "../../application/src/plugin-ui-committed-task-support.ts";
import { ownedConversationSqlFixture } from "./project-conversation-owned.test-support.ts";

/** Genuine UI lifecycle and original SQL stores. Package discovery, Host callbacks and protected metadata are named fixtures. */
export async function ownedConversationUiFixture(
  t: TestContext,
  mismatch:
    | "matching"
    | "actorId"
    | "profileId"
    | "pluginId"
    | "publisherId" = "matching",
  reader: "available" | "missing" = "available",
  workspaceKind: "fixture" | "nativeIdentity" = "fixture",
  options: Readonly<{
    backend?: "sqlite" | "postgres";
    namespace?: "deferred";
  }> = {},
) {
  const backend = options.backend ?? "sqlite";
  const f = await ownedConversationSqlFixture(t, backend, mismatch);
  const workspaceId =
    workspaceKind === "fixture"
      ? "workspace-isolated"
      : `workspace-project-${createHash("sha256").update(pluginProjectWorkspaceIdentityInput(f.namespaceOwner())).digest("hex")}`;
  if (mismatch === "matching") {
    await f.parent.migratePluginProjectWorkspaceNamespaces();
    if (options.namespace !== "deferred")
      await (
        await f.mounted()
      ).write(f.namespaceRecipe(f.reference.projectId, workspaceId));
  }
  const state = {
    policyAllowed: true,
    uiAllowed: true,
    hostActive: true,
    pinDrift: false,
    idCount: 0,
    threadPreparations: 0,
    preparedThreadId: null as string | null,
    afterThreadPrepared: null as (() => void | Promise<void>) | null,
    afterThreadRead: null as (() => void | Promise<void>) | null,
    taskCount: 0,
    context: null as PluginUiActionContext | null,
    beforeDispatch: null as (() => Promise<void> | void) | null,
    beforeBindingCommit: null as (() => Promise<void> | void) | null,
    afterHostTransactionCurrent: null as (() => Promise<void> | void) | null,
    prepareWorkspace: false,
    preparations: [] as PluginProjectWorkspacePreparation[],
    onWorkspacePrepared: null as
      | ((source: PluginProjectWorkspacePreparation) => Promise<void> | void)
      | null,
  };
  const scopes: PluginProjectReadScope[] = [];
  const projects = f.parent.creativeProjectStore();
  assert.ok(
    backend === "sqlite"
      ? projects instanceof SqliteCreativeProjectStore
      : projects instanceof PostgresCreativeProjectStore,
  );
  const app = new ProjectConversationApplicationService({
    conversations: {
      version: f.store.version,
      migrate: f.store.migrate.bind(f.store),
      hasThreadBinding: f.store.hasThreadBinding.bind(f.store),
      loadBinding: f.store.loadBinding.bind(f.store),
      listBindings: f.store.listBindings.bind(f.store),
      loadMutationReceipt: f.store.loadMutationReceipt.bind(f.store),
      readRequiredStageDigest: f.store.readRequiredStageDigest.bind(f.store),
      loadStageAdmission: f.store.loadStageAdmission.bind(f.store),
      async commitBinding(...args: Parameters<typeof f.store.commitBinding>) {
        await state.beforeBindingCommit?.();
        return f.store.commitBinding(args[0], args[1]);
      },
    },
    threads: {
      async prepareCreateThread(actor, command) {
        state.threadPreparations++;
        const prepared = await f.threads.prepareCreateThread(actor, command);
        const event = prepared.events[0];
        assert.equal(event?.type, "thread.created");
        state.preparedThreadId = event!.identity.threadId;
        await state.afterThreadPrepared?.();
        return prepared;
      },
    },
    threadStore: {
      async loadThreadInSpace(input) {
        const thread = await f.parent.loadThreadInSpace(input);
        await state.afterThreadRead?.();
        return thread;
      },
    },
    projects: {
      loadProject: projects.loadProject.bind(projects),
      loadBrief: projects.loadBrief.bind(projects),
      ...(reader === "missing"
        ? {}
        : {
            bindProjectReads(scope: PluginProjectReadScope) {
              scopes.push(scope);
              return projects.bindProjectReads(scope);
            },
          }),
    },
    texts: f.parent.projectTextStore(),
    tasks: {
      async createProjectConversationTurnFromHost() {
        state.taskCount++;
        throw new Error("named_no_run_in_metadata_test");
      },
    },
    authorization: {
      async authorize() {
        return state.policyAllowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "named_project_policy_denied" };
      },
    },
    ids: {
      nextId() {
        state.idCount++;
        return randomUUID();
      },
    },
    clock: { now: () => f.namespaceRecipe().createdAt },
    digester: f.digester,
  });
  const scope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.installation.profileId,
  };
  const selection = (await f.installs.loadSelection({
    scope,
    pluginId: f.installation.pluginId,
  }))!;
  const pkg = (await f.installs.loadPackage({
    scope,
    packageDigest: selection.selectedPackageDigest!,
  }))!;
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    version: pkg.version,
    requires: [
      {
        service: "crewon.project-conversations",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const ui = new PluginUiApplicationService({
    store: f.installs,
    profiles: {
      async resolve() {
        return scope;
      },
    },
    authorization: {
      async authorize() {
        return state.uiAllowed
          ? { outcome: "allow", authorityEpoch: "owned-conversation-ui-epoch" }
          : { outcome: "deny", reasonCode: "named_ui_denied" };
      },
    },
    packages: {
      async verify() {
        return { descriptor, publicAssets: ["ui.mjs"] };
      },
      async readAsset() {
        return {
          bytes: uiTestBytes,
          contentType: "text/javascript; charset=utf-8",
        };
      },
    },
    ids: { nextId: () => randomUUID().replaceAll("-", "").repeat(2) },
    clock: { now: () => f.namespaceRecipe().createdAt },
    actions: {
      async invoke(context) {
        state.context = context;
        const live = capturePluginUiInvocationCommitAuthority(context);
        const snapshot = committedTaskContext(context);
        // Named Host fixture retains the independent original project.execute pin; the UI pin is not rewritten or published.
        const authority: ProjectConversationCommitAuthority = Object.freeze({
          ...f.authority,
          pin: parsePluginTaskAdmissionPin({
            ...snapshot.pin,
            action: "project.execute",
            authorityEpoch: state.pinDrift
              ? "foreign-host-epoch"
              : snapshot.pin.authorityEpoch,
          }),
          selection: snapshot.context.selection,
          package: snapshot.context.package,
          assertActive() {
            live.assertActive();
            f.authority.assertActive();
            if (!state.hostActive) throw new Error("named_host_closed");
          },
          async assertCurrent() {
            authority.assertActive();
            await f.authority.assertCurrent();
            await live.assertCurrent();
          },
          async assertTransactionCurrent() {
            authority.assertActive();
            await f.authority.assertTransactionCurrent();
            await state.afterHostTransactionCurrent?.();
          },
        });
        await state.beforeDispatch?.();
        if (state.prepareWorkspace) {
          const preparation = await app.prepareWorkspaceFromPluginUi(
            context,
            authority,
          );
          state.preparations.push(preparation);
          await state.onWorkspacePrepared?.(preparation);
        }
        return parsePluginUiJsonValue(
          await app.metadataFromPluginUi(context, authority),
        );
      },
    },
  });
  const lease = await ui.openMount(f.actor, {
    pluginId: pkg.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: selection.revision,
    expectedPackageDigest: pkg.packageDigest,
  });
  const createInput = {
    projectId: f.reference.projectId,
    workspaceId,
    title: "项目讨论",
    idempotencyKey: "owned-conversation-create",
  };
  const invoke = (action: string, input: unknown) =>
    ui.invoke(f.actor, {
      mountRef: lease.mountRef,
      action,
      input: input as never,
    });
  return { ...f, app, state, scopes, createInput, invoke };
}
