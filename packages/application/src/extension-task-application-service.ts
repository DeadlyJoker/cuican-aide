import { loadExtensionTaskConfiguration } from "./extension-task-configuration.ts";
import {
  createProjectAssetStageTurnFromHost,
  projectAssetConversationTaskReceipt,
  projectAssetConversationTaskAdmission,
  assertSavedProjectAssetConversationTask,
  type ProjectAssetConversationTask,
  type ProjectAssetConversationTaskPreparation,
} from "./project-asset-conversation-task-support.ts";
import {
  commitProjectTextPlanTurnFromHost,
  projectTextPlanTaskAdmission,
  assertSavedProjectTextPlanTask,
} from "./extension-task-project-text-plan-support.ts";
import type { ProjectTextPlanTurnCommitAuthority } from "./project-text-plan-store-port.ts";
import {
  authorizeExtensionTaskThread,
  authorizeExtensionTaskQuerySource,
} from "./extension-task-authorization.ts";
import {
  createProjectConversationTurnFromHost,
  type ProjectConversationTaskPreparation,
  projectConversationTaskReceipt,
  projectConversationTaskAdmission,
  assertSavedProjectConversationTask,
  type ProjectConversationTask,
} from "./project-conversation-task-support.ts";
import type { PluginTaskUnmeteredAuthorityPort } from "./plugin-task-unmetered-authority-port.ts";
import {
  capturePluginTaskUnmeteredPort,
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
  captureProjectGenerationTask,
  capturePublishedProjectGenerationTask,
  commitProjectGenerationTask,
  projectGenerationTaskAdmission,
  type CapturedProjectGenerationTask,
  type ProjectGenerationApplicationPorts,
} from "./project-generation-application-support.ts";
import type { ProjectGenerationReference } from "@crewon/domain";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import type { CreatePublishedProjectTaskInput } from "./project-generation-execution-authority.ts";
import type { CreatePublishedProjectQueryTaskInput } from "./project-query-execution-authority.ts";
import type { ProjectGenerationReadApplicationService } from "./project-generation-read-application-service.ts";
import {
  getPublishedProjectGenerationReadiness,
  type GetPublishedProjectGenerationReadinessInput,
} from "./project-generation-readiness-application-service.ts";
import { parseExtensionTaskIntent as parseIntent } from "./extension-task-intent.ts";
import {
  createExtensionRunBinding,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionActivation,
  parseExtensionExecutionTarget,
  validateExtensionTaskInput,
  type ExtensionRunBinding,
  type WorkflowSchemaValue,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  ExtensionCatalogPort,
  ExtensionHostPort,
} from "./extension-host-port.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import type { ExtensionQueryHostPort } from "./extension-query-host-port.ts";
import type { PluginQueryHostPort } from "./plugin-query-source.ts";
import { PluginQueryTaskApplicationService } from "./plugin-query-task-application-service.ts";
import type { ExternalOperationStore } from "./external-operation-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import type { ExtensionCreditQuotePort } from "./extension-credit-quote-port.ts";
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
  capturePluginTaskCommitAuthority,
  checkedPluginTaskPin,
  commitPluginTask,
  pluginTaskActor,
  pluginTaskAdmission,
  pluginTaskReceipt,
  resolvePluginTaskReceipt,
  requirePluginTaskStore,
  type PluginTaskCommitAuthorityPort,
} from "./extension-plugin-task-support.ts";

export type ExtensionTaskIntent =
  | Readonly<{ kind: "generate"; input: WorkflowSchemaValue }>
  | Readonly<{ kind: "query"; sourceRunId: string; operationId: string }>;
export type CreateExtensionTaskCommand = Readonly<{
  pluginId: string;
  threadId: string;
  expectedThreadRevision: number;
  idempotencyKey: string;
  intent: ExtensionTaskIntent;
}>;
type TaskStore = ConstructorParameters<
  typeof TurnApplicationService
