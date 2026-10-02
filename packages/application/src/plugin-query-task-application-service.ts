import {
  assertPluginQueryTaskAdmission,
  createExtensionRunBinding,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionActivation,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginQueryTaskAdmission,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  authorizeExtension,
  extensionCommand,
  extensionScopeFor,
  extensionUseCase,
  requirePinnedExtensionRegistration,
} from "./extension-application-support.ts";
import {
  checkedPluginTaskPin,
  pluginTaskActor,
  capturePluginTaskCommitAuthority,
  type PluginTaskCommitAuthorityPort,
} from "./extension-plugin-task-support.ts";
import type {
  CreateExtensionTaskCommand,
  ExtensionTaskApplicationDependencies,
} from "./extension-task-application-service.ts";
import { TurnApplicationService } from "./turn-application-service.ts";
import {
  loadPluginQuerySource,
  type PluginQueryHostPort,
} from "./plugin-query-source.ts";
import {
  assertSavedPluginQueryTask,
  pluginQueryTaskReceipt,
} from "./plugin-query-task-support.ts";

export class PluginQueryTaskApplicationService {
  readonly #dependencies: ExtensionTaskApplicationDependencies;
  readonly #turns: TurnApplicationService;
  constructor(dependencies: ExtensionTaskApplicationDependencies) {
    this.#dependencies = dependencies;
    this.#turns = new TurnApplicationService(dependencies);
  }
  async create(
    actorInput: ActorContext,
    input: CreateExtensionTaskCommand,
    pinInput: PluginTaskAdmissionPin,
    authorityInput?: PluginTaskCommitAuthorityPort,
  ) {
    return extensionUseCase(async () => {
      const pin = checkedPluginTaskPin(pinInput),
        actor = pluginTaskActor(actorInput, pin);
      const authority = capturePluginTaskCommitAuthority(authorityInput);
      const value = extensionCommand(input, [
        "pluginId",
        "threadId",
        "expectedThreadRevision",
        "idempotencyKey",
        "intent",
      ]);
      const scope = extensionScopeFor(actor, value.pluginId as string);
      const intent = extensionCommand(value.intent, [
        "kind",
        "sourceRunId",
        "operationId",
      ]);
      const sourceRunId = extensionOpaqueId(intent.sourceRunId),
        operationId = extensionOpaqueId(intent.operationId);
      if (
        intent.kind !== "query" ||
        pin.pluginId !== scope.pluginId ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
          operationId,
        ) ||
        typeof value.expectedThreadRevision !== "number" ||
        !Number.isSafeInteger(value.expectedThreadRevision) ||
        value.expectedThreadRevision < 1
      )
        throw new ApplicationError(
          "validation",
          "plugin_query_command_invalid",
        );
      const command: CreateExtensionTaskCommand = Object.freeze({
        pluginId: scope.pluginId,
        threadId: extensionOpaqueId(value.threadId),
        expectedThreadRevision: value.expectedThreadRevision,
        idempotencyKey: extensionOpaqueId(value.idempotencyKey),
        intent: Object.freeze({ kind: "query", sourceRunId, operationId }),
      });
      const d = this.#dependencies,
        host: PluginQueryHostPort | undefined = d.pluginQueryHost;
      if (
        d.extensions.pluginQueryAdmissionVersion !==
          "crewon.plugin-query-task-admission.v1" ||
        typeof d.extensions.loadPluginQueryTaskAdmission !== "function" ||
        host === undefined
      )
        throw new ApplicationError(
          "conflict",
          "plugin_query_admission_unavailable",
        );
      const authorize = () =>
        authorizeExtension(d.authorization, actor, "extension:query", scope);
      await authorize();
      await this.#authorizeThread(actor, command.threadId);
      const sourceInput = {
        actor,
        pluginId: pin.pluginId,
        profileId: pin.profileId,
        publisherId: pin.publisherId,
        sourceRunId,
        operationId,
        extensions: d.extensions,
        runs: d.store,
        operations: d.operations,
        authorization: d.authorization,
        digester: d.digester,
      };
      const source = await loadPluginQuerySource(sourceInput);
      const receipt = pluginQueryTaskReceipt(
        actor,
        command,
        pin,
        source,
        d.digester,
      );
      const previous = await d.extensions.loadExtensionTurnReceipt({
        ...scope,
        receipt,
      });
      if (previous !== null) {
        await assertSavedPluginQueryTask({
          store: d.extensions,
          pin,
          source,
          binding: previous.binding,
          receipt,
          digester: d.digester,
        });
        await authorize();
        await this.#authorizeThread(actor, command.threadId);
        await authority?.assertCurrent({ actor, pin });
        return previous;
      }
      const activationRaw = await d.extensions.loadExtensionActivation(scope);
      if (activationRaw === null)
        throw new ApplicationError("authorization", "extension_access_revoked");
      const activation = parseExtensionActivation(activationRaw);
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
      const rawConfig = await d.extensions.loadExtensionConfiguration({
        ...scope,
        revision: source.binding.configurationRevision,
      });
      if (rawConfig === null)
        throw new ApplicationError(
          "notFound",
          "extension_configuration_not_found",
        );
      const configuration = parseExtensionConfiguration(rawConfig, d.digester);
      if (
        configuration.tenantId !== scope.tenantId ||
        configuration.spaceId !== scope.spaceId ||
        configuration.pluginId !== scope.pluginId ||
        configuration.revision !== source.binding.configurationRevision ||
        configuration.contentDigest !== source.binding.configurationDigest ||
        configuration.pluginVersion !== source.admission.version
      )
        throw new ApplicationError(
          "conflict",
          "extension_configuration_mismatch",
        );
      const resolved = await host.resolveRegistration({ actor, source });
      if (resolved === null)
        throw new ApplicationError(
          "conflict",
          "extension_implementation_unavailable",
        );
      const registration = requirePinnedExtensionRegistration(
        resolved,
        d.digester,
        configuration,
      );
      const target = source.binding.target;
      const readiness = await host.evaluate({
        actor,
        source,
        registration,
        configuration,
        expectedTarget: target,
      });
      if (readiness.outcome !== "ready")
        throw new ApplicationError("conflict", readiness.reasonCode);
      if (
        extensionCanonicalJson(
          parseExtensionExecutionTarget(readiness.target),
        ) !== extensionCanonicalJson(target)
      )
        throw new ApplicationError(
          "conflict",
          "extension_execution_target_mismatch",
        );
      const content = extensionCanonicalJson({ kind: "query", operationId });
      const turn = await this.#turns.prepareTurn(actor, {
        kind: "turn.start",
        threadId: command.threadId,
        expectedThreadRevision: command.expectedThreadRevision,
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
          threadId: command.threadId,
          runId: event.identity.runId,
          configurationRevision: configuration.revision,
          configurationDigest: configuration.contentDigest,
          target,
          inputDigest: d.digester.sha256(content),
          source: {
            runId: source.binding.runId,
            bindingDigest: source.binding.bindingDigest,
            operationId,
          },
        },
        d.digester,
      );
      const admission = assertPluginQueryTaskAdmission(
        {
          admission: parsePluginQueryTaskAdmission({
            schemaVersion: "crewon.plugin-query-task-admission.v1",
            ...pin,
            runId: binding.runId,
            threadId: binding.threadId,
            extensionBindingDigest: binding.bindingDigest,
            requestDigest: receipt.requestDigest,
            idempotencyKey: receipt.idempotencyKey,
            source: source.admission,
            operationId,
          }),
          binding,
          sourceBinding: source.binding,
          receipt,
        },
        d.digester,
      );
      const latest = await loadPluginQuerySource(sourceInput);
      if (extensionCanonicalJson(latest) !== extensionCanonicalJson(source))
        throw new ApplicationError("conflict", "plugin_query_source_changed");
      await authorize();
      await this.#authorizeThread(actor, command.threadId);
      await authority?.assertCurrent({ actor, pin });
      const result = await d.extensions.commitExtensionTurn({
        turn,
        binding,
        receipt,
        expectedActivationRevision: activation.revision,
        pluginQueryAdmission: admission,
      });
      if (result.creditAdmission !== undefined)
        throw new ApplicationError(
          "internal",
          "plugin_query_credit_unexpected",
        );
      await assertSavedPluginQueryTask({
        store: d.extensions,
        pin,
        source,
        binding: result.binding,
        receipt,
        digester: d.digester,
      });
      return result;
    });
  }
  async #authorizeThread(actor: ActorContext, threadId: string): Promise<void> {
    const requests = [
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
    ];
    for (const request of requests)
      if (
        (await this.#dependencies.authorization.authorize(request)).outcome !==
        "allow"
      )
        throw new ApplicationError("authorization", "authorization_denied");
  }
}
