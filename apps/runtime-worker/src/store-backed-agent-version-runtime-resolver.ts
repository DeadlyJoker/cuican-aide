import { parseAgentVersionAsset } from "@crewon/agent-version";
import type { AgentVersionStore, ContentDigester } from "@crewon/application";

import {
  AgentVersionRuntimeError,
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
  type AgentVersionRuntimeLocator,
  type AgentVersionRuntimeResolverPort,
} from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import type {
  PriorModelCompactionResolverPort,
  PriorModelCompactionRuntime,
} from "./model-switch-compaction.ts";

/** Lazily verifies and materializes the immutable runtime pinned by each claimed Run. */
export class StoreBackedAgentVersionRuntimeResolver
  implements AgentVersionRuntimeResolverPort
{
  readonly #store: AgentVersionStore;
  readonly #digester: ContentDigester;
  readonly #factory: AgentVersionRuntimeFactoryPort;
  readonly #registry: InMemoryAgentVersionRuntimeRegistry;
  readonly #inflight = new Map<string, Promise<AgentVersionRuntime | null>>();

  constructor(dependencies: {
    store: AgentVersionStore;
    digester: ContentDigester;
    factory: AgentVersionRuntimeFactoryPort;
    registry: InMemoryAgentVersionRuntimeRegistry;
  }) {
    this.#store = dependencies.store;
    this.#digester = dependencies.digester;
    this.#factory = dependencies.factory;
    this.#registry = dependencies.registry;
  }

  async resolve(
    locator: AgentVersionRuntimeLocator,
  ): Promise<AgentVersionRuntime | null> {
    const resident = this.#registry.resolve(locator);
    if (resident !== null) {
      return resident;
    }
    const key = JSON.stringify([locator.tenantId, locator.agentVersionId]);
    const active = this.#inflight.get(key);
    if (active !== undefined) {
      return active;
    }
    const loading = this.#load(locator).finally(() => {
      this.#inflight.delete(key);
    });
    this.#inflight.set(key, loading);
    return loading;
  }

  priorModelCompactionResolver(): PriorModelCompactionResolverPort {
    return new StoreBackedPriorModelCompactionResolver(this);
  }

  async #load(
    locator: AgentVersionRuntimeLocator,
  ): Promise<AgentVersionRuntime | null> {
    const asset = await this.#store.loadAgentVersion(locator);
    if (asset === null) {
      return null;
    }
    if (asset.tenantId !== locator.tenantId) {
      throw new AgentVersionRuntimeError("agent_version_store_scope_mismatch");
    }
    const version = parseAgentVersionAsset(asset, this.#digester);
    const runtime = await this.#factory.create({
      tenantId: locator.tenantId,
      version,
    });
    if (
      runtime.version.agentVersionId !== version.agentVersionId ||
      runtime.version.contentDigest !== version.contentDigest
    ) {
      await runtime.close?.();
      throw new AgentVersionRuntimeError(
        "agent_version_runtime_factory_mismatch",
      );
    }
    let disposition: "registered" | "existing";
    try {
      disposition = this.#registry.register({
        tenantId: locator.tenantId,
        runtime,
      }).disposition;
    } catch (error) {
      await runtime.close?.();
      throw error;
    }
    if (disposition === "existing") {
      await runtime.close?.();
    }
    return this.#registry.resolve(locator);
  }
}

class StoreBackedPriorModelCompactionResolver
  implements PriorModelCompactionResolverPort
{
  readonly #resolver: AgentVersionRuntimeResolverPort;

  constructor(resolver: AgentVersionRuntimeResolverPort) {
    this.#resolver = resolver;
  }

  async resolve(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<PriorModelCompactionRuntime | null> {
    const runtime = await this.#resolver.resolve({
      tenantId: input.tenantId,
      agentVersionId: input.agentVersionId,
    });
    return runtime === null
      ? null
      : {
          compactor: runtime.contextCompactor,
          ...(runtime.governedContext === undefined
            ? {}
            : { governedContext: runtime.governedContext }),
        };
  }
}
