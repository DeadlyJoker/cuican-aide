import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { AgentVersionDeploymentCandidate } from "@crewon/application";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import type { AgentVersionRuntime } from "../agent-version-runtime.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "../configured-agent-version-runtime-factory.ts";
import type { AgentVersionRuntimeFactoryPort } from "../durable-agent-version-runtime-loader.ts";
import { parseCompiledAgentVersion } from "@crewon/agent-version";
import { ioJson } from "./plugin-execution-io-network.ts";
import {
  installedPluginReleaseDigester,
  installedPluginReleaseFailure,
  parseInstalledPluginReleaseDeployment,
} from "./installed-plugin-release-document.ts";
import { InstalledPluginReleaseLifetime } from "./installed-plugin-release-lifetime.ts";
import { installedPluginAgentRuntimeFailureOwner } from "./installed-plugin-agent-runtime-factory.ts";

type Creation = Parameters<AgentVersionRuntimeFactoryPort["create"]>[0];
export type InstalledPluginReleaseRuntimeFactory =
  AgentVersionRuntimeFactoryPort &
    Readonly<{
      deploymentBindings(
        tenantId: string,
      ): readonly AgentVersionDeploymentCandidate[];
    }>;

/** A publication check precedes every new allocation; unknown versions never use another factory. */
export function guardInstalledPluginReleaseFactory(input: {
  factory: ConfiguredAgentVersionRuntimeFactory;
  lifetime: InstalledPluginReleaseLifetime;
  verifyCreation(input: Creation, signal: AbortSignal): Promise<void>;
}): ConfiguredAgentVersionRuntimeFactory {
  return new GuardedFactory(
    input.factory,
    input.verifyCreation,
    input.lifetime,
  );
}

class GuardedFactory extends ConfiguredAgentVersionRuntimeFactory {
  readonly #factory: ConfiguredAgentVersionRuntimeFactory;
  readonly #verify: (input: Creation, signal: AbortSignal) => Promise<void>;
  readonly #lifetime: InstalledPluginReleaseLifetime;
  constructor(
    factory: ConfiguredAgentVersionRuntimeFactory,
    verify: (input: Creation, signal: AbortSignal) => Promise<void>,
    lifetime: InstalledPluginReleaseLifetime,
  ) {
    super([]);
    this.#factory = factory;
    this.#verify = verify;
    this.#lifetime = lifetime;
  }
  override deploymentBindings(tenantId: string) {
    return this.#factory.deploymentBindings(tenantId);
  }
  override create(input: Creation): Promise<AgentVersionRuntime> {
    const captured = capture(input);
    return this.#create(captured, (input) => this.#factory.create(input));
  }
  override bindSharedToolRuntime(
    runtime: ToolRuntimePort,
  ): AgentVersionRuntimeFactoryPort {
    const actual = this.#factory.bindSharedToolRuntime(runtime);
    return {
      ...actual,
      create: (input) => {
        const captured = capture(input);
        return this.#create(captured, (input) => actual.create(input));
      },
    };
  }

  #create(
    input: Creation,
    create: (
      input: Creation,
    ) => AgentVersionRuntime | Promise<AgentVersionRuntime>,
  ): Promise<AgentVersionRuntime> {
    let creatorStarted = false;
    try {
      const task = this.#lifetime.run(async (signal) => {
        await this.#verify(input, signal);
        this.#lifetime.assertLive();
        signal.throwIfAborted();
        // Once the delegate begins, its actual resource must reach the caller even after shutdown.
        creatorStarted = true;
        return create(input);
      });
      return task.catch((error: unknown) => {
        if (!creatorStarted) input.failedCreationCleanup?.confirmReleased();
        else {
          const failedOwner = installedPluginAgentRuntimeFailureOwner(error);
          if (failedOwner !== null)
            this.#lifetime.retainFailedOwner(failedOwner);
        }
        throw error;
      });
    } catch (error) {
      input.failedCreationCleanup?.confirmReleased();
      throw error;
    }
  }
}

function capture(input: Creation): Creation {
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const name of ["tenantId", "version", "failedCreationCleanup"]) {
    const field = fields[name];
    if (
      (name !== "failedCreationCleanup" && field === undefined) ||
      (field !== undefined && (!field.enumerable || !("value" in field)))
    )
      installedPluginReleaseFailure("creation_invalid");
  }
  const cleanup = fields.failedCreationCleanup
    ?.value as Creation["failedCreationCleanup"];
  // Preserve the private cleanup reservation; copy own version data before asynchronous verification.
  return Object.freeze({
    tenantId: fields.tenantId!.value as string,
    version: parseCompiledAgentVersion(
      JSON.stringify(ioJson(fields.version!.value, 1024 * 1024)),
      installedPluginReleaseDigester,
    ),
    ...(cleanup === undefined ? {} : { failedCreationCleanup: cleanup }),
  });
}

