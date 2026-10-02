import type {
  PluginDisposable,
  PluginIdentity,
  PluginJsonValue,
} from "./sdk-types.js";
import type { PluginToolRuntime } from "./tool-runtime-types.js";

export const CREWON_EXECUTION_SERVICE = "crewon.execution";
export const CREWON_EXECUTION_API_VERSION = "1";

/** Host-derived immutable Run/configuration metadata; none of these values grants authority. */
export type PluginToolRuntimeContext = Readonly<{
  identity: PluginIdentity;
  scope: Readonly<{ tenantId: string; spaceId: string; profileId: string }>;
  run: Readonly<{
    runId: string;
    threadId: string;
    bindingDigest: string;
    inputDigest: string;
    source: Readonly<{
      runId: string;
      operationId: string;
      bindingDigest: string;
    }> | null;
  }>;
  configuration: Readonly<{
    revision: number;
    contentDigest: string;
    parameters: Readonly<Record<string, PluginJsonValue>>;
    /** Opaque host references only, never credential values. */
    credentialBindings: readonly Readonly<{
      slotId: string;
      credentialBindingId: string;
    }>[];
  }>;
  target: Readonly<{
    executionAuthority: "crewonKernel";
    agentVersionId: string;
    agentVersionContentDigest: string;
    materializationDigest: string;
    authorityId: string;
    runtimeGeneration: string;
    policySnapshotId: string;
    workspaceBindingId: string | null;
  }>;
}>;

export interface PluginToolRuntimeFactory {
  create(
    context: PluginToolRuntimeContext,
  ): PluginToolRuntime | Promise<PluginToolRuntime>;
}

/** Explicitly declared host service, bound by the host to the actual package identity. */
export interface PluginExecutionService {
  register(factory: PluginToolRuntimeFactory): PluginDisposable;
}
