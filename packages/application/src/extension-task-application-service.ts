import {
  quoteExtensionTaskGeneration,
  assertExtensionTaskCreditPrincipal,
} from "./extension-task-credit-support.ts";
import {
  captureProjectGenerationTask,
  commitProjectGenerationTask,
  projectGenerationTaskAdmission,
  type CapturedProjectGenerationTask,
  type ProjectGenerationApplicationPorts,
} from "./project-generation-application-support.ts";
import type { ProjectGenerationReference } from "@crewon/domain";
import type { CreativeProjectCommitAuthority } from "./creative-project-store-port.ts";
import { parseExtensionTaskIntent as parseIntent } from "./extension-task-intent.ts";
import {
  createExtensionRunBinding,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionRunBinding,
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
  requirePluginTaskQuotes,
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
  /** Explicit project generation integration; ordinary tasks never read project metadata. */
  creativeProjects?: ProjectGenerationApplicationPorts;
}>;
type Dependencies = ExtensionTaskApplicationDependencies;

/** Creates an opt-in user Turn through the existing execution authority and one storage transaction. */
export class ExtensionTaskApplicationService {
  readonly #dependencies: Dependencies;
  readonly #turns: TurnApplicationService;
  readonly #taskAdmissionMode: ExtensionHostPort["taskAdmissionMode"];
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
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

