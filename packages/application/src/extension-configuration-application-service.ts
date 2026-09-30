import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  extensionOpaqueId,
  extensionRevision,
  parseExtensionActivation,
  parseExtensionExecutionTarget,
  validateExtensionConfiguration,
  type ExtensionActivation,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import type {
  ApplicationClock,
  ContentDigester,
} from "./application-runtime-ports.ts";
import type {
  ExtensionCatalogPort,
  ExtensionHostPort,
} from "./extension-host-port.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import {
  authorizeExtension,
  extensionActor,
  extensionCommand,
  extensionScopeFor,
  extensionUseCase,
  requireExtensionRegistration,
} from "./extension-application-support.ts";

export type SaveExtensionConfigurationCommand = Readonly<{
  pluginId: string;
  pluginVersion: string;
  expectedRevision: number;
  idempotencyKey: string;
  parameters: ExtensionConfiguration["parameters"];
  credentialBindings: ExtensionConfiguration["credentialBindings"];
}>;
export type SetExtensionActivationCommand = Readonly<{
  pluginId: string;
  configurationRevision: number;
  expectedRevision: number;
  idempotencyKey: string;
  state: ExtensionActivation["state"];
  agentVersionId: string | null;
}>;

type Dependencies = Readonly<{
  store: ExtensionStore;
  catalog: ExtensionCatalogPort;
  host: ExtensionHostPort;
  authorization: AuthorizationPort;
  clock: ApplicationClock;
  digester: ContentDigester;
}>;

