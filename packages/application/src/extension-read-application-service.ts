import {
  extensionCanonicalJson,
  extensionOpaqueId,
  extensionRevision,
  parseExtensionConfiguration,
  parseExtensionActivation,
  parseExtensionExecutionTarget,
  parseExtensionRunBinding,
  type ExtensionConfiguration,
  type ExtensionRunBinding,
  type RunState,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type {
  ExtensionCatalogPort,
  ExtensionHostPort,
  ExtensionReadiness,
} from "./extension-host-port.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import type {
  ExternalOperationQueryStore,
  ExternalOperationStore,
} from "./external-operation-store-port.ts";
import type { RunStore } from "./run-store-port.ts";
import type { AgentVersionStore } from "./agent-version-store-port.ts";
import type { AgentVersionDeploymentStore } from "./agent-version-deployment-store-port.ts";
import {
  authorizeExtension,
  extensionActor,
  extensionCommand,
  extensionScopeFor,
  extensionUseCase,
  requireExtensionRegistration,
} from "./extension-application-support.ts";

type Dependencies = Readonly<{
  runs: Pick<RunStore, "loadRunInSpace">;
  agentVersions: Pick<AgentVersionStore, "loadAgentVersion"> &
    AgentVersionDeploymentStore;
  extensions: ExtensionStore;
  operations: ExternalOperationQueryStore &
    Pick<ExternalOperationStore, "loadExternalOperation">;
  catalog: ExtensionCatalogPort;
  host: ExtensionHostPort;
  authorization: AuthorizationPort;
  digester: ContentDigester;
}>;

