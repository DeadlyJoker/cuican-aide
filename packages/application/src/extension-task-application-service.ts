import {
  createExtensionRunBinding,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionRunBinding,
  validateExtensionTaskInput,
  type ExtensionRunBinding,
  type WorkflowSchemaValue,
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
import type { ExternalOperationStore } from "./external-operation-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import { TurnApplicationService } from "./turn-application-service.ts";
import {
  authorizeExtension,
  extensionActor,
  extensionCommand,
  extensionScopeFor,
  extensionUseCase,
  requireExtensionRegistration,
} from "./extension-application-support.ts";

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
type Dependencies = Readonly<{
  store: TaskStore;
  extensions: ExtensionStore;
  operations: ExternalOperationStore;
  catalog: ExtensionCatalogPort;
  host: ExtensionHostPort;
  authorization: AuthorizationPort;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
}>;

/** Creates an opt-in user Turn through the existing execution authority and one storage transaction. */
export class ExtensionTaskApplicationService {
  readonly #dependencies: Dependencies;
  readonly #turns: TurnApplicationService;
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
    this.#turns = new TurnApplicationService(dependencies);
  }

  async createTask(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
  ) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
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
      const command = {
        pluginId: scope.pluginId,
        threadId,
        expectedThreadRevision,
        idempotencyKey,
        intent,
      };
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
      const receipt = {
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
      };
      const previous =
        await this.#dependencies.extensions.loadExtensionTurnReceipt({
          ...scope,
          receipt,
        });
      if (previous !== null) return previous;
      const activation =
        await this.#dependencies.extensions.loadExtensionActivation(scope);
      if (activation === null || activation.state === "revoked")
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
        frozen.contentDigest !==
        (source?.configurationDigest ?? activation.configurationDigest)
      )
        throw new ApplicationError(
          "conflict",
          "extension_configuration_mismatch",
        );
      const registration = requireExtensionRegistration(
        this.#dependencies.catalog,
        this.#dependencies.digester,
        frozen,
      );
      if (
        registration.manifestDigest !== frozen.manifestDigest ||
        registration.implementationDigest !== frozen.implementationDigest
      )
        throw new ApplicationError(
          "conflict",
          "extension_implementation_unavailable",
        );
      const taskInput =
        intent.kind === "generate"
          ? validateExtensionTaskInput(registration.manifest, intent.input)
          : { kind: "query", operationId: intent.operationId };
      const readiness = await this.#dependencies.host.evaluate({
        actor,
        registration,
        configuration: frozen,
        agentVersionId: target.agentVersionId,
      });
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
        idempotencyKey,
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
      return this.#dependencies.extensions.commitExtensionTurn({
        turn,
        binding,
        receipt,
        expectedActivationRevision: activation.revision,
      });
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
    const permission = await this.#dependencies.authorization.authorize({
      actor,
      action: "run:read",
      resource: {
        kind: "run",
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        threadId: run.threadId,
        runId: run.runId,
      },
    });
    if (permission.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
    const value = await this.#dependencies.extensions.loadExtensionRunBinding({
      ...actor,
      runId: run.runId,
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
      source.threadId !== run.threadId
    )
      throw new ApplicationError(
        "notFound",
        "extension_query_source_not_found",
      );
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
    return source;
  }
}

function parseIntent(input: unknown): ExtensionTaskIntent {
  const value = input as Record<string, unknown>;
  if (value?.kind === "generate") {
    const parsed = extensionCommand(input, ["kind", "input"]);
    if (
      new TextEncoder().encode(extensionCanonicalJson(parsed.input)).length >
      16 * 1024
    )
      throw new ApplicationError("validation", "extension_task_input_invalid");
    return { kind: "generate", input: parsed.input as WorkflowSchemaValue };
  }
  if (value?.kind === "query") {
    const parsed = extensionCommand(input, [
      "kind",
      "sourceRunId",
      "operationId",
    ]);
    const operationId = extensionOpaqueId(parsed.operationId);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        operationId,
      )
    )
      throw new ApplicationError(
        "validation",
        "extension_task_operation_invalid",
      );
    return {
      kind: "query",
      sourceRunId: extensionOpaqueId(parsed.sourceRunId),
      operationId,
    };
  }
  throw new ApplicationError("validation", "extension_task_intent_invalid");
}
