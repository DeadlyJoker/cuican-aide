import {
  parseProjectHistoricalQueryUiActionRequest,
  type ProjectHistoricalQueryUiInput,
} from "@crewon/contracts/plugins";
import {
  assertProjectHistoricalQueryExecutionPublication,
  captureProjectHistoricalQueryPublications,
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parsePluginTaskAdmission,
  type ProjectHistoricalQueryPublication,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { uiRecord } from "./plugin-ui-application-support.ts";
import { ApplicationError } from "./application-error.ts";
import type { ExtensionTaskApplicationDependencies } from "./extension-task-application-service.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import { ProjectGenerationReadApplicationService } from "./project-generation-read-application-service.ts";
import { loadPluginQuerySource } from "./plugin-query-source.ts";
import {
  assertPluginHistoricalQueryInvocationAuthority,
  type PluginHistoricalQueryInvocationAuthority,
} from "./plugin-project-historical-query-invocation.ts";
import { projectHistoricalQueryUiTaskCommand } from "./project-historical-query-task-receipt.ts";

/** Resolves only an actual saved generation. Client input never selects an execution package. */
export function prepareProjectHistoricalQueryResolver(
  dependencies: ExtensionTaskApplicationDependencies,
  publicationsInput: readonly ProjectHistoricalQueryPublication[],
) {
  const publications =
      captureProjectHistoricalQueryPublications(publicationsInput),
    d = dependencies;
  if (
    !(
      d.projectGenerationReads instanceof
      ProjectGenerationReadApplicationService
    )
  )
    throw new ApplicationError(
      "conflict",
      "project_historical_query_unavailable",
    );
  const getGeneration = d.projectGenerationReads.getConceptGeneration.bind(
    d.projectGenerationReads,
  );
  const extensions = Object.freeze({
    loadPluginTaskAdmission: d.extensions.loadPluginTaskAdmission?.bind(
      d.extensions,
    ),
    loadExtensionRunBinding: d.extensions.loadExtensionRunBinding.bind(
      d.extensions,
    ),
    loadExtensionTurnReceipt: d.extensions.loadExtensionTurnReceipt.bind(
      d.extensions,
    ),
  });
  const loadConfiguration = d.extensions.loadExtensionConfiguration.bind(
      d.extensions,
    ),
    runs = Object.freeze({
      loadRunInSpace: d.store.loadRunInSpace.bind(d.store),
    }),
    operations = Object.freeze({
      loadExternalOperation: d.operations.loadExternalOperation.bind(
        d.operations,
      ),
    }),
    authorization = Object.freeze({
      authorize: d.authorization.authorize.bind(d.authorization),
    }),
    digester = Object.freeze({ sha256: d.digester.sha256.bind(d.digester) });
  const resolve = async (
    input: Readonly<{
      context: PluginUiActionContext;
      request: ProjectHistoricalQueryUiInput;
      authority: PluginHistoricalQueryInvocationAuthority;
    }>,
  ) => {
    const fields = uiRecord(input, ["context", "request", "authority"]),
      context = fields.context as PluginUiActionContext,
      authority = fields.authority as PluginHistoricalQueryInvocationAuthority;
    assertPluginHistoricalQueryInvocationAuthority(authority);
    if (authority.context !== context)
      throw new ApplicationError(
        "authorization",
        "project_historical_query_invocation_mismatch",
      );
    const request = parseProjectHistoricalQueryUiActionRequest({
      action: context.action,
      input: fields.request,
    }).input;
    if (
      extensionCanonicalJson(request) !==
      extensionCanonicalJson(
        parseProjectHistoricalQueryUiActionRequest({
          action: context.action,
          input: context.input,
        }).input,
      )
    )
      throw new ApplicationError(
        "authorization",
        "project_historical_query_input_mismatch",
      );
    await authority.assertCurrent();
    const original = await getGeneration(context.actor, request.reference);
    authority.assertActive();
    if (original === null)
      throw new ApplicationError(
        "notFound",
        "project_historical_query_generation_not_found",
      );
    const generation = original.link,
      admissionRaw = await extensions.loadPluginTaskAdmission?.({
        tenantId: context.actor.tenantId,
        spaceId: context.actor.spaceId,
        runId: generation.binding.runId,
      });
    if (admissionRaw == null)
      throw new ApplicationError(
        "conflict",
        "project_historical_query_admission_missing",
      );
    const originalAdmission = parsePluginTaskAdmission(admissionRaw),
      source = await loadPluginQuerySource({
        actor: context.actor,
        pluginId: generation.binding.pluginId,
        profileId: context.scope.profileId,
        publisherId: originalAdmission.publisherId,
        sourceRunId: generation.binding.runId,
        operationId: request.operationId,
        extensions,
        runs,
        operations,
        authorization,
        digester,
      });
    authority.assertActive();
    if (
      extensionCanonicalJson(source.binding) !==
        extensionCanonicalJson(generation.binding) ||
      source.admission.principalId !== generation.ownerPrincipalId
    )
      throw new ApplicationError(
        "conflict",
        "project_historical_query_source_mismatch",
      );
    const raw = await loadConfiguration({
      ...generation.binding,
      revision: generation.binding.configurationRevision,
    });
    authority.assertActive();
    if (raw === null)
      throw new ApplicationError(
        "notFound",
        "project_historical_query_configuration_missing",
      );
    const configuration = parseExtensionConfiguration(raw, digester);
    if (
      configuration.contentDigest !== generation.binding.configurationDigest ||
      configuration.revision !== generation.binding.configurationRevision ||
      configuration.tenantId !== context.actor.tenantId ||
      configuration.spaceId !== context.actor.spaceId ||
      configuration.pluginId !== source.admission.pluginId ||
      configuration.pluginVersion !== source.admission.version
    )
      throw new ApplicationError(
        "conflict",
        "project_historical_query_configuration_mismatch",
      );
    const matches = publications.filter(
      (p) =>
        (["pluginId", "packageDigest", "contributionId"] as const).every(
          (k) => p.source[k] === authority.sourcePin[k],
        ) &&
        (
          [
            "pluginId",
            "publisherId",
            "version",
            "packageDigest",
            "contributionId",
          ] as const
        ).every((k) => p.target[k] === source.admission[k]) &&
        p.target.manifestDigest === configuration.manifestDigest &&
        p.target.implementationDigest === configuration.implementationDigest,
    );
    if (matches.length !== 1)
      throw new ApplicationError(
        "authorization",
        "project_historical_query_target_unapproved",
      );
    const publication = matches[0]!,
      capturedInput = Object.freeze({ context, authority, request });
    await authority.assertCurrent();
    return Object.freeze({
      publication,
      generation,
      source,
      configuration,
      request,
      sourcePin: authority.sourcePin,
      command(executionPin: PluginTaskAdmissionPin) {
        assertProjectHistoricalQueryExecutionPublication({
          publication,
          sourcePin: authority.sourcePin,
          executionPin,
        });
        return projectHistoricalQueryUiTaskCommand(
          {
            sourcePin: authority.sourcePin,
            executionPin,
            request,
            sourceRunId: generation.binding.runId,
          },
          digester,
        );
      },
      async assertCurrent() {
        const latest = await resolve(capturedInput);
        if (
          extensionCanonicalJson({
            generation: latest.generation,
            source: latest.source,
            configuration: latest.configuration,
            publication: latest.publication,
          }) !==
          extensionCanonicalJson({
            generation,
            source,
            configuration,
            publication,
          })
        )
          throw new ApplicationError(
            "conflict",
            "project_historical_query_source_changed",
          );
      },
      assertTransactionCurrent: () => authority.assertTransactionCurrent(),
      assertActive: () => authority.assertActive(),
    });
  };
  return Object.freeze({ resolve });
}