/** Read-only projections use the current principal and durable ownership; never poll the provider. */
export class ExtensionReadApplicationService {
  readonly #dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async getCatalog(actorInput: ActorContext) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
      await this.#dependencies.catalog.prepare?.({
        actor,
        request: { kind: "catalog" },
      });
      const entries = this.#dependencies.catalog.list();
      if (entries.length > 32)
        throw new ApplicationError("internal", "extension_catalog_invalid");
      const extensions = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const registration = requireExtensionRegistration(
          this.#dependencies.catalog,
          this.#dependencies.digester,
          {
            pluginId: entry.manifest.pluginId,
            pluginVersion: entry.manifest.version,
          },
        );
        const manifest = registration.manifest;
        const identity = `${manifest.pluginId}@${manifest.version}`;
        if (seen.has(identity))
          throw new ApplicationError("internal", "extension_catalog_invalid");
        seen.add(identity);
        await authorizeExtension(
          this.#dependencies.authorization,
          actor,
          "extension:read",
          extensionScopeFor(actor, manifest.pluginId),
        );
        extensions.push({
          pluginId: manifest.pluginId,
          pluginVersion: manifest.version,
          title: manifest.title,
          description: manifest.description,
          inputSchema: manifest.task.inputSchema,
          configurationSchema: manifest.configurationSchema,
          credentialSlots: manifest.credentialSlots,
          resultViews: manifest.resultViews,
        });
      }
      // An awaited authorization call for a later entry must not preserve an earlier revoked grant.
      for (const entry of extensions)
        await authorizeExtension(
          this.#dependencies.authorization,
          actor,
          "extension:read",
          extensionScopeFor(actor, entry.pluginId),
        );
      return { extensions };
    });
  }

  async getRuntime(
    actorInput: ActorContext,
    input: {
      pluginId: string;
      agentVersionId: string;
      configurationRevision: number;
    },
  ) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
      const command = extensionCommand(input, [
        "pluginId",
        "agentVersionId",
        "configurationRevision",
      ]);
      const scope = extensionScopeFor(actor, command.pluginId as string);
      const agentVersionId = extensionOpaqueId(command.agentVersionId);
      const configurationRevision = extensionRevision(
        command.configurationRevision,
      );
      const authorize = async () => {
        await authorizeExtension(
          this.#dependencies.authorization,
          actor,
          "extension:read",
          scope,
        );
        const decision = await this.#dependencies.authorization.authorize({
          actor,
          action: "agentVersion:read",
          resource: {
            kind: "agentVersion",
            tenantId: actor.tenantId,
            spaceId: actor.spaceId,
            agentVersionId,
          },
        });
        if (decision.outcome !== "allow")
          throw new ApplicationError("authorization", "authorization_denied");
      };
      await authorize();
      const configuration = await this.#configuration(
        actor,
        scope.pluginId,
        configurationRevision,
      );
      await this.#dependencies.catalog.prepare?.({
        actor,
        request: {
          kind: "registration",
          pluginId: configuration.pluginId,
          pluginVersion: configuration.pluginVersion,
        },
      });
      const registration = requireExtensionRegistration(
        this.#dependencies.catalog,
        this.#dependencies.digester,
        configuration,
      );
      let readiness: ExtensionReadiness;
      if (
        registration.manifestDigest !== configuration.manifestDigest ||
        registration.implementationDigest !== configuration.implementationDigest
      ) {
        readiness = {
          outcome: "unavailable",
          reasonCode: "extension_implementation_unavailable",
        };
      } else {
        const result = await this.#dependencies.host.evaluate({
          actor,
          registration,
          configuration,
          agentVersionId,
        });
        if (result.outcome === "ready") {
          const target = parseExtensionExecutionTarget(result.target);
          if (target.agentVersionId !== agentVersionId)
            throw new ApplicationError(
              "internal",
              "extension_runtime_target_invalid",
            );
          readiness = (await this.#controlDeploymentMatches(actor, target))
            ? { outcome: "ready", target }
            : {
                outcome: "unavailable",
                reasonCode: "extension_runtime_unavailable",
              };
        } else if (
          result.outcome === "unavailable" &&
          [
            "extension_runtime_unavailable",
            "extension_implementation_unavailable",
            "extension_credential_unavailable",
            "extension_execution_authority_unsupported",
          ].includes(result.reasonCode)
        ) {
          readiness = { outcome: "unavailable", reasonCode: result.reasonCode };
        } else
          throw new ApplicationError(
            "internal",
            "extension_runtime_target_invalid",
          );
      }
      await authorize();
      return {
        pluginId: scope.pluginId,
        agentVersionId,
        configurationRevision,
        readiness,
      };
    });
  }

  async getTask(
    actorInput: ActorContext,
    input: { pluginId: string; runId: string },
  ) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
      const command = extensionCommand(input, ["pluginId", "runId"]);
      const scope = extensionScopeFor(actor, command.pluginId as string);
      const runId = extensionOpaqueId(command.runId);
      await authorizeExtension(
        this.#dependencies.authorization,
        actor,
        "extension:query",
        scope,
      );
      const current = await this.#boundRun(actor, scope.pluginId, runId);
      await this.#authorizeRun(actor, current.run);
      let owner = current;
      if (current.binding.source !== null) {
        owner = await this.#boundRun(
          actor,
          scope.pluginId,
          current.binding.source.runId,
        );
        await this.#authorizeRun(actor, owner.run);
        if (
          owner.binding.source !== null ||
          owner.binding.bindingDigest !==
            current.binding.source.bindingDigest ||
          owner.binding.configurationDigest !==
            current.binding.configurationDigest ||
          extensionCanonicalJson(owner.binding.target) !==
            extensionCanonicalJson(current.binding.target)
        ) {
          throw new ApplicationError(
            "internal",
            "extension_query_source_invalid",
          );
        }
      }
      await this.#assertReadable(actor, scope.pluginId);
      const configuration = await this.#configuration(
        actor,
        scope.pluginId,
        owner.binding.configurationRevision,
      );
      if (configuration.contentDigest !== owner.binding.configurationDigest)
        throw new ApplicationError(
          "internal",
          "extension_configuration_mismatch",
        );
      const locator = {
        tenantId: actor.tenantId,
        runId: owner.run.runId,
        bindingDigest: owner.binding.bindingDigest,
      };
      const page =
        current.binding.source === null
          ? await this.#dependencies.operations.listExternalOperations({
              ...locator,
              limit: 16,
            })
          : {
              operations: [
                await this.#dependencies.operations.loadExternalOperation({
                  ...locator,
                  operationId: current.binding.source.operationId,
                }),
              ].filter((value) => value !== null),
              truncated: false,
            };
      if (
        page.operations.length > 16 ||
        typeof page.truncated !== "boolean" ||
        page.operations.some(
          (operation) =>
            operation.tenantId !== locator.tenantId ||
            operation.runId !== locator.runId ||
            operation.bindingDigest !== locator.bindingDigest ||
            (current.binding.source !== null &&
              operation.operationId !== current.binding.source.operationId),
        )
      ) {
        throw new ApplicationError(
          "internal",
          "external_operation_identity_conflict",
        );
      }
      if (current.binding.source !== null && page.operations.length !== 1)
        throw new ApplicationError(
          "notFound",
          "extension_query_source_not_found",
        );
      await this.#assertReadable(actor, scope.pluginId);
      await this.#authorizeRun(actor, current.run);
      if (owner !== current) await this.#authorizeRun(actor, owner.run);
      await authorizeExtension(
        this.#dependencies.authorization,
        actor,
        "extension:query",
        scope,
      );
      await this.#assertReadable(actor, scope.pluginId);
      return {
        run: current.run,
        binding: current.binding,
        configuration,
        operations: page.operations,
        truncated: page.truncated,
      };
    });
  }

  async #configuration(
    actor: ActorContext,
    pluginId: string,
    revision: number,
  ): Promise<ExtensionConfiguration> {
    const value =
      await this.#dependencies.extensions.loadExtensionConfiguration({
        ...extensionScopeFor(actor, pluginId),
        revision,
      });
    if (value === null)
      throw new ApplicationError(
        "notFound",
        "extension_configuration_not_found",
      );
    const parsed = parseExtensionConfiguration(
      value,
      this.#dependencies.digester,
    );
    if (
      parsed.tenantId !== actor.tenantId ||
      parsed.spaceId !== actor.spaceId ||
      parsed.pluginId !== pluginId ||
      parsed.revision !== revision
    )
      throw new ApplicationError(
        "internal",
        "extension_configuration_mismatch",
      );
    return parsed;
  }

  async #boundRun(
    actor: ActorContext,
    pluginId: string,
    runId: string,
  ): Promise<{ run: RunState; binding: ExtensionRunBinding }> {
    const run = await this.#dependencies.runs.loadRunInSpace({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId,
    });
    if (run === null)
      throw new ApplicationError("notFound", "extension_task_not_found");
    const value = await this.#dependencies.extensions.loadExtensionRunBinding({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId,
    });
    if (value === null)
      throw new ApplicationError("notFound", "extension_task_not_found");
    const binding = parseExtensionRunBinding(
      value,
      this.#dependencies.digester,
    );
    if (binding.pluginId !== pluginId)
      throw new ApplicationError("notFound", "extension_task_not_found");
    if (
      run.tenantId !== actor.tenantId ||
      run.spaceId !== actor.spaceId ||
      run.runId !== runId ||
      binding.tenantId !== actor.tenantId ||
      binding.spaceId !== actor.spaceId ||
      binding.runId !== runId ||
      binding.actorId !== run.createdByActorId ||
      binding.threadId !== run.threadId ||
      [
        "agentVersionId",
        "authorityId",
        "runtimeGeneration",
        "policySnapshotId",
        "workspaceBindingId",
      ].some(
        (key) =>
          binding.target[key as keyof typeof binding.target] !==
          run[key as keyof RunState],
      )
    )
      throw new ApplicationError("internal", "extension_run_binding_mismatch");
    return { run, binding };
  }

  async #assertReadable(actor: ActorContext, pluginId: string) {
    const value = await this.#dependencies.extensions.loadExtensionActivation(
      extensionScopeFor(actor, pluginId),
    );
    if (value === null)
      throw new ApplicationError("authorization", "extension_access_revoked");
    const activation = parseExtensionActivation(value);
    if (
      activation.tenantId !== actor.tenantId ||
      activation.spaceId !== actor.spaceId ||
      activation.pluginId !== pluginId
    )
      throw new ApplicationError(
        "internal",
        "extension_activation_scope_mismatch",
      );
    if (activation.state === "revoked")
      throw new ApplicationError("authorization", "extension_access_revoked");
  }

  async #controlDeploymentMatches(
    actor: ActorContext,
    target: ReturnType<typeof parseExtensionExecutionTarget>,
  ): Promise<boolean> {
    const locator = {
      tenantId: actor.tenantId,
      agentVersionId: target.agentVersionId,
    };
    const [asset, deployment] = await Promise.all([
      this.#dependencies.agentVersions.loadAgentVersion(locator),
      this.#dependencies.agentVersions.loadAgentVersionDeployment(locator),
    ]);
    if (asset === null || deployment === null) return false;
    if (
      asset.tenantId !== actor.tenantId ||
      deployment.tenantId !== actor.tenantId ||
      asset.agentVersionId !== target.agentVersionId ||
      deployment.agentVersionId !== target.agentVersionId ||
      asset.contentDigest !== target.agentVersionContentDigest ||
      deployment.contentDigest !== target.agentVersionContentDigest ||
      deployment.materializationDigest !== target.materializationDigest ||
      deployment.authorityId !== target.authorityId ||
      deployment.workspaceBindingId !== target.workspaceBindingId
    )
      return false;
    if (
      typeof asset.definitionJson !== "string" ||
      new TextEncoder().encode(asset.definitionJson).length > 1024 * 1024
    )
      return false;
    try {
      const definition = JSON.parse(asset.definitionJson) as Record<
        string,
        unknown
      > | null;
      return (
        definition !== null &&
        typeof definition === "object" &&
        !Array.isArray(definition) &&
        definition.agentVersionId === target.agentVersionId &&
        definition.runtimeGeneration === target.runtimeGeneration &&
        definition.policySnapshotId === target.policySnapshotId
      );
    } catch {
      return false;
    }
  }

  async #authorizeRun(actor: ActorContext, run: RunState) {
    const decision = await this.#dependencies.authorization.authorize({
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
    if (decision.outcome !== "allow")
      throw new ApplicationError("authorization", "authorization_denied");
  }
}
