import type { AgentKernelPort } from "@crewon/agent-kernel/runtime";
import type { CompiledAgentVersion } from "@crewon/agent-version";
import type {
  ContentDigester,
  RunExecutionPolicyPort,
  ThreadModelState,
} from "@crewon/application";
import type {
  ContextCompactorPort,
  GovernedContextBundle,
} from "@crewon/context";
import type { ToolRuntimePort } from "@crewon/tool-broker";

import type {
  PriorModelCompactionResolverPort,
  PriorModelCompactionRuntime,
} from "./model-switch-compaction.ts";

export type AgentVersionRuntime = Readonly<{
  version: CompiledAgentVersion;
  kernel: AgentKernelPort;
  policy: RunExecutionPolicyPort;
  toolRuntime: ToolRuntimePort;
  contextCompactor: ContextCompactorPort;
  governedContext?: GovernedContextBundle;
  close?(): Promise<void>;
}>;

export type AgentVersionRuntimeLocator = Readonly<{
  tenantId: string;
  agentVersionId: string;
}>;

export type ScopedAgentVersionRuntime = Readonly<{
  tenantId: string | null;
  runtime: AgentVersionRuntime;
}>;

/** Resolves every runtime dependency from the immutable AgentVersion pinned by a Run. */
export interface AgentVersionRuntimeResolverPort {
  resolve(
    locator: AgentVersionRuntimeLocator,
  ): AgentVersionRuntime | null | Promise<AgentVersionRuntime | null>;
}

/** Append-only runtime registry; an AgentVersion ID can never be rebound in-process. */
export class InMemoryAgentVersionRuntimeRegistry
  implements AgentVersionRuntimeResolverPort
{
  readonly #digester: ContentDigester;
  readonly #runtimes = new Map<string, AgentVersionRuntime>();
  #closed = false;

  constructor(digester: ContentDigester) {
    this.#digester = digester;
  }

  register(
    scoped: ScopedAgentVersionRuntime,
  ): Readonly<{ disposition: "registered" | "existing" }> {
    if (this.#closed) {
      throw new AgentVersionRuntimeError(
        "agent_version_runtime_registry_closed",
      );
    }
    validateTenantScope(scoped.tenantId);
    const { runtime } = scoped;
    validateRuntime(runtime, this.#digester);
    const key = runtimeKey(scoped.tenantId, runtime.version.agentVersionId);
    const existing = this.#runtimes.get(key);
    if (existing !== undefined) {
      if (existing.version.contentDigest !== runtime.version.contentDigest) {
        throw new AgentVersionRuntimeError("agent_version_runtime_id_conflict");
      }
      return { disposition: "existing" };
    }
    this.#runtimes.set(key, Object.freeze(runtime));
    return { disposition: "registered" };
  }

  resolve(locator: AgentVersionRuntimeLocator): AgentVersionRuntime | null {
    if (this.#closed) {
      return null;
    }
    validateTenantScope(locator.tenantId);
    return (
      this.#runtimes.get(
        runtimeKey(locator.tenantId, locator.agentVersionId),
      ) ??
      this.#runtimes.get(runtimeKey(null, locator.agentVersionId)) ??
      null
    );
  }

  priorModelCompactionResolver(): PriorModelCompactionResolverPort {
    return new RegistryPriorModelCompactionResolver(this);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.all(
      [...this.#runtimes.values()].map((runtime) => runtime.close?.()),
    );
  }
}

export class AgentVersionRuntimeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AgentVersionRuntimeError";
    this.code = code;
  }
}

class RegistryPriorModelCompactionResolver
  implements PriorModelCompactionResolverPort
{
  readonly #registry: AgentVersionRuntimeResolverPort;

  constructor(registry: AgentVersionRuntimeResolverPort) {
    this.#registry = registry;
  }

  async resolve(
    prior: ThreadModelState,
  ): Promise<PriorModelCompactionRuntime | null> {
    const runtime = await this.#registry.resolve({
      tenantId: prior.tenantId,
      agentVersionId: prior.agentVersionId,
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

function runtimeKey(tenantId: string | null, agentVersionId: string): string {
  return JSON.stringify([tenantId, agentVersionId]);
}

function validateTenantScope(tenantId: string | null): void {
  if (
    tenantId !== null &&
    (typeof tenantId !== "string" ||
      tenantId.trim().length === 0 ||
      tenantId.length > 256)
  ) {
    throw new AgentVersionRuntimeError("agent_version_runtime_tenant_invalid");
  }
}

function validateRuntime(
  runtime: AgentVersionRuntime,
  digester: ContentDigester,
): void {
  const identity = runtime.kernel.modelIdentity;
  if (
    identity.adapterName !== runtime.version.model.adapterName ||
    identity.adapterVersion !== runtime.version.model.adapterVersion ||
    identity.modelId !== runtime.version.model.modelId
  ) {
    throw new AgentVersionRuntimeError("agent_version_runtime_model_mismatch");
  }
  if (
    JSON.stringify(runtime.toolRuntime.definitions()) !==
    JSON.stringify(runtime.version.tools)
  ) {
    throw new AgentVersionRuntimeError("agent_version_runtime_tools_mismatch");
  }
  const governedContextDigest =
    runtime.governedContext === undefined
      ? null
      : digester.sha256(JSON.stringify(runtime.governedContext.modelItems()));
  if (
    governedContextDigest !== runtime.version.resources.governedContextDigest
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_runtime_context_mismatch",
    );
  }
}
