import {
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationUiActionResponse,
} from "@crewon/contracts/plugins";
import {
  assertProjectGenerationExecutionPublication,
  assertProjectGenerationReplay,
  captureProjectGenerationPublications,
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
  parseProjectGenerationLink,
  type ProjectGenerationPublication,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type {
  ExtensionStore,
  CommitExtensionTurnResult,
} from "./extension-store-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { RunStore } from "./run-store-port.ts";
import {
  assertSavedPluginTask,
  pluginTaskReceipt,
} from "./extension-plugin-task-support.ts";
import {
  checkedCreativeProject,
  checkedCreativeAsset,
  checkedCreativeAssetRevision,
  checkedCreativeBrief,
} from "./creative-project-application-support.ts";
import {
  committedTaskContext,
  committedTaskCommand,
  committedTaskResult,
  committedTaskProjection,
  assertCommittedRun,
} from "./plugin-ui-committed-task-support.ts";
import {
  projectGenerationTaskReceipt,
  projectGenerationUiTaskCommand,
} from "./project-generation-task-receipt.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";

export type CommittedProjectGenerationConfiguration = Readonly<{
  publications: readonly ProjectGenerationPublication[];
  projects: Pick<
    CreativeProjectStore,
    "loadProject" | "loadConceptAsset" | "loadConceptRevision" | "loadBrief"
  >;
}>;

/** Capture actual Host-only read adapters before dispatch, without activating anything by default. */
export function prepareCommittedProjectGenerations(
  input: CommittedProjectGenerationConfiguration | undefined,
  dependencies: Readonly<{
    extensions: ExtensionStore;
    runs: Pick<RunStore, "loadRunInSpace">;
    digester: ContentDigester;
  }>,
) {
  if (input === undefined) return undefined;
  const value = uiRecord(input, ["publications", "projects"]);
  const publications = captureProjectGenerationPublications(value.publications);
  const extensions = dependencies.extensions;
  if (
    extensions.projectGenerationVersion !== "crewon.project-generation-link.v0"
  )
    throw new Error("plugin_ui_project_generation_store_unavailable");
  const projects =
    value.projects as CommittedProjectGenerationConfiguration["projects"];
  if (projects === null || typeof projects !== "object")
    throw new Error("plugin_ui_project_generation_source_unavailable");
  const loadProject = captureMethod(projects, "loadProject");
  const loadAsset = captureMethod(projects, "loadConceptAsset");
  const loadRevision = captureMethod(projects, "loadConceptRevision");
  const loadBrief = captureMethod(projects, "loadBrief");
  const loadLink = captureMethod(extensions, "loadProjectGenerationLink")!;
  const loadReceipt = captureMethod(extensions, "loadExtensionTurnReceipt");
  const loadAdmission = captureMethod(extensions, "loadPluginTaskAdmission")!;
  const loadRun = captureMethod(dependencies.runs, "loadRunInSpace");
  const sha256 = captureMethod(dependencies.digester, "sha256");
  const digester = Object.freeze({ sha256 });
  const admissions = Object.freeze({
    loadPluginTaskAdmission: loadAdmission,
  });

  return Object.freeze({
    async verify(
      input: Readonly<{
        context: PluginUiActionContext;
        command: CreateExtensionTaskCommand;
        executionPin: PluginTaskAdmissionPin;
        result: CommitExtensionTurnResult;
      }>,
    ) {
      const value = uiRecord(input, [
        "context",
        "command",
        "executionPin",
        "result",
      ]);
      const invocation = value.context as PluginUiActionContext;
      // Capture every caller-owned fact before any persistent read.
      const {
        context,
        pin: sourcePin,
        fingerprint,
      } = committedTaskContext(invocation);
      const request = parseProjectGenerationUiActionRequest({
        action: context.action,
        input: context.input,
      });
      const executionPin = parsePluginTaskAdmissionPin(value.executionPin);
      const publication = publications.find(
        (item) =>
          item.source.pluginId === sourcePin.pluginId &&
          item.source.packageDigest === sourcePin.packageDigest &&
          item.source.contributionId === sourcePin.contributionId,
      );
      if (publication === undefined)
        throw new Error("plugin_ui_project_generation_publication_missing");
      assertProjectGenerationExecutionPublication({
        publication,
        sourcePin,
        executionPin,
      });
      const command = committedTaskCommand(
        value.command as CreateExtensionTaskCommand,
        executionPin,
      );
      const promptFields = uiRecord(
        command.intent.kind === "generate" ? command.intent.input : null,
        ["prompt"],
      );
      const expectedCommand = projectGenerationUiTaskCommand(
        {
          sourcePin,
          executionPin,
          request: request.input,
          prompt: promptFields.prompt as string,
        },
        digester,
      );
      if (
        extensionCanonicalJson(command) !==
        extensionCanonicalJson(expectedCommand)
      )
        throw new Error("plugin_ui_project_generation_command_mismatch");
      const receipt = projectGenerationTaskReceipt(
        pluginTaskReceipt(context.actor, command, executionPin, digester),
        request.input.reference,
        digester,
      );
      const claimed = committedTaskResult(
        value.result as CommitExtensionTurnResult,
        command,
        executionPin,
        receipt,
        digester,
      );
      const raw = await loadReceipt({
        tenantId: executionPin.tenantId,
        spaceId: executionPin.spaceId,
        pluginId: executionPin.pluginId,
        receipt,
      });
      if (raw === null) throw new Error("plugin_ui_committed_receipt_missing");
      const saved = committedTaskResult(
        raw,
        command,
        executionPin,
        receipt,
        digester,
      );
      if (saved.fingerprint !== claimed.fingerprint)
        throw new Error("plugin_ui_committed_receipt_mismatch");
      await assertSavedPluginTask({
        store: admissions,
        pin: executionPin,
        binding: saved.binding,
        threadId: command.threadId,
        receipt,
        digester,
      });
      const rawLink = await loadLink(saved.binding);
      if (rawLink === null)
        throw new Error("plugin_ui_project_generation_link_missing");
      const link = parseProjectGenerationLink(rawLink, digester);
      assertProjectGenerationReplay(
        {
          link,
          reference: request.input.reference,
          actor: context.actor,
          binding: saved.binding,
          receipt,
        },
        digester,
      );
      const owner = Object.freeze({
        tenantId: context.actor.tenantId,
        spaceId: context.actor.spaceId,
        principalId: context.actor.principalId,
      });
      const rawProject = await loadProject({
        owner,
        projectId: link.projectId,
      });
      if (rawProject === null)
        throw new Error("plugin_ui_project_generation_source_missing");
      const project = checkedCreativeProject(rawProject, owner, link.projectId);
      const rawAsset = await loadAsset({
        owner,
        projectId: link.projectId,
        assetId: link.reference.assetId,
      });
      if (rawAsset === null)
        throw new Error("plugin_ui_project_generation_source_missing");
      const asset = checkedCreativeAsset(
        rawAsset,
        project,
        link.reference.assetId,
      );
      const rawRevision = await loadRevision({
        owner,
        projectId: link.projectId,
        assetId: link.reference.assetId,
        assetRevision: link.reference.assetRevision,
      });
      if (rawRevision === null)
        throw new Error("plugin_ui_project_generation_source_missing");
      const revision = checkedCreativeAssetRevision(
        rawRevision,
        project,
        digester,
        asset.assetId,
        {
          assetRevision: link.reference.assetRevision,
          latestAssetRevision: asset.latestAssetRevision,
        },
      );
      const rawBrief = await loadBrief({
        owner,
        projectId: link.projectId,
        briefRevision: link.briefRevision,
      });
      if (rawBrief === null)
        throw new Error("plugin_ui_project_generation_source_missing");
      const brief = checkedCreativeBrief(
        rawBrief,
        project,
        digester,
        link.briefRevision,
      );
      if (
        revision.contentDigest !== link.assetContentDigest ||
        revision.briefRevision !== link.briefRevision ||
        revision.briefContentDigest !== link.briefContentDigest ||
        brief.contentDigest !== link.briefContentDigest ||
        extensionCanonicalJson(command.intent) !==
          extensionCanonicalJson({
            kind: "generate",
            input: { prompt: revision.prompt },
          })
      )
        throw new Error("plugin_ui_project_generation_source_mismatch");
      const run = await loadRun({
        tenantId: executionPin.tenantId,
        spaceId: executionPin.spaceId,
        runId: saved.binding.runId,
      });
      if (run === null) throw new Error("plugin_ui_committed_run_missing");
      assertCommittedRun(run, saved.binding);
      if (committedTaskContext(invocation).fingerprint !== fingerprint)
        throw new Error("plugin_ui_committed_context_changed");
      const output = parseProjectGenerationUiActionResponse(
        request,
        committedTaskProjection(claimed.result),
      );
      return Object.freeze({ fingerprint, output });
    },
  });
}

function captureMethod<T extends object, K extends keyof T>(
  owner: T,
  key: K,
): T[K] {
  for (
    let target: object | null = owner;
    target !== null;
    target = Object.getPrototypeOf(target)
  ) {
    const field = Object.getOwnPropertyDescriptor(target, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      throw new Error("plugin_ui_project_generation_read_adapter_invalid");
    return field.value.bind(owner) as T[K];
  }
  throw new Error("plugin_ui_project_generation_read_adapter_missing");
}
