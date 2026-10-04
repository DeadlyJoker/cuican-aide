import {
  parsePluginUiJsonValue,
  parseProjectGenerationQueryUiActionRequest,
  parseProjectGenerationQueryUiActionResponse,
} from "@crewon/contracts/plugins";
import {
  assertProjectQueryExecutionPublication,
  assertProjectQueryReplay,
  captureProjectQueryPublications,
  createProjectQueryLink,
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parsePluginQueryTaskAdmission,
  parsePluginTaskAdmissionPin,
  parseProjectGenerationLink,
  parseProjectQueryLink,
  type PluginTaskAdmissionPin,
  type ProjectQueryPublication,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectStore } from "./creative-project-store-port.ts";
import type { ExternalOperationStore } from "./external-operation-store-port.ts";
import type {
  ExtensionStore,
  CommitExtensionTurnResult,
} from "./extension-store-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import type { RunStore } from "./run-store-port.ts";
import { uiRecord } from "./plugin-ui-application-support.ts";
import {
  checkedCreativeAsset,
  checkedCreativeAssetRevision,
  checkedCreativeBrief,
  checkedCreativeProject,
} from "./creative-project-application-support.ts";
import {
  assertCommittedRun,
  committedQueryTaskCommand,
  committedTaskContext,
  committedTaskProjection,
  committedTaskResult,
} from "./plugin-ui-committed-task-support.ts";
import { loadPluginQuerySourceProof } from "./plugin-query-source.ts";
import {
  assertSavedPluginQueryTask,
  capturePluginQueryReceiptLookup,
  resolvePluginQueryTaskReceipt,
} from "./plugin-query-task-support.ts";
import { projectGenerationQueryUiTaskCommand } from "./project-query-task-receipt.ts";
import { projectQueryReplayPublication } from "./project-query-application-support.ts";

export type CommittedProjectQueryConfiguration = Readonly<{
  publications: readonly ProjectQueryPublication[];
  projects: Pick<
    CreativeProjectStore,
    "loadProject" | "loadConceptAsset" | "loadConceptRevision" | "loadBrief"
  >;
  operations: Pick<ExternalOperationStore, "loadExternalOperation">;
}>;

