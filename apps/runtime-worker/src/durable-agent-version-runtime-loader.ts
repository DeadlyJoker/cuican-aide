import {
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { AgentVersionStore, ContentDigester } from "@crewon/application";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import type { FailedRuntimeCreationCleanup } from "./agent-runtime-capacity.ts";
import {
  createAdmittedAgentRuntime,
  closeAdmittedAgentRuntime,
} from "./admitted-agent-runtime-creation.ts";

import {
  AgentVersionRuntimeError,
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";

export interface AgentVersionRuntimeFactoryPort {
  /**
   * Owner of Tool results that outlive cacheable projections. Unless ownership
   * is selected per version below, every produced runtime must be a projection
   * with no owned resources or close hook. Active callers may keep using an
   * evicted projection; this owner maintains its Tool results independently.
   */
  readonly sharedResourceOwner?: ToolRuntimePort;
  /** Optional for mixed factories; selection is synchronous and performs no I/O. */
  runtimeOwnership?(input: {
    tenantId: string;
    version: CompiledAgentVersion;
  }): "sharedProjection" | "ownedRuntime";
  create(input: {
    tenantId: string;
    version: CompiledAgentVersion;
    failedCreationCleanup?: FailedRuntimeCreationCleanup;
  }): AgentVersionRuntime | Promise<AgentVersionRuntime>;
  bindSharedToolRuntime?(
    runtime: ToolRuntimePort,
  ): AgentVersionRuntimeFactoryPort;
}

/** Loads verified durable AgentVersions and binds their tenant-scoped runtimes at startup. */
export class DurableAgentVersionRuntimeLoader {
  readonly #store: AgentVersionStore;
  readonly #digester: ContentDigester;
  readonly #factory: AgentVersionRuntimeFactoryPort;
  readonly #registry: InMemoryAgentVersionRuntimeRegistry;
  readonly #pageSize: number;
  readonly #maxVersions: number;

  constructor(dependencies: {
    store: AgentVersionStore;
    digester: ContentDigester;
    factory: AgentVersionRuntimeFactoryPort;
    registry: InMemoryAgentVersionRuntimeRegistry;
    pageSize?: number;
    maxVersions?: number;
  }) {
    this.#store = dependencies.store;
    this.#digester = dependencies.digester;
    this.#factory = dependencies.factory;
    this.#registry = dependencies.registry;
    this.#pageSize = boundedInteger(
      dependencies.pageSize ?? 100,
      1,
      1_000,
      "agent_version_loader_page_size_invalid",
    );
    this.#maxVersions = boundedInteger(
      dependencies.maxVersions ?? 10_000,
      1,
      100_000,
      "agent_version_loader_limit_invalid",
    );
  }

  async loadTenant(tenantId: string): Promise<
    Readonly<{
      loaded: number;
      existing: number;
    }>
  > {
    const creation = this.#registry.capacity.beginCreation();
    try {
      return await this.#loadTenant(tenantId);
    } finally {
      creation.release();
    }
  }

  async #loadTenant(
    tenantId: string,
  ): Promise<Readonly<{ loaded: number; existing: number }>> {
    let afterAgentVersionId: string | null = null;
    let loaded = 0;
    let existing = 0;
    for (;;) {
      const page = await this.#store.listAgentVersions({
        tenantId,
        afterAgentVersionId,
        limit: this.#pageSize,
      });
      if (page.length === 0) {
        return { loaded, existing };
      }
      for (const asset of page) {
        if (
          asset.tenantId !== tenantId ||
          (afterAgentVersionId !== null &&
            asset.agentVersionId <= afterAgentVersionId)
        ) {
          throw new AgentVersionRuntimeError(
            "agent_version_loader_page_invalid",
          );
        }
        if (loaded + existing >= this.#maxVersions) {
          throw new AgentVersionRuntimeError(
            "agent_version_loader_limit_exceeded",
          );
        }
        const version = parseAgentVersionAsset(asset, this.#digester);
        const resident = this.#registry.resolve({
          tenantId,
          agentVersionId: version.agentVersionId,
        });
        if (resident !== null) {
          if (resident.version.contentDigest !== version.contentDigest)
            throw new AgentVersionRuntimeError(
              "agent_version_runtime_id_conflict",
            );
          existing++;
          afterAgentVersionId = asset.agentVersionId;
          continue;
        }
        const admitted = await createAdmittedAgentRuntime({
          capacity: this.#registry.capacity,
          factory: this.#factory,
          tenantId,
          version,
          ownership: "ownedRuntime",
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
        let disposition: "registered" | "existing";
        try {
          disposition = this.#registry.register({
            tenantId,
            runtime,
            reservation: admitted.reservation!,
          }).disposition;
        } catch (error) {
          await closeAdmittedAgentRuntime(admitted);
          throw error;
        }
        if (disposition === "registered") {
          loaded += 1;
        } else {
          existing += 1;
          if (
            runtime ===
            this.#registry.peekResident({
              tenantId,
              agentVersionId: version.agentVersionId,
            })
          )
            admitted.reservation?.release();
          else await closeAdmittedAgentRuntime(admitted);
        }
        afterAgentVersionId = asset.agentVersionId;
      }
      if (page.length < this.#pageSize) {
        return { loaded, existing };
      }
    }
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AgentVersionRuntimeError(code);
  }
  return value;
}
