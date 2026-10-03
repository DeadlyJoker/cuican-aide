import {
  parsePluginPackageDescriptor,
  parsePluginUiLease,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  parseProjectGenerationPublication,
  type PluginSelection,
  type RunState,
} from "@crewon/domain";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginUiCommittedTaskAuthority } from "./plugin-ui-committed-task-authority.ts";
import { committedTaskContext } from "./plugin-ui-committed-task-support.ts";
import { capturePluginUiInvocationCommitAuthority } from "./plugin-ui-invocation-authority.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedTaskOutcome,
} from "./plugin-ui-ports.ts";
import type { CommitExtensionTurnResult } from "./extension-store-port.ts";
import { projectGenerationUiTaskCommand } from "./project-generation-task-receipt.ts";
import { projectTaskFixture } from "./project-generation-task.test-support.ts";
import { committedUiFixture } from "./plugin-ui-committed-task.test-support.ts";
import {
  taskActor,
  taskCommand,
  taskDigester,
  taskPin,
} from "./extension-plugin-task.test-support.ts";
import { uiTestAt, uiTestBytes } from "./plugin-ui.test-support.ts";

/** Actual Application services over memory doubles; no SQL, execution owner or supplier is claimed. */
export function committedProjectGenerationFixture() {
  const project = projectTaskFixture();
  const originalUi = committedUiFixture();
  const original = originalUi.detachedContext();
  const identity = {
    pluginId: "example.business-story",
    publisherId: "example.business-publisher",
    version: "4.0.0",
    packageDigest: taskDigester.sha256("independent-business-package"),
  };
  const descriptor = parsePluginPackageDescriptor({
    ...original.lease.descriptor,
    pluginId: identity.pluginId,
    publisherId: identity.publisherId,
    version: identity.version,
    entrypoints: { node: null, ui: { path: "ui.mjs", mode: "trustedModule" } },
    files: original.lease.descriptor.files.filter(
      (file) => file.path === "ui.mjs",
    ),
    requires: [
      {
        service: "crewon.project-generations",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const pkg = parseInstalledPluginPackage({ ...original.package, ...identity });
  const selection = parsePluginSelection({
    ...original.selection,
    pluginId: identity.pluginId,
    publisherId: identity.publisherId,
    selectedPackageDigest: identity.packageDigest,
    revision: 5,
  });
  const publication = parseProjectGenerationPublication({
    source: {
      pluginId: identity.pluginId,
      packageDigest: identity.packageDigest,
      contributionId: "workbench",
    },
    target: {
      pluginId: taskPin.pluginId,
      packageDigest: taskPin.packageDigest,
      contributionId: taskPin.contributionId,
      action: taskPin.action,
    },
  });
  const request = {
    reference: project.reference,
    threadId: taskCommand.threadId,
    expectedThreadRevision: taskCommand.expectedThreadRevision,
    idempotencyKey: "raw-business-intent-1",
  };
  const state = {
    selection: selection as PluginSelection | null,
    allow: true,
    epoch: "business-policy-4",
    now: uiTestAt,
    context: null as PluginUiActionContext | null,
    afterCommit: null as
      | ((
          context: PluginUiActionContext,
          result: CommitExtensionTurnResult,
        ) => void | Promise<void>)
      | null,
    currentRun: undefined as RunState | null | undefined,
    runReads: 0,
    actionCalls: 0,
    mode: "generate" as "generate" | "raw",
    raw: null as PluginUiCommittedTaskOutcome | PluginUiJsonValue | null,
  };
  const detachedContext = (): PluginUiActionContext => ({
    ...original,
    package: pkg,
    selection,
    authorityEpoch: state.epoch,
    action: "crewon.project-generations.v1.generateConcept",
    input: structuredClone(request),
    lease: parsePluginUiLease({
      ...original.lease,
      descriptor,
      selectionRevision: selection.revision,
      packageDigest: pkg.packageDigest,
    }),
  });
  const runs = {
    async loadRunInSpace(input: { runId: string }) {
      state.runReads++;
      return state.currentRun === undefined
        ? structuredClone(
            [...project.base.state.receipts.values()].find(
              (saved) => saved.result.binding.runId === input.runId,
            )?.result.run.state ?? null,
          )
        : structuredClone(state.currentRun);
    },
  };
  const dependencies = {
    extensions: project.extensions,
    runs,
    digester: taskDigester,
    projectGenerations: {
      publications: [publication],
      projects: project.store,
    },
  };
  const createAuthority = (
    patch: Partial<
      ConstructorParameters<typeof PluginUiCommittedTaskAuthority>[0]
    > = {},
  ) => new PluginUiCommittedTaskAuthority({ ...dependencies, ...patch });
  const authority = createAuthority();
  const commandFor = (context: PluginUiActionContext = detachedContext()) =>
    projectGenerationUiTaskCommand(
      {
        sourcePin: committedTaskContext(context).pin,
        executionPin: taskPin,
        request: context.input as typeof request,
        prompt: project.original.assetRevision.prompt,
      },
      taskDigester,
    );
  const accept = async (context = detachedContext()) => {
    const command = commandFor(context);
    const result = await project
      .create()
      .createProjectTaskFromPlugin(
        context.actor,
        command,
        taskPin,
        request.reference,
        project.authority,
      );
    return { context, command, result, executionPin: taskPin };
  };
  const ledger = {
    ...originalUi.ledger,
    async loadSelection() {
      return state.selection;
    },
    async loadPackage() {
      return pkg;
    },
    async listSelections() {
      return {
        selections: state.selection ? [state.selection] : [],
        next: null,
      };
    },
  };
  const service = new PluginUiApplicationService({
    store: ledger,
    profiles: {
      async resolve() {
        return original.scope;
      },
    },
    authorization: {
      async authorize() {
        return state.allow
          ? { outcome: "allow", authorityEpoch: state.epoch }
          : { outcome: "deny", reasonCode: "withdrawn" };
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
    ids: { nextId: () => "p".repeat(40) },
    committedTasks: authority,
    actions: {
      async invoke(context) {
        state.context = context;
        state.actionCalls++;
        if (state.mode === "raw") return state.raw!;
        const current = capturePluginUiInvocationCommitAuthority(context);
        const command = commandFor(context);
        const result = await project
          .create()
          .createProjectTaskFromPlugin(
            context.actor,
            command,
            taskPin,
            request.reference,
            {
              async assertCurrent() {
                await current.assertCurrent();
                await project.authority.assertCurrent();
              },
              assertActive() {
                current.assertActive();
                project.authority.assertActive();
              },
            },
          );
        await state.afterCommit?.(context, result);
        return authority.issueProjectGeneration({
          context,
          command,
          executionPin: taskPin,
          result,
        });
      },
    },
  });
  const openCommand = {
    pluginId: identity.pluginId,
    contributionId: publication.source.contributionId,
    expectedSelectionRevision: selection.revision,
    expectedPackageDigest: identity.packageDigest,
  };
  return {
    project,
    originalUi,
    publication,
    request,
    state,
    runs,
    ledger,
    dependencies,
    authority,
    createAuthority,
    detachedContext,
    commandFor,
    accept,
    service,
    openCommand,
  };
}

export function projectTaskDto(result: CommitExtensionTurnResult) {
  return {
    disposition: result.turn.disposition,
    threadId: result.binding.threadId,
    threadRevision: result.turn.threadState.revision,
    runId: result.binding.runId,
    messageId: result.turn.messages[0]!.messageId,
    configurationRevision: result.binding.configurationRevision,
  };
}