/** Space-scoped opt-in configuration; never changes the default Agent or an existing Run. */
export class ExtensionConfigurationApplicationService {
  readonly #dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async getConfiguration(
    actorInput: ActorContext,
    input: { pluginId: string; revision: number | null },
  ) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
      const command = extensionCommand(input, ["pluginId", "revision"]);
      const scope = extensionScopeFor(actor, command.pluginId as string);
      if (command.revision !== null) extensionRevision(command.revision);
      await authorizeExtension(
        this.#dependencies.authorization,
        actor,
        "extension:read",
        scope,
      );
      return command.revision === null
        ? this.#dependencies.store.loadLatestExtensionConfiguration(scope)
        : this.#dependencies.store.loadExtensionConfiguration({
            ...scope,
            revision: command.revision as number,
          });
    });
  }

  async getActivation(actorInput: ActorContext, pluginId: string) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
      const scope = extensionScopeFor(actor, pluginId);
      await authorizeExtension(
        this.#dependencies.authorization,
        actor,
        "extension:read",
        scope,
      );
      return this.#dependencies.store.loadExtensionActivation(scope);
    });
  }

  async saveConfiguration(
    actorInput: ActorContext,
    input: SaveExtensionConfigurationCommand,
  ) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
      const value = extensionCommand(input, [
        "pluginId",
        "pluginVersion",
        "expectedRevision",
        "idempotencyKey",
        "parameters",
        "credentialBindings",
      ]) as unknown as SaveExtensionConfigurationCommand;
      const scope = extensionScopeFor(actor, value.pluginId);
      extensionRevision(value.expectedRevision, { minimum: 0 });
      extensionOpaqueId(value.idempotencyKey);
      await authorizeExtension(
        this.#dependencies.authorization,
        actor,
        "extension:configure",
        scope,
      );
      // Use the record parser to bound parameters/references and canonicalize slot ordering.
      // Placeholder digests/time are never persisted or included in the request fingerprint.
      const parsed = createExtensionConfiguration(
        {
          schemaVersion: "crewon.extension-configuration.v0",
          ...scope,
          revision: value.expectedRevision + 1,
          pluginVersion: value.pluginVersion,
          parameters: value.parameters,
          credentialBindings: value.credentialBindings,
          manifestDigest: placeholderDigest,
          implementationDigest: placeholderDigest,
          createdByActorId: actor.actorId,
          createdAt: "1970-01-01T00:00:00.000Z",
        },
        this.#dependencies.digester,
      );
      const command: SaveExtensionConfigurationCommand = {
        ...value,
        parameters: parsed.parameters,
        credentialBindings: parsed.credentialBindings,
      };
      const receipt = this.#receipt(actor, "configuration", command);
      const previous =
        await this.#dependencies.store.loadExtensionConfigurationReceipt({
          ...scope,
          receipt,
        });
      if (previous !== null)
        return { disposition: "replayed" as const, configuration: previous };
      const registration = requireExtensionRegistration(
        this.#dependencies.catalog,
        this.#dependencies.digester,
        command,
      );
      validateExtensionConfiguration(registration.manifest, parsed.parameters);
      if (
        parsed.credentialBindings.some(
          (binding) =>
            !registration.manifest.credentialSlots.some(
              (slot) => slot.id === binding.slotId,
            ),
        )
      )
        throw new ApplicationError(
          "validation",
          "extension_credential_slot_unknown",
        );
      const configuration = createExtensionConfiguration(
        {
          ...parsed,
          manifestDigest: registration.manifestDigest,
          implementationDigest: registration.implementationDigest,
          createdAt: this.#dependencies.clock.now(),
        },
        this.#dependencies.digester,
      );
      await this.#dependencies.host.validateConfiguration({
        actor,
        registration,
        configuration,
      });
      return this.#dependencies.store.saveExtensionConfiguration({
        configuration,
        expectedRevision: command.expectedRevision,
        receipt,
      });
    });
  }

  async setActivation(
    actorInput: ActorContext,
    input: SetExtensionActivationCommand,
  ) {
    return extensionUseCase(async () => {
      const actor = extensionActor(actorInput);
      const command = extensionCommand(input, [
        "pluginId",
        "configurationRevision",
        "expectedRevision",
        "idempotencyKey",
        "state",
        "agentVersionId",
      ]) as unknown as SetExtensionActivationCommand;
      const scope = extensionScopeFor(actor, command.pluginId);
      extensionRevision(command.expectedRevision, { minimum: 0 });
      extensionRevision(command.configurationRevision);
      extensionOpaqueId(command.idempotencyKey);
      if (!["enabled", "disabled", "revoked"].includes(command.state))
        throw new ApplicationError(
          "validation",
          "extension_activation_state_invalid",
        );
      if (command.state === "enabled")
        extensionOpaqueId(command.agentVersionId);
      else if (command.agentVersionId !== null)
        throw new ApplicationError(
          "validation",
          "extension_disabled_target_invalid",
        );
      await authorizeExtension(
        this.#dependencies.authorization,
        actor,
        "extension:activate",
        scope,
      );
      const receipt = this.#receipt(actor, "activation", command);
      const previous =
        await this.#dependencies.store.loadExtensionActivationReceipt({
          ...scope,
          receipt,
        });
      if (previous !== null)
        return { disposition: "replayed" as const, activation: previous };
      const configuration =
        await this.#dependencies.store.loadExtensionConfiguration({
          ...scope,
          revision: command.configurationRevision,
        });
      if (configuration === null)
        throw new ApplicationError(
          "notFound",
          "extension_configuration_not_found",
        );
      let target: ExtensionActivation["target"] = null;
      if (command.state === "enabled") {
        const registration = requireExtensionRegistration(
          this.#dependencies.catalog,
          this.#dependencies.digester,
          configuration,
        );
        if (
          registration.manifestDigest !== configuration.manifestDigest ||
          registration.implementationDigest !==
            configuration.implementationDigest
        )
          throw new ApplicationError(
            "conflict",
            "extension_implementation_unavailable",
          );
        if (
          registration.manifest.credentialSlots.some(
            (slot) =>
              !configuration.credentialBindings.some(
                (binding) => binding.slotId === slot.id,
              ),
          )
        )
          throw new ApplicationError(
            "conflict",
            "extension_credential_unavailable",
          );
        const readiness = await this.#dependencies.host.evaluate({
          actor,
          registration,
          configuration,
          agentVersionId: command.agentVersionId!,
        });
        if (readiness.outcome === "unavailable") {
          const code = readinessReasons.includes(readiness.reasonCode)
            ? readiness.reasonCode
            : "extension_runtime_unavailable";
          throw new ApplicationError("conflict", code);
        }
        if (readiness.outcome !== "ready")
          throw new ApplicationError(
            "conflict",
            "extension_runtime_unavailable",
          );
        try {
          target = parseExtensionExecutionTarget(readiness.target);
        } catch (error) {
          throw new ApplicationError(
            "internal",
            "extension_runtime_target_invalid",
            { cause: error },
          );
        }
        if (target.agentVersionId !== command.agentVersionId)
          throw new ApplicationError(
            "conflict",
            "extension_execution_target_mismatch",
          );
      }
      const activation = parseExtensionActivation({
        schemaVersion: "crewon.extension-activation.v0",
        ...scope,
        revision: command.expectedRevision + 1,
        configurationRevision: configuration.revision,
        configurationDigest: configuration.contentDigest,
        state: command.state,
        target,
        updatedByActorId: actor.actorId,
        updatedAt: this.#dependencies.clock.now(),
      });
      return this.#dependencies.store.saveExtensionActivation({
        activation,
        expectedRevision: command.expectedRevision,
        receipt,
      });
    });
  }

  #receipt(
    actor: ActorContext,
    kind: "configuration" | "activation",
    command: { idempotencyKey: string },
  ) {
    return {
      actorId: actor.actorId,
      idempotencyKey: command.idempotencyKey,
      requestDigest: this.#dependencies.digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.extension-command.v0",
          kind,
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          actorId: actor.actorId,
          command,
        }),
      ),
    };
  }
}

const placeholderDigest = `sha256:${"0".repeat(64)}`;
const readinessReasons = [
  "extension_runtime_unavailable",
  "extension_implementation_unavailable",
  "extension_credential_unavailable",
  "extension_execution_authority_unsupported",
];
