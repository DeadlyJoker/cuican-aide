import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { AgentVersionDeployment } from "@crewon/application";
import type { GovernedContextBundle } from "@crewon/context";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import type { FailedRuntimeCreationCleanup } from "./agent-runtime-capacity.ts";
import {
  RuntimeCreationCleanup,
  type RuntimeCreationOptions,
} from "./runtime-creation-cleanup.ts";

import {
  AgentVersionRuntimeError,
  type AgentExecutionAuthority,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import { scopeToolRuntimeToAgentVersion } from "./agent-version-tool-runtime.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import { readRuntimeExtensionMaterializations } from "./extensions/extension-runtime-proof.ts";
import {
  captureSavedImageReviewRuntimePurpose,
  MediaImageReviewRoutingKernel,
  type SavedImageReviewRuntimePurpose,
} from "./media-image-review-routing-kernel.ts";

export type AgentVersionRuntimeBinding = Readonly<{
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  authorityId: string;
  workspaceBindingId: string | null;
  materializationDigest: string;
  executionAuthority: AgentExecutionAuthority;
  toolRuntimeMode?: "independent" | "shared";
  /** Request-owned HTTP transports have no prewarm/close resource owner. */
  transportOwnership?: "runtime" | "request";
  /** Trusted Native binding only; metadata or an ordinary text runtime cannot enable image review. */
  savedImageReview?: SavedImageReviewRuntimePurpose;
  createTransport(
    version: CompiledAgentVersion,
    options?: RuntimeCreationOptions,
  ): ModelTransportPort | Promise<ModelTransportPort>;
  createToolRuntime(
    version: CompiledAgentVersion,
    options?: RuntimeCreationOptions,
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
      const savedImageReview =
        binding.savedImageReview === undefined
          ? undefined
          : captureSavedImageReviewRuntimePurpose(binding.savedImageReview);
      if (
        savedImageReview &&
        (savedImageReview.actor.tenantId !== binding.tenantId ||
          binding.workspaceBindingId !== null ||
          binding.executionAuthority !== "crewonKernel" ||
          binding.createGovernedContext !== undefined ||
          binding.toolRuntimeMode === "shared")
      )
        throw new AgentVersionRuntimeError(
          "agent_version_image_review_binding_invalid",
        );
      this.#bindings.set(
        key,
        Object.freeze({
          ...binding,
          ...(savedImageReview ? { savedImageReview } : {}),
        }),
      );
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
    failedCreationCleanup?: FailedRuntimeCreationCleanup;
  }): Promise<AgentVersionRuntime> {
    return this.#create(input);
  }

  bindSharedToolRuntime(
    runtime: ToolRuntimePort,
  ): AgentVersionRuntimeFactoryPort {
    return {
      sharedResourceOwner: runtime,
      runtimeOwnership: (input) =>
        isSharedProjection(this.#bindingFor(input))
          ? "sharedProjection"
          : "ownedRuntime",
      create: (input) => this.#create(input, runtime),
    };
  }

  async #create(
    input: {
      tenantId: string;
      version: CompiledAgentVersion;
      failedCreationCleanup?: FailedRuntimeCreationCleanup;
    },
    sharedToolRuntime?: ToolRuntimePort,
  ): Promise<AgentVersionRuntime> {
    const creation = new RuntimeCreationCleanup(input.failedCreationCleanup);
    try {
      const binding = this.#bindingFor(input);
      const sharedProjection =
        sharedToolRuntime !== undefined && isSharedProjection(binding);
      const ownsToolRuntime = binding.toolRuntimeMode !== "shared";
      const transport = await creation.create((options) =>
        binding.createTransport(input.version, options),
      );
      if (
        transport.adapterName !== input.version.model.adapterName ||
        transport.adapterVersion !== input.version.model.adapterVersion ||
        transport.modelId !== input.version.model.modelId ||
        transport.maxOutputTokens !== input.version.model.maxOutputTokens
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_runtime_model_mismatch",
        );
      }
      if (
        binding.transportOwnership === "request" &&
        (transport.close !== undefined || transport.prewarm !== undefined)
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_request_transport_owns_resources",
        );
      }
      if (transport.prewarm !== undefined && transport.close === undefined)
        creation.requireConfirmation();
      await transport.prewarm?.(new AbortController().signal);
      if (!ownsToolRuntime && sharedToolRuntime === undefined) {
        throw new AgentVersionRuntimeError(
          "agent_version_shared_tool_runtime_missing",
        );
      }
      const toolRuntime = ownsToolRuntime
        ? await creation.create((options) =>
            binding.createToolRuntime(input.version, options),
          )
        : sharedToolRuntime!;
      const scopedToolRuntime = scopeToolRuntimeToAgentVersion(
        toolRuntime,
        input.version.tools,
      );
      const extensions = readRuntimeExtensionMaterializations(toolRuntime);
      if (
        extensions !== null &&
        extensions.some(
          (proof) =>
            binding.executionAuthority !== "crewonKernel" ||
            proof.configuration.tenantId !== input.tenantId ||
            proof.target.agentVersionId !== input.version.agentVersionId ||
            proof.target.agentVersionContentDigest !==
              input.version.contentDigest ||
            proof.target.materializationDigest !==
              binding.materializationDigest ||
            proof.target.authorityId !== binding.authorityId ||
            proof.target.workspaceBindingId !== binding.workspaceBindingId ||
            proof.target.runtimeGeneration !==
              input.version.runtimeGeneration ||
            proof.target.policySnapshotId !== input.version.policySnapshotId,
        )
      )
        throw new AgentVersionRuntimeError(
          "extension_runtime_materialization_mismatch",
        );
      // GovernedContextBundle has no disposal contract; its construction cannot
      // prove cleanup on failure merely by returning a value.
      if (binding.createGovernedContext !== undefined)
        creation.requireConfirmation();
      const governedContext = await binding.createGovernedContext?.(
        input.version,
      );
      const baseKernel = new CrewONAgentKernel({
        transport,
        instructions: input.version.instructions,
        toolCatalog: { definitions: () => input.version.tools },
        streamMaxRetries: input.version.execution.streamMaxRetries,
      });
      const route = {
        authorityId: binding.authorityId,
        runtimeGeneration: input.version.runtimeGeneration,
        agentVersionId: input.version.agentVersionId,
        policySnapshotId: input.version.policySnapshotId,
        workspaceBindingId: binding.workspaceBindingId,
      };
      const reviewKernel =
        binding.savedImageReview === undefined
          ? null
          : creation.own(
              new MediaImageReviewRoutingKernel({
                kernel: baseKernel,
                purpose: binding.savedImageReview,
                route,
              }),
            );
      const kernel = reviewKernel ?? baseKernel;
      const ownedTransport = transport;
      const ownedToolRuntime = ownsToolRuntime ? toolRuntime : null;
      let closeTask: Promise<void> | null = null;
      const runtime: AgentVersionRuntime = {
        version: input.version,
        executionAuthority: binding.executionAuthority,
        kernel,
        policy: new PinnedRunExecutionPolicy(route),
        toolRuntime: scopedToolRuntime,
        contextCompactor: new KernelContextCompactor(kernel),
        ...(extensions === null ? {} : { extensions }),
        ...(governedContext === undefined ? {} : { governedContext }),
        ...(sharedProjection
          ? {}
          : {
              canRetire: () =>
                closeTask === null &&
                binding.transportOwnership === "request" &&
                binding.createGovernedContext === undefined &&
                (ownedToolRuntime === null ||
                  ownedToolRuntime.canRetire?.() === true),
              close: () => {
                closeTask ??= Promise.allSettled([
                  Promise.resolve().then(() => ownedToolRuntime?.close?.()),
                  Promise.resolve().then(() => ownedTransport.close?.()),
                  Promise.resolve().then(() => reviewKernel?.close()),
                ]).then((results) => {
                  const failures = results.flatMap((result) =>
                    result.status === "rejected" ? [result.reason] : [],
                  );
                  if (failures.length > 0)
                    throw new AggregateError(
                      failures,
                      "agent_version_runtime_close_failed",
                    );
                });
                return closeTask;
              },
            }),
      };
      creation.transfer();
      return runtime;
    } catch (error) {
      await creation.cleanup();
      throw error;
    }
  }

  #bindingFor(input: {
    tenantId: string;
    version: CompiledAgentVersion;
  }): AgentVersionRuntimeBinding {
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
    validateVersionAuthority(binding.executionAuthority, input.version);
    if (
      binding.savedImageReview &&
      (input.version.tools.length !== 0 ||
        input.version.resources.workspaceRequired ||
        input.version.resources.governedContextDigest !== null ||
        input.version.model.autoCompactAtTokens !== null)
    )
      throw new AgentVersionRuntimeError(
        "agent_version_image_review_version_invalid",
      );
    return binding;
  }
}

function isSharedProjection(binding: AgentVersionRuntimeBinding): boolean {
  return (
    binding.toolRuntimeMode === "shared" &&
    binding.transportOwnership === "request" &&
    binding.createGovernedContext === undefined
  );
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
  if (
    binding.executionAuthority !== "crewonKernel" &&
    binding.executionAuthority !== "providerAgent"
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_execution_authority_invalid",
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
    binding.transportOwnership !== undefined &&
    binding.transportOwnership !== "runtime" &&
    binding.transportOwnership !== "request"
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_transport_ownership_invalid",
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

function validateVersionAuthority(
  authority: AgentExecutionAuthority,
  version: CompiledAgentVersion,
): void {
  if (
    authority === "providerAgent" &&
    (version.instructions !== null ||
      version.tools.length !== 0 ||
      version.resources.governedContextDigest !== null ||
      version.resources.workspaceRequired)
  ) {
    throw new AgentVersionRuntimeError(
      "agent_version_provider_authority_mismatch",
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
