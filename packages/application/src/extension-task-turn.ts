import { prepareExtensionTaskModel } from "./extension-task-model-selection.ts";
import { prepareExtensionTaskComposition } from "./extension-task-composition.ts";
import {
  assertExtensionContentStages,
  extensionContentStageReceipt,
  extensionContentStageCommitOptions,
} from "./extension-task-content-stages.ts";
import {
  projectMediaInputConversationTaskAdmission,
  type ProjectMediaInputConversationTask,
} from "./project-media-input-conversation-task-support.ts";
import { loadExtensionTaskConfiguration } from "./extension-task-configuration.ts";
import {
  projectAssetConversationTaskAdmission,
  type ProjectAssetConversationTask,
} from "./project-asset-conversation-task-support.ts";
import { projectTextPlanTaskAdmission } from "./extension-task-project-text-plan-support.ts";
import type { ProjectTextPlanTurnCommitAuthority } from "./project-text-plan-store-port.ts";
import {
  authorizeExtensionTaskThread,
  authorizeExtensionTaskQuerySource,
} from "./extension-task-authorization.ts";
import {
  projectConversationTaskAdmission,
  type ProjectConversationTask,
} from "./project-conversation-task-support.ts";
import type { PluginTaskUnmeteredAuthorityPort } from "./plugin-task-unmetered-authority-port.ts";
import {
  requirePluginTaskFinancialMode,
  preparePluginTaskUnmeteredAuthority,
  pluginTaskFinancialOptions,
  pluginTaskUnmeteredProof,
  assertSavedPluginTaskFunding,
} from "./plugin-task-unmetered-support.ts";
import { loadExtensionLegacyQuerySource } from "./extension-legacy-query-source.ts";
import {
  quoteExtensionTaskGeneration,
  assertExtensionTaskCreditPrincipal,
} from "./extension-task-credit-support.ts";
import {
  commitProjectGenerationTask,
  projectGenerationTaskAdmission,
  type CapturedProjectGenerationTask,
} from "./project-generation-application-support.ts";

