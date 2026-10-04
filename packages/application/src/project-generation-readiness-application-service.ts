import {
  requirePluginTaskFinancialMode,
  preparePluginTaskUnmeteredAuthority,
} from "./plugin-task-unmetered-support.ts";
import {
  extensionCanonicalJson,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginTaskAdmissionPin,
  parseProjectGenerationPublication,
  parseProjectGenerationReference,
  validateExtensionTaskInput,
  type ProjectGenerationReference,
  type ProjectGenerationPublication,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ExtensionTaskApplicationDependencies } from "./extension-task-application-service.ts";
import type { ProjectGenerationExecutionAuthority } from "./project-generation-execution-authority.ts";
import { projectGenerationHostFields } from "./project-generation-execution-authority.ts";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  captureCreativeProjectTransactionAuthority,
} from "./creative-project-commit-authority.ts";
import {
  authorizeExtension,
  extensionScopeFor,
  extensionUseCase,
  requireExtensionRegistration,
} from "./extension-application-support.ts";
import {
  pluginTaskActor,
  requirePluginTaskStore,
} from "./extension-plugin-task-support.ts";
import {
  isProjectGenerationReadinessInputUnavailable,
  readProjectGenerationReadinessSource,
} from "./project-generation-readiness-source.ts";

export type ProjectGenerationReadiness =
  | Readonly<{ outcome: "ready" }>
  | Readonly<{
      outcome: "unavailable";
      reasonCode:
        | "project_generation_input_unavailable"
        | "project_generation_configuration_unavailable"
        | "project_generation_runtime_unavailable";
    }>;
export type GetPublishedProjectGenerationReadinessInput = Readonly<{
  actor: ActorContext;
  reference: ProjectGenerationReference;
  publication: ProjectGenerationPublication;
  sourcePin: PluginTaskAdmissionPin;
  executionPin: PluginTaskAdmissionPin;
  authority: ProjectGenerationExecutionAuthority;
}>;
export type PublishedProjectGenerationReadinessResult = Readonly<{
  reference: ProjectGenerationReference;
  readiness: ProjectGenerationReadiness;
}>;

