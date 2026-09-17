import { parseAgentVersionAsset } from "@crewon/agent-version";
import type { AgentVersionStore, ContentDigester } from "@crewon/application";
import type { ToolRuntimePort } from "@crewon/tool-broker";

import {
  AgentVersionRuntimeError,
  validateAgentVersionRuntime,
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
  type AgentVersionRuntimeLocator,
  type AgentVersionRuntimeResolverPort,
} from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import {
  createAdmittedAgentRuntime,
  closeAdmittedAgentRuntime,
} from "./admitted-agent-runtime-creation.ts";
import type {
  PriorModelCompactionResolverPort,
  PriorModelCompactionRuntime,
} from "./model-switch-compaction.ts";

import { SharedAgentRuntimeCache } from "./shared-agent-runtime-cache.ts";
import {
  externalResourceLease,
  type RuntimeResourceLease,
} from "./runtime-resource-lease.ts";

/** Lazily verifies and materializes the immutable runtime pinned by each claimed Run. */
export class StoreBackedAgentVersionRuntimeResolver
  implements AgentVersionRuntimeResolverPort
{
  readonly #store: AgentVersionStore;
  readonly #digester: ContentDigester;
  readonly #factory: AgentVersionRuntimeFactoryPort;
  readonly #registry: InMemoryAgentVersionRuntimeRegistry;
  readonly #acquireSharedOwner:
    | (() => RuntimeResourceLease<ToolRuntimePort> | null)
    | undefined;
  readonly #sharedCache = new SharedAgentRuntimeCache();
  #closed = false;
  #sharedMaintenanceTurn = true;
  readonly #inflight = new Map<string, Promise<AgentVersionRuntime | null>>();

  constructor(dependencies: {
    store: AgentVersionStore;
    digester: ContentDigester;
    factory: AgentVersionRuntimeFactoryPort;
    registry: InMemoryAgentVersionRuntimeRegistry;
    /** The composition owns the shared transport/context/tools behind historical projections. */
    acquireSharedOwner?: () => RuntimeResourceLease<ToolRuntimePort> | null;
  }) {
    this.#store = dependencies.store;
    this.#digester = dependencies.digester;
    this.#factory = dependencies.factory;
    this.#registry = dependencies.registry;
    this.#acquireSharedOwner = dependencies.acquireSharedOwner;
  }

  async resolve(
    locator: AgentVersionRuntimeLocator,
  ): Promise<AgentVersionRuntime | null> {
    while (!this.#isClosed()) {
      const runtime = await this.#resolveUnpinned(locator);
      if (runtime === null || this.#isClosed()) return null;
      const pinned = this.#registry.resolve(locator);
      if (pinned !== null) return pinned;
      if (runtime.canRetire === undefined) return runtime;
      // Another borrower may have released and retired it before this continuation.
    }
    return null;
  }

  async #resolveUnpinned(
    locator: AgentVersionRuntimeLocator,
  ): Promise<AgentVersionRuntime | null> {
    if (this.#isClosed()) return null;
    const resident =
      this.#registry.peekResident(locator) ?? this.#sharedCache.get(locator);
    if (resident !== null) {
      return resident;
    }
    const key = JSON.stringify([locator.tenantId, locator.agentVersionId]);
    const active = this.#inflight.get(key);
    if (active !== undefined) {
      return active;
    }
    // Admit before retaining the key: denied requests must not accumulate a
    // transient map of failed loads when many callers arrive in one turn.
    const creation = this.#registry.capacity.beginCreation();
    const loading = this.#load(locator).finally(() => {
      this.#inflight.delete(key);
      creation.release();
    });
    this.#inflight.set(key, loading);
    return loading;
  }

  resolveResident(
    locator: AgentVersionRuntimeLocator,
  ): AgentVersionRuntime | null {
    if (this.#isClosed()) return null;
    return this.#registry.resolve(locator) ?? this.#sharedCache.get(locator);
  }

  acquireResident(
    locator: AgentVersionRuntimeLocator,
  ): RuntimeResourceLease<AgentVersionRuntime> | null {
    if (this.#isClosed()) return null;
    const owned = this.#registry.acquireResident(locator);
    if (owned !== null) return this.#withSharedOwner(owned);
    const shared = this.#sharedCache.get(locator);
    return shared === null
      ? null
      : this.#withSharedOwner(externalResourceLease(shared));
  }

  async acquire(
    locator: AgentVersionRuntimeLocator,
  ): Promise<RuntimeResourceLease<AgentVersionRuntime> | null> {
    while (!this.#isClosed()) {
      const resident = this.acquireResident(locator);
      if (resident !== null) return resident;
      const runtime = await this.#resolveUnpinned(locator);
      if (runtime === null || this.#isClosed()) return null;
      const owned = this.#registry.acquire(locator);
      if (owned !== null) return this.#withSharedOwner(owned);
      // Only an uncached resource-free projection can be borrowed without an owner.
      if (runtime.canRetire === undefined)
        return this.#withSharedOwner(externalResourceLease(runtime));
    }
    return null;
  }

  #withSharedOwner<T>(
    lease: RuntimeResourceLease<T>,
  ): RuntimeResourceLease<T> | null {
    if (this.#acquireSharedOwner === undefined) return lease;
    let shared: RuntimeResourceLease<ToolRuntimePort> | null;
    try {
      shared = this.#acquireSharedOwner();
    } catch (error) {
      lease.release();
      throw error;
    }
    if (shared === null) {
      lease.release();
      return null;
    }
    return {
      resource: lease.resource,
      release() {
        lease.release();
        shared.release();
      },
    };
  }

  sharedRuntimeCacheSnapshot() {
    return this.#sharedCache.snapshot();
  }

  close(): void {
    this.#closed = true;
    this.#sharedCache.clear();
  }

  #isClosed(): boolean {
    if (this.#closed || this.#registry.isClosed) {
      this.close();
      return true;
    }
    return false;
  }

  nextToolResultMaintenanceRuntime() {
    if (this.#isClosed()) return null;
    const owner = this.#factory.sharedResourceOwner;
    if (owner !== undefined) {
      this.#sharedMaintenanceTurn = !this.#sharedMaintenanceTurn;
      if (!this.#sharedMaintenanceTurn) return owner;
    }
    return this.#registry.nextToolResultMaintenanceRuntime() ?? owner ?? null;
  }

  nextToolResultMaintenanceLease() {
    if (this.#isClosed()) return null;
    const owner = this.#factory.sharedResourceOwner;
    if (owner !== undefined) {
      this.#sharedMaintenanceTurn = !this.#sharedMaintenanceTurn;
      if (!this.#sharedMaintenanceTurn)
        return this.#withSharedOwner(externalResourceLease(owner));
    }
    const lease =
      this.#registry.nextToolResultMaintenanceLease() ??
      (owner === undefined ? null : externalResourceLease(owner));
    return lease === null ? null : this.#withSharedOwner(lease);
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
    if (asset.agentVersionId !== locator.agentVersionId) {
      throw new AgentVersionRuntimeError(
        "agent_version_store_identity_mismatch",
      );
    }
    if (this.#isClosed()) return null;
    const version = parseAgentVersionAsset(asset, this.#digester);
    // Another resolver may have registered this version while Store I/O was in
    // flight. Reuse that owner before reserving capacity for a duplicate.
    const resident = this.#registry.peekResident(locator);
    if (resident !== null) {
      if (resident.version.contentDigest !== version.contentDigest)
        throw new AgentVersionRuntimeError("agent_version_runtime_id_conflict");
      return resident;
    }
    const ownership =
      this.#factory.runtimeOwnership === undefined
        ? this.#factory.sharedResourceOwner === undefined
          ? "ownedRuntime"
          : "sharedProjection"
        : this.#factory.runtimeOwnership({
            tenantId: locator.tenantId,
            version,
          });
    if (
      (ownership !== "ownedRuntime" && ownership !== "sharedProjection") ||
      (ownership === "sharedProjection" &&
        this.#factory.sharedResourceOwner === undefined)
    ) {
      throw new AgentVersionRuntimeError(
        "agent_version_runtime_ownership_invalid",
      );
    }
    const admitted = await createAdmittedAgentRuntime({
      capacity: this.#registry.capacity,
      factory: this.#factory,
      ownership,
      tenantId: locator.tenantId,
      version,
    });
    const { runtime } = admitted;
    if (
      runtime.version.agentVersionId !== version.agentVersionId ||
      runtime.version.contentDigest !== version.contentDigest
    ) {
      await closeAdmittedAgentRuntime(admitted);
      throw new AgentVersionRuntimeError(
        "agent_version_runtime_factory_mismatch",
      );
    }
    if (this.#isClosed()) {
      await closeAdmittedAgentRuntime(admitted);
      return null;
    }
    if (ownership === "sharedProjection") {
      try {
        // The opt-in is a factory ownership contract, not inferred from an empty catalog.
        if (runtime.close !== undefined) {
          throw new AgentVersionRuntimeError(
            "agent_version_shared_runtime_owns_resources",
          );
        }
        validateAgentVersionRuntime(runtime, this.#digester);
      } catch (error) {
        await closeAdmittedAgentRuntime(admitted);
        throw error;
      }
      if (this.#isClosed()) return null;
      // Bootstrap/additional owners remain pinned and take precedence over projections.
      const pinned = this.#registry.peekResident(locator);
      if (pinned !== null) {
        if (pinned.version.contentDigest !== version.contentDigest) {
          throw new AgentVersionRuntimeError(
            "agent_version_runtime_id_conflict",
          );
        }
        return pinned;
      }
      this.#sharedCache.put(locator, runtime);
      return runtime;
    }
    let disposition: "registered" | "existing";
    try {
      disposition = this.#registry.registerReconstructible({
        tenantId: locator.tenantId,
        runtime,
        ...(admitted.reservation === null
          ? {}
          : { reservation: admitted.reservation }),
      }).disposition;
    } catch (error) {
      await closeAdmittedAgentRuntime(admitted);
      throw error;
    }
    if (disposition === "existing") {
      if (runtime === this.#registry.peekResident(locator))
        admitted.reservation?.release();
      else await closeAdmittedAgentRuntime(admitted);
    }
    return this.#registry.peekResident(locator);
  }
}

class StoreBackedPriorModelCompactionResolver
  implements PriorModelCompactionResolverPort
{
  readonly #resolver: StoreBackedAgentVersionRuntimeResolver;

  constructor(resolver: StoreBackedAgentVersionRuntimeResolver) {
    this.#resolver = resolver;
  }

  async acquire(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<RuntimeResourceLease<PriorModelCompactionRuntime> | null> {
    const lease = await this.#resolver.acquire(input);
    if (lease === null) return null;
    const runtime = lease.resource;
    return {
      resource: {
        executionAuthority: runtime.executionAuthority,
        compactor: runtime.contextCompactor,
        ...(runtime.governedContext === undefined
          ? {}
          : { governedContext: runtime.governedContext }),
      },
      release: lease.release,
    };
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
          executionAuthority: runtime.executionAuthority,
          compactor: runtime.contextCompactor,
          ...(runtime.governedContext === undefined
            ? {}
            : { governedContext: runtime.governedContext }),
        };
  }
}