  async #createTask(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
    pin: PluginTaskAdmissionPin | null,
    commitAuthority: PluginTaskCommitAuthorityPort | null = null,
    projectTask: CapturedProjectGenerationTask | null = null,
  ) {
    return extensionUseCase(async () => {
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
        requirePluginTaskStore(this.#dependencies.extensions);
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
      await this.#authorizeThread(actor, threadId);
      const currentThread = await this.#dependencies.store.loadThreadInSpace({
        ...actor,
        threadId,
      });
      if (currentThread === null || currentThread.status === "deleted")
        throw new ApplicationError("notFound", "thread_not_found");
      // Query permission on the original Run is rechecked even for an idempotent replay.
      const source =
        intent.kind === "query"
          ? await this.#source(actor, scope.pluginId, intent)
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
          : pluginTaskReceipt(actor, command, pin, this.#dependencies.digester);
      const receipt =
        generation === null ? taskReceipt : generation.receipt(taskReceipt);
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
          if (previous.creditAdmission === undefined)
            throw new ApplicationError(
              "internal",
              "extension_credit_admission_missing",
            );
          await assertSavedPluginTask({
            store: this.#dependencies.extensions,
            pin,
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
        return previous;
      }
      if (pin !== null)
        requirePluginTaskQuotes(this.#dependencies.creditQuotes);
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
      const target = parseExtensionExecutionTarget(
        source?.target ?? activation.target,
      );
      const configuration =
        await this.#dependencies.extensions.loadExtensionConfiguration({
          ...scope,
          revision:
            source?.configurationRevision ?? activation.configurationRevision,
        });
      if (configuration === null)
        throw new ApplicationError(
          "notFound",
          "extension_configuration_not_found",
        );
      const frozen = parseExtensionConfiguration(
        configuration,
        this.#dependencies.digester,
      );
      if (
        frozen.tenantId !== scope.tenantId ||
        frozen.spaceId !== scope.spaceId ||
        frozen.pluginId !== scope.pluginId ||
        frozen.revision !==
          (source?.configurationRevision ?? activation.configurationRevision) ||
        frozen.contentDigest !==
          (source?.configurationDigest ?? activation.configurationDigest)
      )
        throw new ApplicationError(
          "conflict",
          "extension_configuration_mismatch",
        );
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
        await this.#authorizeQuerySource(actor, scope.pluginId, source);
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
      const content = extensionCanonicalJson(taskInput);
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
        await this.#authorizeQuerySource(actor, scope.pluginId, source);
      const creditAdmission =
        intent.kind === "generate" &&
        this.#dependencies.creditQuotes !== undefined
          ? await quoteExtensionTaskGeneration(
              this.#dependencies,
              actor,
              binding,
              receipt,
              taskInput as WorkflowSchemaValue,
            )
          : undefined;
      if (creditAdmission !== undefined) {
        // A price-policy await cannot retain permission that was revoked in the meantime.
        await authorizeExtension(
          this.#dependencies.authorization,
          actor,
          "extension:run",
          scope,
        );
        await this.#authorizeThread(actor, threadId);
      }
      const commitInput = {
        turn,
        binding,
        receipt,
        expectedActivationRevision: activation.revision,
        ...(generation === null
          ? {}
          : { projectGeneration: generation.reference }),
        ...(creditAdmission === undefined ? {} : { creditAdmission }),
        ...(pin === null
          ? {}
          : {
              pluginAdmission: pluginTaskAdmission(
                pin,
                binding,
                receipt,
                this.#dependencies.digester,
              ),
            }),
      };
      if (pin !== null && commitAuthority !== null)
        await commitAuthority.assertCurrent({ actor, pin });
      const result = await (pin === null
        ? this.#dependencies.extensions.commitExtensionTurn(commitInput)
        : generation === null
          ? commitPluginTask(this.#dependencies.extensions, commitInput)
          : commitProjectGenerationTask(() =>
              commitPluginTask(
                this.#dependencies.extensions,
                commitInput,
                generation.commitOptions,
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
      return result;
    });
  }

  async #authorizeThread(actor: ActorContext, threadId: string) {
    for (const request of [
      {
        actor,
        action: "thread:message:append" as const,
        resource: {
          kind: "thread" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId,
        },
      },
      {
        actor,
        action: "run:create" as const,
        resource: {
          kind: "run" as const,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          threadId,
          runId: null,
        },
      },
    ])
      if (
        (await this.#dependencies.authorization.authorize(request)).outcome !==
        "allow"
      )
        throw new ApplicationError("authorization", "authorization_denied");
  }

  async #authorizeQuerySource(
    actor: ActorContext,
    pluginId: string,
    source: ExtensionRunBinding,
  ) {
    await authorizeExtension(
      this.#dependencies.authorization,
      actor,
      "extension:query",
      extensionScopeFor(actor, pluginId),
    );
    const decision = await this.#dependencies.authorization.authorize({
      actor,
      action: "run:read",
      resource: {
        kind: "run",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: source.threadId,
        runId: source.runId,
      },
    });
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
  }

  async #source(
    actor: ActorContext,
    pluginId: string,
    intent: Extract<ExtensionTaskIntent, { kind: "query" }>,
  ): Promise<ExtensionRunBinding> {
    const run = await this.#dependencies.store.loadRunInSpace({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId: intent.sourceRunId,
    });
    if (run === null)
      throw new ApplicationError(
        "notFound",
        "extension_query_source_not_found",
      );
    const owner = Object.freeze({
      tenantId: run.tenantId,
      spaceId: run.spaceId,
      runId: run.runId,
      threadId: run.threadId,
      actorId: run.createdByActorId,
      agentVersionId: run.agentVersionId,
      authorityId: run.authorityId,
      runtimeGeneration: run.runtimeGeneration,
      policySnapshotId: run.policySnapshotId,
      workspaceBindingId: run.workspaceBindingId,
    });
    if (
      owner.tenantId !== actor.tenantId ||
      owner.spaceId !== actor.spaceId ||
      owner.runId !== intent.sourceRunId
    )
      throw new ApplicationError("internal", "extension_query_source_invalid");
    const permission = await this.#dependencies.authorization.authorize({
      actor,
      action: "run:read",
      resource: {
        kind: "run",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: owner.threadId,
        runId: owner.runId,
      },
    });
    if (permission.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
    const value = await this.#dependencies.extensions.loadExtensionRunBinding({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId: owner.runId,
    });
    if (value === null)
      throw new ApplicationError(
        "notFound",
        "extension_query_source_not_found",
      );
    const source = parseExtensionRunBinding(value, this.#dependencies.digester);
    if (
      source.pluginId !== pluginId ||
      source.source !== null ||
      source.threadId !== owner.threadId
    )
      throw new ApplicationError(
        "notFound",
        "extension_query_source_not_found",
      );
    if (
      source.tenantId !== actor.tenantId ||
      source.spaceId !== actor.spaceId ||
      source.runId !== owner.runId ||
      source.actorId !== owner.actorId ||
      [
        "agentVersionId",
        "authorityId",
        "runtimeGeneration",
        "policySnapshotId",
        "workspaceBindingId",
      ].some(
        (key) =>
          source.target[key as keyof typeof source.target] !==
          owner[key as keyof typeof owner],
      )
    )
      throw new ApplicationError("internal", "extension_query_source_invalid");
    const operation = await this.#dependencies.operations.loadExternalOperation(
      {
        tenantId: actor.tenantId,
        runId: source.runId,
        bindingDigest: source.bindingDigest,
        operationId: intent.operationId,
      },
    );
    if (operation === null)
      throw new ApplicationError(
        "notFound",
        "extension_query_source_not_found",
      );
    if (
      operation.tenantId !== actor.tenantId ||
      operation.runId !== source.runId ||
      operation.bindingDigest !== source.bindingDigest ||
      operation.operationId !== intent.operationId
    )
      throw new ApplicationError(
        "internal",
        "external_operation_identity_conflict",
      );
    return source;
  }
}