import { parseExtensionTaskIntent as parseIntent } from "./extension-task-intent.ts";
import {
  createExtensionRunBinding,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionActivation,
  parseExtensionExecutionTarget,
  validateExtensionTaskInput,
  type WorkflowSchemaValue,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";

import type { ExtensionHostPort } from "./extension-host-port.ts";

import { TurnApplicationService } from "./turn-application-service.ts";
import {
  authorizeExtension,
  extensionActor,
  extensionCommand,
  extensionScopeFor,
  extensionUseCase,
  requireExtensionRegistration,
  requirePinnedExtensionRegistration,
} from "./extension-application-support.ts";
import {
  assertSavedPluginTask,
  commitPluginTask,
  pluginTaskActor,
  pluginTaskAdmission,
  pluginTaskReceipt,
  resolvePluginTaskReceipt,
  requirePluginTaskStore,
  type PluginTaskCommitAuthorityPort,
} from "./extension-plugin-task-support.ts";

import type {
  ExtensionTaskApplicationDependencies,
  CreateExtensionTaskCommand,
} from "./extension-task-application-service.ts";
import { publishExtensionProjectTaskStages } from "./extension-task-stage-results.ts";
import { projectMediaGenerationTaskAdmission } from "./extension-task-media-generation.ts";
import {
  MEDIA_GENERATION_ACTION,
  MEDIA_GENERATION_INPUT_KIND,
  mediaGenerationFail,
} from "./project-media-generation-record.ts";
import type { ProjectMediaGenerationTask } from "./project-media-generation-port.ts";
export type ExtensionTaskCreationContext = Readonly<{
  dependencies: ExtensionTaskApplicationDependencies;
  unmeteredTasks: PluginTaskUnmeteredAuthorityPort | undefined;
  turns: TurnApplicationService;
  taskAdmissionMode: ExtensionHostPort["taskAdmissionMode"];
}>;
export type ExtensionTaskStartRequest = Readonly<{
  actorInput: ActorContext;
  input: CreateExtensionTaskCommand;
  pin: PluginTaskAdmissionPin | null;
  commitAuthority?: PluginTaskCommitAuthorityPort | null;
  projectTask?: CapturedProjectGenerationTask | null;
  conversation?: ProjectConversationTask | null;
  onProjectStage?: (
    stage: import("@crewon/domain").ProjectStageRunAdmission,
  ) => void;
  projectTextPlan?: ProjectTextPlanTurnCommitAuthority | null;
  assetStage?: Readonly<{
    task: ProjectAssetConversationTask;
    onStage(
      stage: import("@crewon/domain").ProjectAssetStageRunAdmission,
    ): void;
  }> | null;
  mediaInputStage?: Readonly<{
    task: ProjectMediaInputConversationTask;
    onStage(
      stage: import("@crewon/domain").ProjectMediaInputStageRunAdmission,
    ): void;
  }> | null;
  mediaTask?: ProjectMediaGenerationTask | null;
}>;
/** Sole task Turn orchestration, called by the original application facade. */
export async function createExtensionTaskTurn(
  context: ExtensionTaskCreationContext,
  request: ExtensionTaskStartRequest,
) {
  const {
    actorInput,
    input,
    pin,
    commitAuthority = null,
    projectTask = null,
    conversation = null,
    onProjectStage,
    projectTextPlan = null,
    assetStage = null,
    mediaInputStage = null,
    mediaTask = null,
  } = request;
  return extensionUseCase(async () => {
    await assertExtensionContentStages(request);
    const actor =
      pin === null
        ? extensionActor(actorInput)
        : pluginTaskActor(actorInput, pin);
    const value = extensionCommand(input, [
      "pluginId",
      "threadId",
      "expectedThreadRevision",
      "idempotencyKey",
      "intent",
    ]);
    const scope = extensionScopeFor(actor, value.pluginId as string);
    const threadId = extensionOpaqueId(value.threadId);
    if (
      typeof value.expectedThreadRevision !== "number" ||
      !Number.isSafeInteger(value.expectedThreadRevision) ||
      value.expectedThreadRevision < 1
    )
      throw new ApplicationError(
        "validation",
        "extension_thread_revision_invalid",
      );
    const expectedThreadRevision = value.expectedThreadRevision;
    const idempotencyKey = extensionOpaqueId(value.idempotencyKey);
    const intent = parseIntent(value.intent);
    if (pin !== null) {
      if (intent.kind !== "generate")
        throw new ApplicationError(
          "validation",
          "plugin_task_query_unsupported",
        );
      if (pin.pluginId !== scope.pluginId)
        throw new ApplicationError(
          "authorization",
          "plugin_task_admission_owner_mismatch",
        );
      requirePluginTaskStore(
        context.dependencies.extensions,
        context.unmeteredTasks === undefined ? "metered" : "unmetered",
      );
    }
    const queryHost =
      intent.kind === "query" ? context.dependencies.queryHost : undefined;
    const command = {
      pluginId: scope.pluginId,
      threadId,
      expectedThreadRevision,
      idempotencyKey,
      intent,
    };
    const generation =
      projectTask === null
        ? null
        : projectGenerationTaskAdmission({
            captured: projectTask,
            projects: context.dependencies.creativeProjects,
            extensions: context.dependencies.extensions,
            executionAuthorization: context.dependencies.authorization,
            digester: context.dependencies.digester,
            actor,
            command,
          });
    if (
      mediaTask !== null &&
      (pin === null ||
        projectTask !== null ||
        conversation !== null ||
        assetStage !== null ||
        mediaInputStage !== null ||
        projectTextPlan !== null)
    )
      mediaGenerationFail("task_invalid");
    const media =
      mediaTask === null
        ? null
        : projectMediaGenerationTaskAdmission({
            task: mediaTask,
            actor,
            command,
            pin: pin!,
            extensions: context.dependencies.extensions,
          });
    if (
      scope.pluginId === "crewon.short-drama" &&
      media === null &&
      (pin?.action === MEDIA_GENERATION_ACTION ||
        (intent.kind === "generate" &&
          typeof intent.input === "object" &&
          intent.input !== null &&
          !Array.isArray(intent.input) &&
          Object.getOwnPropertyDescriptor(intent.input, "kind")?.value ===
            MEDIA_GENERATION_INPUT_KIND))
    )
      mediaGenerationFail("authority_required");
    if (media !== null) await media.assertCurrent();
    if (generation !== null) await generation.assertCurrent();
    await authorizeExtension(
      context.dependencies.authorization,
      actor,
      intent.kind === "generate" ? "extension:run" : "extension:query",
      scope,
    );
    await authorizeExtensionTaskThread(
      context.dependencies.authorization,
      actor,
      threadId,
    );
    const currentThread = await context.dependencies.store.loadThreadInSpace({
      ...actor,
      threadId,
    });
    if (currentThread === null || currentThread.status === "deleted")
      throw new ApplicationError("notFound", "thread_not_found");
    // Query permission on the original Run is rechecked even for an idempotent replay.
    const source =
      intent.kind === "query"
        ? await loadExtensionLegacyQuerySource(
            context.dependencies,
            actor,
            scope.pluginId,
            intent,
          )
        : null;
    const pluginReceipt =
      pin !== null
        ? await resolvePluginTaskReceipt({
            store: context.dependencies.extensions,
            actor,
            command,
            pin,
            digester: context.dependencies.digester,
            ...(generation === null
              ? {}
              : { projectGeneration: generation.reference }),
            ...(media === null
              ? {}
              : { projectConversationReceipt: (base) => media.receipt(base) }),
            ...(conversation === null &&
            assetStage === null &&
            mediaInputStage === null
              ? {}
              : {
                  projectConversationReceipt: (base) =>
                    extensionContentStageReceipt(
                      base,
                      request,
                      context.dependencies.digester,
                    ),
                }),
          })
        : null;
    const taskReceipt =
      pin === null
        ? {
            actorId: actor.actorId,
            idempotencyKey,
            requestDigest: context.dependencies.digester.sha256(
              extensionCanonicalJson({
                schemaVersion: "crewon.extension-task-command.v0",
                tenantId: actor.tenantId,
                spaceId: actor.spaceId,
                actorId: actor.actorId,
                command,
              }),
            ),
          }
        : (pluginReceipt?.receipt ??
          pluginTaskReceipt(
            actor,
            command,
            pin,
            context.dependencies.digester,
          ));
    const receipt =
      generation === null || pluginReceipt !== null
        ? taskReceipt
        : generation.receipt(taskReceipt);
    const previous =
      await context.dependencies.extensions.loadExtensionTurnReceipt({
        ...scope,
        receipt,
      });
    if (previous !== null) {
      assertExtensionTaskCreditPrincipal(
        context.dependencies.digester,
        actor,
        previous.creditAdmission,
        previous.binding,
        receipt,
      );
      if (pin !== null) {
        assertSavedPluginTaskFunding(
          previous,
          actor,
          receipt,
          context.dependencies.digester,
        );
        await assertSavedPluginTask({
          store: context.dependencies.extensions,
          pin: pluginReceipt?.receiptPin ?? pin,
          binding: previous.binding,
          threadId,
          receipt,
          digester: context.dependencies.digester,
        });
      }
      if (generation !== null) {
        await generation.assertSaved(previous.binding, receipt);
        await generation.assertCurrent();
        generation.assertActive();
      }
      if (media !== null) {
        await media.assertSaved(previous.binding, receipt);
        await media.assertCurrent();
        media.assertActive();
      }
      await publishExtensionProjectTaskStages({
        extensions: context.dependencies.extensions,
        digester: context.dependencies.digester,
        result: previous,
        conversation,
        assetStage,
        mediaInputStage,
        projectTextPlan,
        onProjectStage,
        phase: "replay",
      });
      return previous;
    }
    if (pin !== null)
      requirePluginTaskFinancialMode(
        context.dependencies.extensions,
        context.dependencies.creditQuotes,
        context.unmeteredTasks,
      );
    const unmeteredAuthority = await preparePluginTaskUnmeteredAuthority(
      context.unmeteredTasks,
      actor,
      pin,
    );
    const activationValue =
      await context.dependencies.extensions.loadExtensionActivation(scope);
    if (activationValue === null)
      throw new ApplicationError("authorization", "extension_access_revoked");
    const activation = parseExtensionActivation(activationValue);
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
    if (
      source === null &&
      (activation.state !== "enabled" || activation.target === null)
    )
      throw new ApplicationError("conflict", "extension_generation_disabled");
    const configured = await loadExtensionTaskConfiguration({
      extensions: context.dependencies.extensions,
      digester: context.dependencies.digester,
      scope,
      activation,
      source,
    });
    const { frozen } = configured;
    const selectedModel = await prepareExtensionTaskModel({
      port: context.dependencies.modelSelection,
      actor,
      pin,
      configuration: frozen,
      defaultTarget: configured.target,
      modelId:
        conversation?.modelId ??
        assetStage?.task.modelId ??
        mediaInputStage?.task.modelId,
      plan: projectTextPlan,
      digester: context.dependencies.digester,
    });
    const target = selectedModel?.target ?? configured.target;
    const identity = Object.freeze({
      pluginId: frozen.pluginId,
      pluginVersion: frozen.pluginVersion,
      manifestDigest: frozen.manifestDigest,
      implementationDigest: frozen.implementationDigest,
    });
    const resolved =
      queryHost === undefined
        ? undefined
        : await queryHost.resolveRegistration(
            Object.freeze({ actor, identity }),
          );
    if (resolved === null)
      throw new ApplicationError(
        "conflict",
        "extension_implementation_unavailable",
      );
    const registration =
      queryHost === undefined
        ? requireExtensionRegistration(
            context.dependencies.catalog,
            context.dependencies.digester,
            frozen,
          )
        : requirePinnedExtensionRegistration(
            resolved,
            context.dependencies.digester,
            identity,
          );
    if (
      registration.manifestDigest !== frozen.manifestDigest ||
      registration.implementationDigest !== frozen.implementationDigest
    )
      throw new ApplicationError(
        "conflict",
        "extension_implementation_unavailable",
      );
    const admissionMode =
      context.taskAdmissionMode === undefined
        ? "legacy"
        : context.taskAdmissionMode(Object.freeze({ registration }));
    if (admissionMode !== "legacy" && admissionMode !== "installed")
      throw new ApplicationError(
        "internal",
        "extension_task_admission_mode_invalid",
      );
    if (admissionMode === "installed" && pin === null)
      throw new ApplicationError(
        "conflict",
        "installed_plugin_task_admission_required",
      );
    const taskInput =
      intent.kind === "generate"
        ? validateExtensionTaskInput(registration.manifest, intent.input)
        : { kind: "query", operationId: intent.operationId };
    if (generation !== null) await generation.assertNewInput(taskInput);
    if (media !== null) await media.assertNewInput(taskInput);
    if (queryHost !== undefined && source !== null)
      await authorizeExtensionTaskQuerySource(
        context.dependencies.authorization,
        actor,
        scope.pluginId,
        source,
      );
    const readinessInput = Object.freeze({
      actor,
      registration,
      configuration: frozen,
      agentVersionId: target.agentVersionId,
    });
    const readiness =
      queryHost === undefined
        ? await context.dependencies.host.evaluate(readinessInput)
        : await queryHost.evaluate(
            Object.freeze({ ...readinessInput, expectedTarget: target }),
          );
    if (readiness.outcome !== "ready")
      throw new ApplicationError(
        "conflict",
        readiness.outcome === "unavailable"
          ? readiness.reasonCode
          : "extension_runtime_unavailable",
      );
    let readyTarget: typeof target;
    try {
      readyTarget = parseExtensionExecutionTarget(readiness.target);
    } catch (error) {
      throw new ApplicationError(
        "internal",
        "extension_runtime_target_invalid",
        { cause: error },
      );
    }
    if (extensionCanonicalJson(readyTarget) !== extensionCanonicalJson(target))
      throw new ApplicationError(
        "conflict",
        "extension_execution_target_mismatch",
      );
    const content =
      mediaInputStage?.task.content ??
      assetStage?.task.content ??
      conversation?.content ??
      extensionCanonicalJson(taskInput);
    if (new TextEncoder().encode(content).length > 16 * 1024)
      throw new ApplicationError("validation", "extension_task_input_invalid");
    const composition = await prepareExtensionTaskComposition(
      context.dependencies,
      pin,
    );
    const turn = await context.turns.prepareTurn(actor, {
      kind: "turn.start",
      threadId,
      expectedThreadRevision,
      idempotencyKey: receipt.idempotencyKey,
      content,
      executionIntentVersion: "v1",
      executionIntent: "none",
      requestedAgentVersionId: target.agentVersionId,
      route: {
        agentVersionId: target.agentVersionId,
        authorityId: target.authorityId,
        runtimeGeneration: target.runtimeGeneration,
        policySnapshotId: target.policySnapshotId,
        workspaceBindingId: target.workspaceBindingId,
      },
    });
    const event = turn.run.events[0]!;
    if (event.type !== "run.created" || event.data.goalBinding != null)
      throw new ApplicationError("conflict", "extension_thread_goal_active");
    const binding = createExtensionRunBinding(
      {
        ...(composition === null
          ? { schemaVersion: "crewon.extension-run-binding.v0" as const }
          : {
              schemaVersion: "crewon.extension-run-binding.v1" as const,
              composition,
            }),
        ...scope,
        actorId: actor.actorId,
        threadId,
        runId: event.identity.runId,
        configurationRevision: frozen.revision,
        configurationDigest: frozen.contentDigest,
        target,
        inputDigest: context.dependencies.digester.sha256(content),
        source:
          source === null || intent.kind !== "query"
            ? null
            : {
                runId: source.runId,
                bindingDigest: source.bindingDigest,
                operationId: intent.operationId,
              },
      },
      context.dependencies.digester,
    );
    if (queryHost !== undefined && source !== null)
      await authorizeExtensionTaskQuerySource(
        context.dependencies.authorization,
        actor,
        scope.pluginId,
        source,
      );
    const taskAdmission =
      pin === null
        ? undefined
        : pluginTaskAdmission(
            pin,
            binding,
            receipt,
            context.dependencies.digester,
          );
    const stageAdmission =
      conversation === null
        ? undefined
        : projectConversationTaskAdmission(
            conversation,
            taskAdmission!,
            binding,
            event.occurredAt,
            context.dependencies.digester,
          );
    const assetStageAdmission =
      assetStage === null
        ? undefined
        : projectAssetConversationTaskAdmission(
            assetStage.task,
            taskAdmission!,
            binding,
            event.occurredAt,
            context.dependencies.digester,
          );
    const mediaInputStageAdmission =
      mediaInputStage === null
        ? undefined
        : projectMediaInputConversationTaskAdmission(
            mediaInputStage.task,
            taskAdmission!,
            binding,
            event.occurredAt,
            context.dependencies.digester,
          );
    if (mediaInputStage !== null && unmeteredAuthority === null)
      throw new ApplicationError(
        "conflict",
        "project_media_input_stage_unmetered_required",
      );
    const creditAdmission =
      intent.kind === "generate" &&
      unmeteredAuthority === null &&
      context.dependencies.creditQuotes !== undefined
        ? await quoteExtensionTaskGeneration(
            context.dependencies,
            actor,
            binding,
            receipt,
            taskInput as WorkflowSchemaValue,
            assetStageAdmission !== undefined
              ? { projectAssetStageAdmission: assetStageAdmission }
              : stageAdmission === undefined
                ? undefined
                : { projectStageAdmission: stageAdmission },
          )
        : undefined;
    const planAdmission =
      projectTextPlan === null
        ? undefined
        : projectTextPlanTaskAdmission(
            projectTextPlan,
            stageAdmission!,
            binding,
            command.idempotencyKey,
            event.occurredAt,
            context.dependencies.digester,
          );
    if (creditAdmission !== undefined || unmeteredAuthority !== null) {
      // A price-policy await cannot retain permission that was revoked in the meantime.
      await authorizeExtension(
        context.dependencies.authorization,
        actor,
        "extension:run",
        scope,
      );
      await authorizeExtensionTaskThread(
        context.dependencies.authorization,
        actor,
        threadId,
      );
    }
    const unmeteredAdmission = pluginTaskUnmeteredProof(
      unmeteredAuthority,
      taskAdmission,
      context.dependencies.digester,
    );
    const financialOptions = pluginTaskFinancialOptions(
      unmeteredAuthority,
      media?.commitOptions ?? generation?.commitOptions,
    );
    const contentOptions = extensionContentStageCommitOptions(
      request,
      financialOptions,
    );
    const commitOptions =
      selectedModel === undefined
        ? contentOptions
        : { ...contentOptions, pluginModelSelection: selectedModel };
    const commitInput = {
      turn,
      binding,
      receipt,
      expectedActivationRevision: activation.revision,
      ...(stageAdmission === undefined
        ? {}
        : { projectStageAdmission: stageAdmission }),
      ...(mediaInputStageAdmission === undefined
        ? {}
        : { projectMediaInputStageAdmission: mediaInputStageAdmission }),
      ...(assetStageAdmission === undefined
        ? {}
        : { projectAssetStageAdmission: assetStageAdmission }),
      ...(planAdmission === undefined
        ? {}
        : { projectTextPlanAdmission: planAdmission }),
      ...(generation === null
        ? {}
        : { projectGeneration: generation.reference }),
      ...(media === null ? {} : { projectMediaGeneration: media.reference }),
      ...(creditAdmission === undefined ? {} : { creditAdmission }),
      ...(taskAdmission === undefined
        ? {}
        : { pluginAdmission: taskAdmission }),
      ...(unmeteredAdmission === undefined ? {} : { unmeteredAdmission }),
    };
    if (unmeteredAuthority !== null) {
      await unmeteredAuthority.assertCurrent();
      unmeteredAuthority.assertActive();
    }
    if (pin !== null && commitAuthority !== null)
      await commitAuthority.assertCurrent({ actor, pin });
    if (generation !== null) await generation.assertDispatchCurrent();
    if (media !== null) await media.assertDispatchCurrent();
    await assertExtensionContentStages(request);
    const result = await (pin === null
      ? context.dependencies.extensions.commitExtensionTurn(commitInput)
      : generation === null
        ? commitPluginTask(
            context.dependencies.extensions,
            commitInput,
            commitOptions,
          )
        : commitProjectGenerationTask(() =>
            commitPluginTask(
              context.dependencies.extensions,
              commitInput,
              commitOptions,
            ),
          ));
    assertExtensionTaskCreditPrincipal(
      context.dependencies.digester,
      actor,
      result.creditAdmission,
      result.binding,
      receipt,
    );
    if (
      creditAdmission !== undefined &&
      (result.run.disposition === "committed" || pin !== null) &&
      result.creditAdmission === undefined
    )
      throw new ApplicationError(
        "internal",
        "extension_credit_admission_missing",
      );
    if (pin !== null)
      assertSavedPluginTaskFunding(
        result,
        actor,
        receipt,
        context.dependencies.digester,
      );
    if (pin !== null)
      await assertSavedPluginTask({
        store: context.dependencies.extensions,
        pin,
        binding: result.binding,
        threadId,
        ...(result.run.disposition === "committed"
          ? { committedBinding: binding }
          : {}),
        receipt,
        digester: context.dependencies.digester,
      });
    if (generation !== null)
      await generation.assertSaved(result.binding, receipt);
    if (media !== null) await media.assertSaved(result.binding, receipt);
    await publishExtensionProjectTaskStages({
      extensions: context.dependencies.extensions,
      digester: context.dependencies.digester,
      result,
      conversation,
      assetStage,
      mediaInputStage,
      projectTextPlan,
      onProjectStage,
      phase: "result",
      stageAdmission,
      assetStageAdmission,
      mediaInputStageAdmission,
    });
    return result;
  });
}
