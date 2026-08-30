import {
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { AgentVersionStore, ContentDigester } from "@crewon/application";
import type { ToolRuntimePort } from "@crewon/tool-broker";

import {
  AgentVersionRuntimeError,
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";

export interface AgentVersionRuntimeFactoryPort {
  create(input: {
    tenantId: string;
    version: CompiledAgentVersion;
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
        const runtime = await this.#factory.create({ tenantId, version });
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
            tenantId,
            runtime,
          }).disposition;
        } catch (error) {
          await runtime.close?.();
          throw error;
        }
        if (disposition === "registered") {
          loaded += 1;
        } else {
          existing += 1;
          await runtime.close?.();
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
