import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import type { RunRoute } from "@crewon/application";
import type { GovernedContextBundle } from "@crewon/context";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import { AgentVersionRuntimeError } from "./agent-version-runtime.ts";
import type { AgentVersionRuntimeFactoryPort } from "./durable-agent-version-runtime-loader.ts";
import { scopeToolRuntimeToAgentVersion } from "./agent-version-tool-runtime.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

type SharedAgentVersionRuntimeConfig = Readonly<{
  transport: ModelTransportPort;
  route: RunRoute;
  governedContext?: GovernedContextBundle;
}>;

/** Historical projections own no connections or Tool results; the bootstrap owns shared resources. */
export function sharedAgentVersionRuntimeFactory(
  config: SharedAgentVersionRuntimeConfig,
  toolRuntime: ToolRuntimePort,
): AgentVersionRuntimeFactoryPort {
  return {
    sharedResourceOwner: toolRuntime,
    create: ({ version }) => {
      if (
        version.model.adapterName !== config.transport.adapterName ||
        version.model.adapterVersion !== config.transport.adapterVersion ||
        version.model.modelId !== config.transport.modelId
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_transport_not_configured",
        );
      }
      if (
        version.resources.workspaceRequired !==
        (config.route.workspaceBindingId !== null)
      ) {
        throw new AgentVersionRuntimeError(
          "agent_version_workspace_binding_mismatch",
        );
      }
      const kernel = new CrewONAgentKernel({
        transport: config.transport,
        instructions: version.instructions,
        toolCatalog: { definitions: () => version.tools },
        streamMaxRetries: version.execution.streamMaxRetries,
      });
      const versionToolRuntime = scopeToolRuntimeToAgentVersion(
        toolRuntime,
        version.tools,
      );
      return {
        version,
        executionAuthority: "crewonKernel",
        kernel,
        policy: new PinnedRunExecutionPolicy({
          ...config.route,
          runtimeGeneration: version.runtimeGeneration,
          agentVersionId: version.agentVersionId,
          policySnapshotId: version.policySnapshotId,
        }),
        toolRuntime: versionToolRuntime,
        contextCompactor: new KernelContextCompactor(kernel),
        ...(config.governedContext === undefined
          ? {}
          : { governedContext: config.governedContext }),
      };
    },
  };
}
