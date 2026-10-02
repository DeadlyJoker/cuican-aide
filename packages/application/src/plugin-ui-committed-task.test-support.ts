import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  type PluginSelection,
  type RunState,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginUiCommittedTaskAuthority } from "./plugin-ui-committed-task-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { assertPluginUiInvocationCurrent } from "./plugin-ui-invocation-authority.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedTaskOutcome,
} from "./plugin-ui-ports.ts";
import type { PluginInstallationStore } from "./plugin-installation-store-port.ts";
import type { CommitExtensionTurnResult } from "./extension-store-port.ts";
import {
  pluginTaskFixture,
  taskActor,
  taskCommand,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";
import {
  uiTestAt,
  uiTestBytes,
  uiTestDescriptor,
} from "./plugin-ui.test-support.ts";

/** Real Application services over explicit memory doubles; SQL/Worker/production authority is not claimed. */
export function committedUiFixture() {
  const tasks = pluginTaskFixture();
  const scope = {
    tenantId: taskActor.tenantId,
    spaceId: taskActor.spaceId,
    profileId: taskPin.profileId,
  };
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: taskPin.pluginId,
    publisherId: taskPin.publisherId,
    version: taskPin.version,
  });
  const pkg = parseInstalledPluginPackage({
    schemaVersion: "crewon.installed-plugin-package.v1",
    ...scope,
    pluginId: taskPin.pluginId,
    version: taskPin.version,
    publisherId: taskPin.publisherId,
    packageDigest: taskPin.packageDigest,
    installedAt: uiTestAt,
    installedByPrincipalId: taskActor.principalId,
    installedByActorId: taskActor.actorId,
  });
  const selection = parsePluginSelection({
    schemaVersion: "crewon.plugin-selection.v1",
    ...scope,
    pluginId: taskPin.pluginId,
    publisherId: taskPin.publisherId,
    revision: taskPin.selectionRevision,
    state: "enabled",
    selectedPackageDigest: taskPin.packageDigest,
    updatedAt: uiTestAt,
    updatedByPrincipalId: taskActor.principalId,
    updatedByActorId: taskActor.actorId,
  });
  const state = {
    scope,
    selection: selection as PluginSelection | null,
    pkg,
    epoch: taskPin.authorityEpoch,
    now: uiTestAt,
    allow: true,
    mode: "task" as "task" | "json" | "raw",
    json: { echo: "read-result" } as PluginUiJsonValue,
    raw: null as PluginUiCommittedTaskOutcome | PluginUiJsonValue | null,
    context: null as PluginUiActionContext | null,
    afterAction: null as (() => void | Promise<void>) | null,
    afterCommit: null as
      | ((
          context: PluginUiActionContext,
          result: CommitExtensionTurnResult,
        ) => void | Promise<void>)
      | null,
    currentRun: undefined as RunState | null | undefined,
    runReads: 0,
  };
  const runs = {
    async loadRunInSpace(input: { runId: string }) {
      state.runReads++;
      return state.currentRun === undefined
        ? structuredClone(
            [...tasks.state.receipts.values()].find(
              (saved) => saved.result.binding.runId === input.runId,
            )?.result.run.state ?? null,
          )
        : state.currentRun;
    },
  };
  const authority = new PluginUiCommittedTaskAuthority({
    extensions: tasks.extensions,
    runs,
    digester: taskDigester,
  });
  const unsupported = async (): Promise<never> => {
    throw new Error("unused");
  };
  const ledger: PluginInstallationStore = {
    async loadSelection() {
      return state.selection;
    },
    async loadPackage() {
      return state.pkg;
    },
    async listSelections() {
      return {
        selections: state.selection ? [state.selection] : [],
        next: null,
      };
    },
    listPackages: unsupported,
    loadReceipt: unsupported,
    recordInstalledPackage: unsupported,
    commitSelection: unsupported,
  };
  const service = new PluginUiApplicationService({
    store: ledger,
    profiles: {
      async resolve() {
        return state.scope;
      },
    },
    authorization: {
      async authorize() {
        return state.allow
          ? { outcome: "allow", authorityEpoch: state.epoch }
          : { outcome: "deny", reasonCode: "denied" };
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
    clock: { now: () => state.now },
    ids: { nextId: () => "c".repeat(40) },
    committedTasks: authority,
    actions: {
      async invoke(context) {
        state.context = context;
        if (state.mode === "raw") return state.raw!;
        if (state.mode === "json") {
          await state.afterAction?.();
          return state.json;
        }
        if (context.action !== taskPin.action)
          throw new ApplicationError(
            "authorization",
            "plugin_ui_action_unavailable",
          );
        const pin = committedTaskContext(context).pin;
        const result = await tasks
          .create()
          .createTaskFromPlugin(context.actor, taskCommand, pin, {
            async assertCurrent() {
              await assertPluginUiInvocationCurrent(context);
              if (
                !state.allow ||
                state.epoch !== context.authorityEpoch ||
                state.selection?.state !== "enabled" ||
                state.selection.revision !== context.selection.revision ||
                state.selection.selectedPackageDigest !==
                  context.package.packageDigest
              )
                throw new ApplicationError(
                  "authorization",
                  "fixture_commit_fenced",
                );
            },
          });
        await state.afterCommit?.(context, result);
        return authority.issue({ context, command: taskCommand, result });
      },
    },
  });
  const openCommand = {
    pluginId: taskPin.pluginId,
    contributionId: taskPin.contributionId,
    expectedSelectionRevision: taskPin.selectionRevision,
    expectedPackageDigest: taskPin.packageDigest,
  };
  const detachedContext = (): PluginUiActionContext => ({
    actor: taskActor,
    scope,
    selection,
    package: pkg,
    authorityEpoch: taskPin.authorityEpoch,
    action: taskPin.action,
    input: { intent: taskCommand.intent },
    lease: parsePluginUiLease({
      schemaVersion: "crewon.plugin-ui-lease.v1",
      mountRef: "d".repeat(40),
      expiresAt: "2026-10-02T04:00:00.000Z",
      selectionRevision: taskPin.selectionRevision,
      packageDigest: taskPin.packageDigest,
      descriptor,
      contributionId: taskPin.contributionId,
      publicAssets: ["ui.mjs"],
    }),
  });
  const accept = async (context = detachedContext()) => {
    const result = await tasks
      .create()
      .createTaskFromPlugin(
        context.actor,
        taskCommand,
        committedTaskContext(context).pin,
      );
    return { context, result, command: taskCommand };
  };
  return {
    service,
    authority,
    tasks,
    state,
    runs,
    ledger,
    openCommand,
    detachedContext,
    accept,
  };
}