/** Capture immutable receipt proof ports. No callback here grants current execution permission. */
export function prepareCommittedProjectQueries(
  input: CommittedProjectQueryConfiguration | undefined,
  dependencies: Readonly<{
    extensions: ExtensionStore;
    runs: Pick<RunStore, "loadRunInSpace">;
    digester: ContentDigester;
  }>,
) {
  if (input === undefined) return undefined;
  const value = uiRecord(input, ["publications", "projects", "operations"]);
  const publications = captureProjectQueryPublications(value.publications);
  const store = dependencies.extensions;
  if (
    store.projectQueryVersion !== "crewon.project-query-link.v1" ||
    store.projectQueryPublicationVersion !==
      "crewon.project-query-publication.v1" ||
    store.projectGenerationReadVersion !==
      "crewon.project-generation-read.v1" ||
    store.pluginQueryAdmissionVersion !==
      "crewon.plugin-query-task-admission.v1"
  )
    throw new Error("plugin_ui_project_query_store_unavailable");
  const projects =
    value.projects as CommittedProjectQueryConfiguration["projects"];
  const loadProject = method(projects, "loadProject"),
    loadAsset = method(projects, "loadConceptAsset"),
    loadRevision = method(projects, "loadConceptRevision"),
    loadBrief = method(projects, "loadBrief");
  const extensions = Object.freeze({
    loadPluginTaskAdmission: method(store, "loadPluginTaskAdmission"),
    loadExtensionRunBinding: method(store, "loadExtensionRunBinding"),
    loadExtensionTurnReceipt: method(store, "loadExtensionTurnReceipt"),
  });
  const admissions = Object.freeze({
    loadPluginQueryTaskAdmission: method(store, "loadPluginQueryTaskAdmission"),
    ...capturePluginQueryReceiptLookup(store),
  });
  const loadQuery = method(store, "loadProjectQueryLink"),
    loadGeneration = method(store, "loadProjectGenerationLinkBySource"),
    loadConfiguration = method(store, "loadExtensionConfiguration");
  const operations = Object.freeze({
    loadExternalOperation: method(
      value.operations as CommittedProjectQueryConfiguration["operations"],
      "loadExternalOperation",
    ),
  });
  const runs = Object.freeze({
    loadRunInSpace: method(dependencies.runs, "loadRunInSpace"),
  });
  const digester = Object.freeze({
    sha256: method(dependencies.digester, "sha256"),
  });
  return Object.freeze({
    publications,
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
      const {
        context,
        pin: sourcePin,
        fingerprint,
      } = committedTaskContext(invocation);
      const request = parseProjectGenerationQueryUiActionRequest({
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
        throw new Error("plugin_ui_project_query_publication_missing");
      assertProjectQueryExecutionPublication({
        publication,
        sourcePin,
        executionPin,
      });
      const command = committedQueryTaskCommand(
        value.command as CreateExtensionTaskCommand,
        executionPin,
      );
      const claim = parsePluginUiJsonValue(
        value.result,
      ) as unknown as CommitExtensionTurnResult;
      const queryRaw = await admissions.loadPluginQueryTaskAdmission!({
        tenantId: executionPin.tenantId,
        spaceId: executionPin.spaceId,
        runId: claim.binding.runId,
      });
      if (queryRaw === null) throw new Error("plugin_query_admission_missing");
      const query = parsePluginQueryTaskAdmission(queryRaw);
      const owner = Object.freeze({
        tenantId: context.actor.tenantId,
        spaceId: context.actor.spaceId,
        principalId: context.actor.principalId,
      });
      const generationRaw = await loadGeneration!({
        owner,
        ...request.input.reference,
      });
      if (generationRaw === null)
        throw new Error("plugin_ui_project_query_generation_missing");
      const generation = parseProjectGenerationLink(generationRaw, digester);
      const expectedCommand = projectGenerationQueryUiTaskCommand(
        {
          sourcePin,
          executionPin,
          request: request.input,
          sourceRunId: generation.binding.runId,
        },
        digester,
      );
      if (
        extensionCanonicalJson(command) !==
        extensionCanonicalJson(expectedCommand)
      )
        throw new Error("plugin_ui_project_query_command_mismatch");
      const source = await loadPluginQuerySourceProof({
        actor: context.actor,
        pluginId: executionPin.pluginId,
        profileId: executionPin.profileId,
        publisherId: executionPin.publisherId,
        sourceRunId: generation.binding.runId,
        operationId: request.input.operationId,
        extensions,
        runs,
        operations,
        digester,
      });
      if (
        extensionCanonicalJson(source.binding) !==
          extensionCanonicalJson(generation.binding) ||
        extensionCanonicalJson(source.admission) !==
          extensionCanonicalJson(query.source) ||
        source.admission.principalId !== generation.ownerPrincipalId
      )
        throw new Error("plugin_ui_project_query_source_mismatch");
      const configurationRaw = await loadConfiguration({
        ...generation.binding,
        revision: generation.binding.configurationRevision,
      });
      if (configurationRaw === null)
        throw new Error("plugin_query_source_configuration_missing");
      const configuration = parseExtensionConfiguration(
        configurationRaw,
        digester,
      );
      if (
        configuration.tenantId !== generation.tenantId ||
        configuration.spaceId !== generation.spaceId ||
        configuration.pluginId !== generation.binding.pluginId ||
        configuration.revision !== generation.binding.configurationRevision ||
        configuration.contentDigest !==
          generation.binding.configurationDigest ||
        configuration.pluginVersion !== source.admission.version
      )
        throw new Error("plugin_query_source_configuration_mismatch");
      const resolvedReceipt = await resolvePluginQueryTaskReceipt({
        store: admissions,
        actor: context.actor,
        command,
        pin: executionPin,
        source,
        digester,
        project: {
          reference: request.input.reference,
          generationLinkDigest: generation.contentDigest,
        },
      });
      const receipt = resolvedReceipt.receipt;
      const claimed = committedTaskResult(
        claim,
        command,
        executionPin,
        receipt,
        digester,
        query,
      );
      const savedRaw = await extensions.loadExtensionTurnReceipt({
        ...executionPin,
        receipt,
      });
      if (savedRaw === null)
        throw new Error("plugin_ui_committed_receipt_missing");
      const saved = committedTaskResult(
        savedRaw,
        command,
        executionPin,
        receipt,
        digester,
        query,
      );
      if (saved.fingerprint !== claimed.fingerprint)
        throw new Error("plugin_ui_committed_receipt_mismatch");
      await assertSavedPluginQueryTask({
        store: admissions,
        pin: resolvedReceipt.receiptPin,
        source,
        binding: saved.binding,
        receipt,
        digester,
      });
      const linkRaw = await loadQuery!({
        tenantId: executionPin.tenantId,
        spaceId: executionPin.spaceId,
        runId: saved.binding.runId,
      });
      if (linkRaw === null)
        throw new Error("plugin_ui_project_query_link_missing");
      const link = parseProjectQueryLink(linkRaw, digester);
      const historicalPublication = projectQueryReplayPublication({
        link,
        current: { publication, sourcePin, executionPin },
        historicalAdmission: resolvedReceipt.historicalAdmission,
        digester,
      });
      assertProjectQueryReplay(
        {
          link,
          reference: request.input.reference,
          generationLinkDigest: generation.contentDigest,
          actor: context.actor,
          binding: saved.binding,
          receipt,
          ...historicalPublication,
        },
        digester,
      );
      const derived = createProjectQueryLink(
        {
          actor: context.actor,
          reference: request.input.reference,
          generationLink: generation,
          queryAdmission: query,
          binding: saved.binding,
          receipt,
          ...historicalPublication,
          at: link.createdAt,
        },
        digester,
      );
      if (extensionCanonicalJson(derived) !== extensionCanonicalJson(link))
        throw new Error("plugin_ui_project_query_link_mismatch");
      const rawProject = await loadProject({
        owner,
        projectId: generation.projectId,
      });
      if (rawProject === null)
        throw new Error("plugin_ui_project_query_source_missing");
      const project = checkedCreativeProject(
        rawProject,
        owner,
        generation.projectId,
      );
      const rawAsset = await loadAsset({
        owner,
        projectId: generation.projectId,
        assetId: generation.reference.assetId,
      });
      if (rawAsset === null)
        throw new Error("plugin_ui_project_query_source_missing");
      const asset = checkedCreativeAsset(
        rawAsset,
        project,
        generation.reference.assetId,
      );
      const rawRevision = await loadRevision({
        owner,
        projectId: generation.projectId,
        assetId: generation.reference.assetId,
        assetRevision: generation.reference.assetRevision,
      });
      if (rawRevision === null)
        throw new Error("plugin_ui_project_query_source_missing");
      const revision = checkedCreativeAssetRevision(
        rawRevision,
        project,
        digester,
        asset.assetId,
        {
          assetRevision: generation.reference.assetRevision,
          latestAssetRevision: asset.latestAssetRevision,
        },
      );
      const rawBrief = await loadBrief({
        owner,
        projectId: generation.projectId,
        briefRevision: generation.briefRevision,
      });
      if (rawBrief === null)
        throw new Error("plugin_ui_project_query_source_missing");
      const brief = checkedCreativeBrief(
        rawBrief,
        project,
        digester,
        generation.briefRevision,
      );
      if (
        generation.ownerPrincipalId !== context.actor.principalId ||
        generation.tenantId !== owner.tenantId ||
        generation.spaceId !== owner.spaceId ||
        generation.projectId !== request.input.reference.projectId ||
        generation.reference.assetId !== request.input.reference.assetId ||
        generation.reference.assetRevision !==
          request.input.reference.assetRevision ||
        revision.contentDigest !== generation.assetContentDigest ||
        revision.briefRevision !== generation.briefRevision ||
        revision.briefContentDigest !== generation.briefContentDigest ||
        brief.contentDigest !== generation.briefContentDigest ||
        generation.binding.inputDigest !==
          digester.sha256(extensionCanonicalJson({ prompt: revision.prompt }))
      )
        throw new Error("plugin_ui_project_query_source_mismatch");
      const run = await runs.loadRunInSpace({
        tenantId: executionPin.tenantId,
        spaceId: executionPin.spaceId,
        runId: saved.binding.runId,
      });
      if (run === null) throw new Error("plugin_ui_committed_run_missing");
      assertCommittedRun(run, saved.binding);
      if (committedTaskContext(invocation).fingerprint !== fingerprint)
        throw new Error("plugin_ui_committed_context_changed");
      return Object.freeze({
        fingerprint,
        output: parseProjectGenerationQueryUiActionResponse(
          request,
          committedTaskProjection(claimed.result),
        ),
      });
    },
  });
}

function method<T extends object, K extends keyof T>(
  receiver: T,
  key: K,
): NonNullable<T[K]> {
  if (receiver === null || typeof receiver !== "object")
    throw new Error("plugin_ui_project_query_port_invalid");
  for (
    let target: object | null = receiver;
    target !== null;
    target = Object.getPrototypeOf(target)
  ) {
    const field = Object.getOwnPropertyDescriptor(target, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      throw new Error("plugin_ui_project_query_port_invalid");
    return field.value.bind(receiver) as NonNullable<T[K]>;
  }
  throw new Error("plugin_ui_project_query_port_invalid");
}
