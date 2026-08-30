import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { AgentVersionDeployment } from "@crewon/application";
import type { GovernedContextBundle } from "@crewon/context";
import type { ToolRuntimePort } from "@crewon/tool-broker";

import {
  AgentVersionRuntimeError,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import { scopeToolRuntimeToAgentVersion } from "./agent-version-tool-runtime.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

export type AgentVersionRuntimeBinding = Readonly<{
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  authorityId: string;
  workspaceBindingId: string | null;
  materializationDigest: string;
  toolRuntimeMode?: "independent" | "shared";
  createTransport(
    version: CompiledAgentVersion,
  ): ModelTransportPort | Promise<ModelTransportPort>;
  createToolRuntime(
    version: CompiledAgentVersion,
  ): ToolRuntimePort | Promise<ToolRuntimePort>;
  createGovernedContext?(
    version: CompiledAgentVersion,
  ):
    | GovernedContextBundle
    | undefined
    | Promise<GovernedContextBundle | undefined>;
}>;

/** Exact digest-bound catalog capable of materializing independent provider runtimes. */
export class ConfiguredAgentVersionRuntimeFactory
  implements AgentVersionRuntimeFactoryPort
{
  readonly #bindings = new Map<string, AgentVersionRuntimeBinding>();

  constructor(bindings: readonly AgentVersionRuntimeBinding[]) {
    for (const binding of bindings) {
      validateBinding(binding);
      const key = bindingKey(binding.tenantId, binding.agentVersionId);
      const existing = this.#bindings.get(key);
      if (
        existing !== undefined &&
        existing.contentDigest !== binding.contentDigest
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_runtime_binding_conflict",
        );
      }
      if (existing !== undefined) {
        throw new AgentVersionRuntimeError(
          "agent_version_runtime_binding_duplicate",
        );
      }
      this.#bindings.set(key, binding);
    }
  }

  deploymentBindings(
    tenantId: string,
  ): readonly Omit<AgentVersionDeployment, "deployedAt">[] {
    return [...this.#bindings.values()]
      .filter((binding) => binding.tenantId === tenantId)
      .map((binding) => ({
        schemaVersion: "crewon.agent-version-deployment.v0",
        tenantId: binding.tenantId,
        agentVersionId: binding.agentVersionId,
        contentDigest: binding.contentDigest,
        materializationDigest: binding.materializationDigest,
        authorityId: binding.authorityId,
        workspaceBindingId: binding.workspaceBindingId,
      }));
  }

  async create(input: {
    tenantId: string;
    version: CompiledAgentVersion;
  }): Promise<AgentVersionRuntime> {
    return this.#create(input);
  }

  bindSharedToolRuntime(
    runtime: ToolRuntimePort,
  ): AgentVersionRuntimeFactoryPort {
    return {
      create: (input) => this.#create(input, runtime),
    };
  }

  async #create(
    input: { tenantId: string; version: CompiledAgentVersion },
    sharedToolRuntime?: ToolRuntimePort,
  ): Promise<AgentVersionRuntime> {
    const binding = this.#bindings.get(
      bindingKey(input.tenantId, input.version.agentVersionId),
    );
    if (binding === undefined) {
      throw new AgentVersionRuntimeError("agent_version_runtime_not_deployed");
    }
    if (binding.contentDigest !== input.version.contentDigest) {
      throw new AgentVersionRuntimeError(
        "agent_version_runtime_digest_not_deployed",
      );
    }
    const workspaceRequired = input.version.resources.workspaceRequired;
    if (workspaceRequired !== (binding.workspaceBindingId !== null)) {
      throw new AgentVersionRuntimeError(
        "agent_version_workspace_binding_mismatch",
      );
    }

    let transport: ModelTransportPort | null = null;
    let toolRuntime: ToolRuntimePort | null = null;
    const ownsToolRuntime = binding.toolRuntimeMode !== "shared";
    try {
      transport = await binding.createTransport(input.version);
      if (
        transport.adapterName !== input.version.model.adapterName ||
        transport.adapterVersion !== input.version.model.adapterVersion ||
        transport.modelId !== input.version.model.modelId
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_runtime_model_mismatch",
        );
      }
      await transport.prewarm?.(new AbortController().signal);
      if (!ownsToolRuntime && sharedToolRuntime === undefined) {
        throw new AgentVersionRuntimeError(
          "agent_version_shared_tool_runtime_missing",
        );
      }
      toolRuntime = ownsToolRuntime
        ? await binding.createToolRuntime(input.version)
        : sharedToolRuntime!;
      const scopedToolRuntime = scopeToolRuntimeToAgentVersion(
        toolRuntime,
        input.version.tools,
      );
      const governedContext = await binding.createGovernedContext?.(
        input.version,
      );
      const kernel = new CrewONAgentKernel({
        transport,
        instructions: input.version.instructions,
        toolCatalog: { definitions: () => input.version.tools },
        streamMaxRetries: input.version.execution.streamMaxRetries,
      });
      const ownedTransport = transport;
      const ownedToolRuntime = ownsToolRuntime ? toolRuntime : null;
      let closed = false;
      return {
        version: input.version,
        kernel,
        policy: new PinnedRunExecutionPolicy({
          authorityId: binding.authorityId,
          runtimeGeneration: input.version.runtimeGeneration,
          agentVersionId: input.version.agentVersionId,
          policySnapshotId: input.version.policySnapshotId,
          workspaceBindingId: binding.workspaceBindingId,
        }),
        toolRuntime: scopedToolRuntime,
        contextCompactor: new KernelContextCompactor(kernel),
        ...(governedContext === undefined ? {} : { governedContext }),
        close: async () => {
          if (closed) {
            return;
          }
          closed = true;
          await Promise.all([
            ownedToolRuntime?.close?.(),
            ownedTransport.close?.(),
          ]);
        },
      };
    } catch (error) {
      await Promise.allSettled([
        ownsToolRuntime ? toolRuntime?.close?.() : undefined,
        transport?.close?.(),
      ]);
      throw error;
    }
  }
}

function validateBinding(binding: AgentVersionRuntimeBinding): void {
  requireBounded(binding.tenantId, 256, "agent_version_runtime_tenant_invalid");
  requireBounded(
    binding.agentVersionId,
    512,
    "agent_version_runtime_id_invalid",
  );
  requireBounded(
    binding.authorityId,
    512,
    "agent_version_runtime_authority_invalid",
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(binding.contentDigest)) {
    throw new AgentVersionRuntimeError("agent_version_runtime_digest_invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(binding.materializationDigest)) {
    throw new AgentVersionRuntimeError(
      "agent_version_runtime_materialization_digest_invalid",
    );
  }
  if (binding.workspaceBindingId !== null) {
    requireBounded(
      binding.workspaceBindingId,
      512,
      "agent_version_runtime_workspace_invalid",
    );
  }
  if (
    binding.toolRuntimeMode !== undefined &&
    binding.toolRuntimeMode !== "independent" &&
    binding.toolRuntimeMode !== "shared"
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_tool_runtime_mode_invalid",
    );
  }
}

function bindingKey(tenantId: string, agentVersionId: string): string {
  return JSON.stringify([tenantId, agentVersionId]);
}

function requireBounded(value: unknown, maxLength: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new AgentVersionRuntimeError(code);
  }
}