>[0]["store"] &
  Pick<RunStore, "loadRunInSpace">;
export type ExtensionTaskApplicationDependencies = Readonly<{
  store: TaskStore;
  extensions: ExtensionStore;
  operations: ExternalOperationStore;
  catalog: ExtensionCatalogPort;
  host: ExtensionHostPort;
  queryHost?: ExtensionQueryHostPort;
  pluginQueryHost?: PluginQueryHostPort;
  authorization: AuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
  creditQuotes?: ExtensionCreditQuotePort;
  unmeteredTasks?: PluginTaskUnmeteredAuthorityPort;
  /** Explicit project generation integration; ordinary tasks never read project metadata. */
  creativeProjects?: ProjectGenerationApplicationPorts;
  projectGenerationReads?: ProjectGenerationReadApplicationService;
}>;
type Dependencies = ExtensionTaskApplicationDependencies;

/** Creates an opt-in user Turn through the existing execution authority and one storage transaction. */
export class ExtensionTaskApplicationService {
  readonly #dependencies: Dependencies;
  readonly #unmeteredTasks: PluginTaskUnmeteredAuthorityPort | undefined;
  readonly #turns: TurnApplicationService;
  readonly #taskAdmissionMode: ExtensionHostPort["taskAdmissionMode"];
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
    this.#unmeteredTasks = capturePluginTaskUnmeteredPort(
      dependencies.unmeteredTasks,
    );
    this.#turns = new TurnApplicationService(dependencies);
    const taskAdmissionMode = dependencies.host.taskAdmissionMode;
    this.#taskAdmissionMode =
      taskAdmissionMode === undefined
        ? undefined
        : taskAdmissionMode.bind(dependencies.host);
  }

  async createTask(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
  ) {
    return this.#createTask(actorInput, input, null);
  }

  /** Internal host-issued authority only. The original v0 HTTP command does not accept this pin. */
  async createTaskFromPlugin(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
    hostDerivedPin: PluginTaskAdmissionPin,
    commitAuthority?: PluginTaskCommitAuthorityPort,
  ) {
    return this.#createTask(
      actorInput,
      input,
      checkedPluginTaskPin(hostDerivedPin),
      capturePluginTaskCommitAuthority(commitAuthority),
    );
  }

  /** Explicit host-qualified project Turn; the user Message remains plain text. */
  async createProjectConversationTurnFromHost(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    task: ProjectConversationTask | ProjectConversationTaskPreparation,
  ) {
    return createProjectConversationTurnFromHost({
      actor,
      command,
      task,
      extensions: this.#dependencies.extensions,
      digester: this.#dependencies.digester,
      create: (captured, onStage) =>
        this.#createTask(
          actor,
          command,
          captured.authority.pin,
          null,
          null,
          captured,
          onStage,
        ),
    });
  }

  /** Independently approved asset candidate stage; never reinterprets a text-stage grant. */
  createProjectAssetStageTurnFromHost(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    task:
      | ProjectAssetConversationTask
      | ProjectAssetConversationTaskPreparation,
  ) {
    return createProjectAssetStageTurnFromHost({
      actor,
      command,
      task,
      extensions: this.#dependencies.extensions,
      digester: this.#dependencies.digester,
      create: (captured, onStage) =>
        this.#createTask(
          actor,
          command,
          captured.authority.pin,
          null,
          null,
          null,
          undefined,
          null,
          { task: captured, onStage },
        ),
    });
  }

  async createQueryTaskFromPlugin(
    actor: ActorContext,
    input: CreateExtensionTaskCommand,
    pin: PluginTaskAdmissionPin,
    authority?: PluginTaskCommitAuthorityPort,
  ) {
    return new PluginQueryTaskApplicationService(this.#dependencies).create(
      actor,
      input,
      pin,
      authority,
    );
  }

  /** Independent delegated plan path; the original conversation/UI request shape is unchanged. */
  async createProjectTextPlanTurnFromHost(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    task: ProjectConversationTask | ProjectConversationTaskPreparation,
    planAuthority: ProjectTextPlanTurnCommitAuthority,
  ) {
    return commitProjectTextPlanTurnFromHost({
      actor,
      command,
      task,
      planAuthority,
      extensions: this.#dependencies.extensions,
      digester: this.#dependencies.digester,
      create: (captured, onStage, q) =>
        this.#createTask(
          actor,
          command,
          captured.authority.pin,
          null,
          null,
          captured,
          onStage,
          q,
        ),
    });
  }

  createHistoricalPublishedProjectQueryTaskFromPlugin(
    input: import("./project-historical-query-execution-authority.ts").CreateHistoricalPublishedProjectQueryTaskInput,
  ) {
    return new PluginQueryTaskApplicationService(
      this.#dependencies,
    ).createHistoricalPublished(input);
  }

  createPublishedProjectQueryTaskFromPlugin(
    input: CreatePublishedProjectQueryTaskInput,
  ) {
    return new PluginQueryTaskApplicationService(
      this.#dependencies,
    ).createPublished(input);
  }

  /** Internal host-issued project source and authority; the original public task body stays strict. */
  async createProjectTaskFromPlugin(
    actor: ActorContext,
    command: CreateExtensionTaskCommand,
    pin: PluginTaskAdmissionPin,
    reference: ProjectGenerationReference,
    authority: CreativeProjectCommitAuthority,
  ) {
    return this.#createTask(
      actor,
      command,
      checkedPluginTaskPin(pin),
      null,
      captureProjectGenerationTask(reference, authority),
    );
  }

  /** Actual business and execution installation owners; ordinary task bodies cannot provide this qualification. */
  async createPublishedProjectTaskFromPlugin(
    input: CreatePublishedProjectTaskInput,
  ) {
    const captured = capturePublishedProjectGenerationTask(input);
    return this.#createTask(
      captured.actor,
      captured.command,
      captured.executionPin,
      null,
      captured.captured,
    );
  }

  /** Advisory saved-source readiness; no quote, reservation, Node task or Run is created. */
  getPublishedProjectGenerationReadiness(
    input: GetPublishedProjectGenerationReadinessInput,
  ) {
    return getPublishedProjectGenerationReadiness(
      { ...this.#dependencies, unmeteredTasks: this.#unmeteredTasks },
      input,
    );
  }

  async #createTask(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
    pin: PluginTaskAdmissionPin | null,
    commitAuthority: PluginTaskCommitAuthorityPort | null = null,
    projectTask: CapturedProjectGenerationTask | null = null,
    conversation: ProjectConversationTask | null = null,
    onProjectStage?: (
      stage: import("@crewon/domain").ProjectStageRunAdmission,
    ) => void,
    projectTextPlan: ProjectTextPlanTurnCommitAuthority | null = null,
    assetStage: Readonly<{
      task: ProjectAssetConversationTask;
      onStage(
        stage: import("@crewon/domain").ProjectAssetStageRunAdmission,
      ): void;
    }> | null = null,
  ) {
    return extensionUseCase(async () => {
      if (assetStage !== null) {
        if (
          conversation !== null ||
          projectTextPlan !== null ||
          projectTask !== null ||
          pin === null
        )
          throw new ApplicationError(
            "authorization",
            "project_asset_stage_admission_invalid",
          );
        await assetStage.task.authority.assertCurrent();
        assetStage.task.authority.assertActive();
      }
      if (projectTextPlan !== null) {
        await projectTextPlan.authority.assertCurrent();
        projectTextPlan.authority.assertActive();
      }
      if (conversation !== null) {
        await conversation.authority.assertCurrent();
        conversation.authority.assertActive();
      }
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
          this.#dependencies.extensions,
          this.#unmeteredTasks === undefined ? "metered" : "unmetered",
        );
      }
      const queryHost =
        intent.kind === "query" ? this.#dependencies.queryHost : undefined;
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
              projects: this.#dependencies.creativeProjects,
              extensions: this.#dependencies.extensions,
              executionAuthorization: this.#dependencies.authorization,
              digester: this.#dependencies.digester,
              actor,
              command,
            });
      if (generation !== null) await generation.assertCurrent();
      await authorizeExtension(
        this.#dependencies.authorization,
        actor,
        intent.kind === "generate" ? "extension:run" : "extension:query",
        scope,
      );
      await authorizeExtensionTaskThread(
        this.#dependencies.authorization,
        actor,
        threadId,
      );
      const currentThread = await this.#dependencies.store.loadThreadInSpace({
        ...actor,
        threadId,
      });
      if (currentThread === null || currentThread.status === "deleted")
        throw new ApplicationError("notFound", "thread_not_found");
      // Query permission on the original Run is rechecked even for an idempotent replay.
      const source =
        intent.kind === "query"
          ? await loadExtensionLegacyQuerySource(
              this.#dependencies,
              actor,
              scope.pluginId,
              intent,
            )
          : null;
      const pluginReceipt =
        pin !== null
          ? await resolvePluginTaskReceipt({
              store: this.#dependencies.extensions,
              actor,
              command,
              pin,
              digester: this.#dependencies.digester,
              ...(generation === null
                ? {}
                : { projectGeneration: generation.reference }),
              ...(conversation === null && assetStage === null
                ? {}
                : {
                    projectConversationReceipt: (base) =>
                      assetStage !== null
                        ? projectAssetConversationTaskReceipt(
                            base,
                            assetStage.task,
                            this.#dependencies.digester,
                          )
                        : projectConversationTaskReceipt(
                            base,
                            conversation!,
                            this.#dependencies.digester,
                          ),
                  }),
            })
          : null;
      const taskReceipt =
        pin === null
          ? {
              actorId: actor.actorId,
              idempotencyKey,
              requestDigest: this.#dependencies.digester.sha256(
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
              this.#dependencies.digester,
            ));
      const receipt =
        generation === null || pluginReceipt !== null
          ? taskReceipt
          : generation.receipt(taskReceipt);
      const previous =
        await this.#dependencies.extensions.loadExtensionTurnReceipt({
          ...scope,
          receipt,
        });
      if (previous !== null) {
        assertExtensionTaskCreditPrincipal(
          this.#dependencies.digester,
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
            this.#dependencies.digester,
          );
          await assertSavedPluginTask({
            store: this.#dependencies.extensions,
            pin: pluginReceipt?.receiptPin ?? pin,
            binding: previous.binding,
            threadId,
            receipt,
            digester: this.#dependencies.digester,
          });
        }
        if (generation !== null) {
          await generation.assertSaved(previous.binding, receipt);
          await generation.assertCurrent();
          generation.assertActive();
        }
        if (conversation !== null) {
          const savedAdmission = await this.#dependencies.extensions
            .loadPluginTaskAdmission!({
            tenantId: scope.tenantId,
            spaceId: scope.spaceId,
            runId: previous.binding.runId,
          });
          if (savedAdmission === null)
            throw new ApplicationError(
              "internal",
              "plugin_task_admission_invalid",
            );
          const savedStage = await assertSavedProjectConversationTask(
            conversation,
            savedAdmission,
            previous.binding,
            this.#dependencies.digester,
          );
          onProjectStage?.(savedStage);
        }
        if (projectTextPlan !== null)
          assertSavedProjectTextPlanTask(
            projectTextPlan,
            previous,
            this.#dependencies.digester,
          );
        if (assetStage !== null) {
          const saved = await this.#dependencies.extensions
            .loadPluginTaskAdmission!({
            tenantId: scope.tenantId,
            spaceId: scope.spaceId,
            runId: previous.binding.runId,
          });
          if (saved === null)
            throw new ApplicationError(
              "internal",
              "plugin_task_admission_invalid",
            );
          assetStage.onStage(
            await assertSavedProjectAssetConversationTask(
              assetStage.task,
              saved,
              previous.binding,
              this.#dependencies.digester,
            ),
          );
        }
        return previous;
      }
      if (pin !== null)
        requirePluginTaskFinancialMode(
          this.#dependencies.extensions,
          this.#dependencies.creditQuotes,
          this.#unmeteredTasks,
        );
      const unmeteredAuthority = await preparePluginTaskUnmeteredAuthority(
        this.#unmeteredTasks,
        actor,
        pin,
      );
      const activationValue =
        await this.#dependencies.extensions.loadExtensionActivation(scope);
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
      const { target, frozen } = await loadExtensionTaskConfiguration({
        extensions: this.#dependencies.extensions,
        digester: this.#dependencies.digester,
        scope,
        activation,
        source,
      });
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
              this.#dependencies.catalog,
              this.#dependencies.digester,
              frozen,
            )
          : requirePinnedExtensionRegistration(
              resolved,
              this.#dependencies.digester,
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
        this.#taskAdmissionMode === undefined
          ? "legacy"
          : this.#taskAdmissionMode(Object.freeze({ registration }));
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
      if (queryHost !== undefined && source !== null)
        await authorizeExtensionTaskQuerySource(
          this.#dependencies.authorization,
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
          ? await this.#dependencies.host.evaluate(readinessInput)
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
      if (
        extensionCanonicalJson(readyTarget) !== extensionCanonicalJson(target)
      )
        throw new ApplicationError(
          "conflict",
          "extension_execution_target_mismatch",
        );
      const content =
        assetStage?.task.content ??
        conversation?.content ??
        extensionCanonicalJson(taskInput);
      if (new TextEncoder().encode(content).length > 16 * 1024)
        throw new ApplicationError(
          "validation",
          "extension_task_input_invalid",
        );
      const turn = await this.#turns.prepareTurn(actor, {
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
          schemaVersion: "crewon.extension-run-binding.v0",
          ...scope,
          actorId: actor.actorId,
          threadId,
          runId: event.identity.runId,
          configurationRevision: frozen.revision,
          configurationDigest: frozen.contentDigest,
          target,
          inputDigest: this.#dependencies.digester.sha256(content),
          source:
            source === null || intent.kind !== "query"
              ? null
              : {
                  runId: source.runId,
                  bindingDigest: source.bindingDigest,
                  operationId: intent.operationId,
                },
        },
        this.#dependencies.digester,
      );
      if (queryHost !== undefined && source !== null)
        await authorizeExtensionTaskQuerySource(
          this.#dependencies.authorization,
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
              this.#dependencies.digester,
            );
      const stageAdmission =
        conversation === null
          ? undefined
          : projectConversationTaskAdmission(
              conversation,
              taskAdmission!,
              binding,
              event.occurredAt,
              this.#dependencies.digester,
            );
      const assetStageAdmission =
        assetStage === null
          ? undefined
          : projectAssetConversationTaskAdmission(
              assetStage.task,
              taskAdmission!,
              binding,
              event.occurredAt,
              this.#dependencies.digester,
            );
      const creditAdmission =
        intent.kind === "generate" &&
        unmeteredAuthority === null &&
        this.#dependencies.creditQuotes !== undefined
          ? await quoteExtensionTaskGeneration(
              this.#dependencies,
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
              this.#dependencies.digester,
            );
      if (creditAdmission !== undefined || unmeteredAuthority !== null) {
        // A price-policy await cannot retain permission that was revoked in the meantime.
        await authorizeExtension(
          this.#dependencies.authorization,
          actor,
          "extension:run",
          scope,
        );
        await authorizeExtensionTaskThread(
          this.#dependencies.authorization,
          actor,
          threadId,
        );
      }
      const unmeteredAdmission = pluginTaskUnmeteredProof(
        unmeteredAuthority,
        taskAdmission,
        this.#dependencies.digester,
      );
      const financialOptions = pluginTaskFinancialOptions(
        unmeteredAuthority,
        generation?.commitOptions,
      );
      const commitOptions =
        assetStage !== null
          ? {
              ...financialOptions,
              projectAssetStageAuthority: assetStage.task.authority,
            }
          : conversation === null
            ? financialOptions
            : {
                ...financialOptions,
                projectStageAuthority: conversation.authority,
                ...(projectTextPlan === null
                  ? {}
                  : { projectTextPlanAuthority: projectTextPlan }),
              };
      const commitInput = {
        turn,
        binding,
        receipt,
        expectedActivationRevision: activation.revision,
        ...(stageAdmission === undefined
          ? {}
          : { projectStageAdmission: stageAdmission }),
        ...(assetStageAdmission === undefined
          ? {}
          : { projectAssetStageAdmission: assetStageAdmission }),
        ...(planAdmission === undefined
          ? {}
          : { projectTextPlanAdmission: planAdmission }),
        ...(generation === null
          ? {}
          : { projectGeneration: generation.reference }),
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
      if (projectTextPlan !== null) {
        await projectTextPlan.authority.assertCurrent();
        projectTextPlan.authority.assertActive();
      }
      if (conversation !== null) {
        await conversation.authority.assertCurrent();
        conversation.authority.assertActive();
      }
      if (assetStage !== null) {
        await assetStage.task.authority.assertCurrent();
        assetStage.task.authority.assertActive();
      }
      const result = await (pin === null
        ? this.#dependencies.extensions.commitExtensionTurn(commitInput)
        : generation === null
          ? commitPluginTask(
              this.#dependencies.extensions,
              commitInput,
              commitOptions,
            )
          : commitProjectGenerationTask(() =>
              commitPluginTask(
                this.#dependencies.extensions,
                commitInput,
                commitOptions,
              ),
            ));
      assertExtensionTaskCreditPrincipal(
        this.#dependencies.digester,
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
          this.#dependencies.digester,
        );
      if (pin !== null)
        await assertSavedPluginTask({
          store: this.#dependencies.extensions,
          pin,
          binding: result.binding,
          threadId,
          ...(result.run.disposition === "committed"
            ? { committedBinding: binding }
            : {}),
          receipt,
          digester: this.#dependencies.digester,
        });
      if (generation !== null)
        await generation.assertSaved(result.binding, receipt);
      if (conversation !== null) {
        if (result.run.disposition === "committed")
          onProjectStage?.(stageAdmission!);
        else {
          const savedAdmission = await this.#dependencies.extensions
            .loadPluginTaskAdmission!({
            tenantId: scope.tenantId,
            spaceId: scope.spaceId,
            runId: result.binding.runId,
          });
          if (savedAdmission === null)
            throw new ApplicationError(
              "internal",
              "plugin_task_admission_invalid",
            );
          onProjectStage?.(
            await assertSavedProjectConversationTask(
              conversation,
              savedAdmission,
              result.binding,
              this.#dependencies.digester,
              false,
            ),
          );
        }
      }
      if (assetStage !== null) {
        if (result.run.disposition === "committed")
          assetStage.onStage(assetStageAdmission!);
        else {
          const saved = await this.#dependencies.extensions
            .loadPluginTaskAdmission!({
            tenantId: scope.tenantId,
            spaceId: scope.spaceId,
            runId: result.binding.runId,
          });
          if (saved === null)
            throw new ApplicationError(
              "internal",
              "plugin_task_admission_invalid",
            );
          assetStage.onStage(
            await assertSavedProjectAssetConversationTask(
              assetStage.task,
              saved,
              result.binding,
              this.#dependencies.digester,
              false,
            ),
          );
        }
      }
      return result;
    });
  }
}