/** Read-only preparation on the actual installed task dependencies. It never allocates an intent or a quote. */
export async function getPublishedProjectGenerationReadiness(
  dependencies: ExtensionTaskApplicationDependencies,
  input: GetPublishedProjectGenerationReadinessInput,
): Promise<PublishedProjectGenerationReadinessResult> {
  const fields = projectGenerationHostFields(input, [
    "actor",
    "reference",
    "publication",
    "sourcePin",
    "executionPin",
    "authority",
  ]);
  const reference = parseProjectGenerationReference(fields.reference);
  const publication = parseProjectGenerationPublication(fields.publication);
  const sourcePin = parsePluginTaskAdmissionPin(fields.sourcePin);
  const executionPin = parsePluginTaskAdmissionPin(fields.executionPin);
  const actor = pluginTaskActor(fields.actor as ActorContext, executionPin);
  pluginTaskActor(actor, sourcePin);
  // The read action remains the real source action; the paid generation pin is not forged.
  if (
    sourcePin.action !== "crewon.project-generation-contexts.v1.getReadiness" ||
    (["pluginId", "packageDigest", "contributionId"] as const).some(
      (key) => sourcePin[key] !== publication.source[key],
    ) ||
    (["pluginId", "packageDigest", "contributionId", "action"] as const).some(
      (key) => executionPin[key] !== publication.target[key],
    ) ||
    sourcePin.profileId !== executionPin.profileId
  )
    throw new ApplicationError(
      "authorization",
      "project_generation_readiness_publication_mismatch",
    );
  const authority = captureCreativeProjectTransactionAuthority(
    fields.authority as ProjectGenerationExecutionAuthority,
  ).preflight;
  const scope = extensionScopeFor(actor, executionPin.pluginId);
  const projects = dependencies.creativeProjects;
  const fence = async () => {
    assertCreativeProjectCommitActive(authority);
    await assertCreativeProjectCommitCurrent(authority);
    assertCreativeProjectCommitActive(authority);
  };
  const authorize = async () => {
    await fence();
    if (
      projects !== undefined &&
      (
        await projects.authorization.authorize({
          actor,
          action: "creativeProject:write",
          resource: {
            kind: "creativeProject",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            projectId: reference.projectId,
          },
        })
      ).outcome !== "allow"
    )
      throw new ApplicationError("authorization", "authorization_denied");
    await authorizeExtension(
      dependencies.authorization,
      actor,
      "extension:run",
      scope,
    );
    await fence();
  };
  const response = async (readiness: ProjectGenerationReadiness) => {
    await authorize();
    return Object.freeze({ reference, readiness: Object.freeze(readiness) });
  };
  return extensionUseCase(async () => {
    await authorize();
    if (
      projects === undefined ||
      dependencies.extensions.projectGenerationVersion !==
        "crewon.project-generation-link.v0" ||
      dependencies.extensions.projectGenerationPublicationVersion !==
        "crewon.project-generation-publication.v1" ||
      typeof dependencies.extensions.loadProjectGenerationLink !== "function"
    )
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    const source = async () => {
      try {
        const value = await readProjectGenerationReadinessSource({
          actor,
          reference,
          projects,
          digester: dependencies.digester,
        });
        await fence();
        return value;
      } catch (error) {
        await fence();
        if (isProjectGenerationReadinessInputUnavailable(error)) return null;
        throw error;
      }
    };
    const saved = await source();
    if (saved === null)
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_input_unavailable",
      });
    try {
      requirePluginTaskStore(
        dependencies.extensions,
        dependencies.unmeteredTasks === undefined ? "metered" : "unmetered",
      );
      requirePluginTaskFinancialMode(
        dependencies.extensions,
        dependencies.creditQuotes,
        dependencies.unmeteredTasks,
      );
      await preparePluginTaskUnmeteredAuthority(
        dependencies.unmeteredTasks,
        actor,
        executionPin,
      );
      await fence();
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.category !== "conflict")
        throw error;
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    }
    const rawActivation =
      await dependencies.extensions.loadExtensionActivation(scope);
    await fence();
    if (rawActivation === null)
      throw new ApplicationError("authorization", "extension_access_revoked");
    const activation = parseExtensionActivation(rawActivation);
    if (
      activation.tenantId !== scope.tenantId ||
      activation.spaceId !== scope.spaceId ||
      activation.pluginId !== scope.pluginId
    )
      throw new ApplicationError(
        "internal",
        "extension_activation_scope_mismatch",
      );
    if (activation.state === "revoked")
      throw new ApplicationError("authorization", "extension_access_revoked");
    if (activation.state !== "enabled" || activation.target === null)
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    const target = parseExtensionExecutionTarget(activation.target);
    const configuration =
      await dependencies.extensions.loadExtensionConfiguration({
        ...scope,
        revision: activation.configurationRevision,
      });
    await fence();
    if (configuration === null)
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    const frozen = parseExtensionConfiguration(
      configuration,
      dependencies.digester,
    );
    if (
      frozen.tenantId !== scope.tenantId ||
      frozen.spaceId !== scope.spaceId ||
      frozen.pluginId !== scope.pluginId ||
      frozen.revision !== activation.configurationRevision ||
      frozen.contentDigest !== activation.configurationDigest
    )
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    let registration;
    try {
      registration = requireExtensionRegistration(
        dependencies.catalog,
        dependencies.digester,
        frozen,
      );
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === "extension_version_unavailable"
      )
        return response({
          outcome: "unavailable",
          reasonCode: "project_generation_configuration_unavailable",
        });
      throw error;
    }
    if (
      registration.manifestDigest !== frozen.manifestDigest ||
      registration.implementationDigest !== frozen.implementationDigest
    )
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    if (dependencies.host.taskAdmissionMode?.({ registration }) !== "installed")
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    // Validate the same saved input schema as admission without creating a command or Turn.
    validateExtensionTaskInput(registration.manifest, {
      prompt: saved.assetRevision.prompt,
    });
    const readiness = await dependencies.host.evaluate({
      actor,
      registration,
      configuration: frozen,
      agentVersionId: target.agentVersionId,
    });
    await fence();
    if (readiness.outcome !== "ready")
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_runtime_unavailable",
      });
    if (
      extensionCanonicalJson(
        parseExtensionExecutionTarget(readiness.target),
      ) !== extensionCanonicalJson(target)
    )
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_runtime_unavailable",
      });
    // Awaited peer readiness cannot preserve an earlier project CAS, activation or configuration.
    if ((await source()) === null)
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_input_unavailable",
      });
    const latest = await dependencies.extensions.loadExtensionActivation(scope);
    await fence();
    if (latest === null)
      throw new ApplicationError("authorization", "extension_access_revoked");
    const latestActivation = parseExtensionActivation(latest);
    if (latestActivation.state === "revoked")
      throw new ApplicationError("authorization", "extension_access_revoked");
    const latestConfiguration =
      await dependencies.extensions.loadExtensionConfiguration({
        ...scope,
        revision: activation.configurationRevision,
      });
    await fence();
    if (
      extensionCanonicalJson(latestActivation) !==
        extensionCanonicalJson(activation) ||
      latestConfiguration === null ||
      extensionCanonicalJson(
        parseExtensionConfiguration(latestConfiguration, dependencies.digester),
      ) !== extensionCanonicalJson(frozen)
    )
      return response({
        outcome: "unavailable",
        reasonCode: "project_generation_configuration_unavailable",
      });
    return response({ outcome: "ready" });
  });
}