type FactorySource = Readonly<{
  factory: AgentVersionRuntimeFactoryPort;
  deployments: readonly AgentVersionDeploymentCandidate[];
}>;
function key(tenantId: string, agentVersionId: string): string {
  return JSON.stringify([tenantId, agentVersionId]);
}

/** Host-only exact dispatch for installed and unchanged legacy/provider bindings. */
export function composeInstalledPluginReleaseFactories(
  input: Readonly<{
    installed: FactorySource;
    base?: FactorySource;
  }>,
): InstalledPluginReleaseRuntimeFactory {
  const sources = [
    input.installed,
    ...(input.base === undefined ? [] : [input.base]),
  ].map((source) =>
    Object.freeze({
      factory: snapshotFactory(source.factory),
      deployments: Object.freeze(
        source.deployments.map((deployment) =>
          parseInstalledPluginReleaseDeployment(ioJson(deployment, 16_384)),
        ),
      ),
    }),
  );
  const owners = new Map<string, FactorySource>();
  for (const source of sources) {
    for (const deployment of source.deployments) {
      const identity = key(deployment.tenantId, deployment.agentVersionId);
      if (owners.has(identity))
        installedPluginReleaseFailure("factory_conflict");
      owners.set(identity, source);
    }
  }
  const select = (input: {
    tenantId: string;
    version: CompiledAgentVersion;
  }): FactorySource => {
    const selected = owners.get(
      key(input.tenantId, input.version.agentVersionId),
    );
    if (selected === undefined)
      installedPluginReleaseFailure("factory_missing");
    const expected = selected.deployments.find(
      (entry) =>
        entry.tenantId === input.tenantId &&
        entry.agentVersionId === input.version.agentVersionId,
    )!;
    if (expected.contentDigest !== input.version.contentDigest)
      installedPluginReleaseFailure("factory_version_mismatch");
    return selected;
  };
  const compose = (
    bound: ReadonlyMap<FactorySource, AgentVersionRuntimeFactoryPort>,
  ): AgentVersionRuntimeFactoryPort => {
    const factories = [...bound.values()];
    const shared = factories.flatMap((factory) =>
      factory.sharedResourceOwner === undefined
        ? []
        : [factory.sharedResourceOwner],
    );
    if (shared.some((owner) => owner !== shared[0]))
      installedPluginReleaseFailure("shared_owner_conflict");
    return {
      ...(shared.length === 0 ? {} : { sharedResourceOwner: shared[0] }),
      runtimeOwnership(input) {
        const factory = bound.get(select(input))!;
        return (
          factory.runtimeOwnership?.(input) ??
          (factory.sharedResourceOwner === undefined
            ? "ownedRuntime"
            : "sharedProjection")
        );
      },
      create(input) {
        const captured = capture(input);
        let selected: AgentVersionRuntimeFactoryPort;
        try {
          selected = bound.get(select(captured))!;
        } catch (error) {
          captured.failedCreationCleanup?.confirmReleased();
          throw error;
        }
        return selected.create(captured);
      },
    };
  };
  const unbound = new Map(sources.map((source) => [source, source.factory]));
  return Object.freeze({
    ...compose(unbound),
    deploymentBindings: (tenantId: string) =>
      sources.flatMap((source) =>
        source.deployments
          .filter((entry) => entry.tenantId === tenantId)
          .map((entry) => structuredClone(entry)),
      ),
    bindSharedToolRuntime(runtime: ToolRuntimePort) {
      return compose(
        new Map(
          sources.map((source) => [
            source,
            source.factory.bindSharedToolRuntime?.(runtime) ?? source.factory,
          ]),
        ),
      );
    },
  });
}

function snapshotFactory(
  factory: AgentVersionRuntimeFactoryPort,
): AgentVersionRuntimeFactoryPort {
  return Object.freeze({
    create: factory.create.bind(factory),
    ...(factory.runtimeOwnership === undefined
      ? {}
      : { runtimeOwnership: factory.runtimeOwnership.bind(factory) }),
    ...(factory.bindSharedToolRuntime === undefined
      ? {}
      : { bindSharedToolRuntime: factory.bindSharedToolRuntime.bind(factory) }),
    ...(factory.sharedResourceOwner === undefined
      ? {}
      : { sharedResourceOwner: factory.sharedResourceOwner }),
  });
}
