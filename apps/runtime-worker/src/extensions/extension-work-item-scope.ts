import {
  copyWorkItemExecutionScope,
  type WorkItemExecutionScope,
} from "@crewon/application";
import {
  parseExtensionExecutionTarget,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import type { RuntimeAgentVersionReleasePlan } from "../agent-version-release.ts";
import { bundledComfyRegistration } from "./comfyui-bundled-registration.ts";

export type ExtensionExecutionMode = "current" | "historical";

export function parseExtensionExecutionMode(
  input: unknown,
): ExtensionExecutionMode {
  if (input === undefined || input === "current") return "current";
  if (input === "historical") return input;
  throw new Error("extension_execution_mode_invalid");
}

/** The implementation comes from this loaded host, never a caller-supplied digest. */
export function extensionWorkItemExecutionScope(input: {
  tenantId: string;
  mode: ExtensionExecutionMode;
  targets: readonly ExtensionExecutionTarget[];
}): WorkItemExecutionScope {
  return copyWorkItemExecutionScope({
    tenantId: input.tenantId,
    extensionImplementationDigest:
      bundledComfyRegistration().implementationDigest,
    unboundRuns:
      parseExtensionExecutionMode(input.mode) === "current"
        ? "include"
        : "exclude",
    extensionTargets: input.targets,
  });
}

/** Release metadata is scheduling affinity, never a substitute for live acquire. */
export function preparedExtensionExecutionTargets(input: {
  tenantId: string;
  agentVersionIds: readonly string[];
  releasePlan: RuntimeAgentVersionReleasePlan;
}): readonly ExtensionExecutionTarget[] {
  if (
    input.agentVersionIds.length > 32 ||
    new Set(input.agentVersionIds).size !== input.agentVersionIds.length
  )
    throw new Error("extension_execution_targets_invalid");
  const versions = new Map(
    input.releasePlan.versions.map((version) => [
      version.agentVersionId,
      version,
    ]),
  );
  const deployments = new Map(
    input.releasePlan.deployments.map((deployment) => [
      deployment.agentVersionId,
      deployment,
    ]),
  );
  return Object.freeze(
    input.agentVersionIds.map((agentVersionId) => {
      const version = versions.get(agentVersionId);
      const deployment = deployments.get(agentVersionId);
      if (
        version === undefined ||
        deployment === undefined ||
        deployment.tenantId !== input.tenantId ||
        deployment.contentDigest !== version.contentDigest
      )
        throw new Error("extension_execution_targets_invalid");
      return parseExtensionExecutionTarget({
        executionAuthority: "crewonKernel",
        agentVersionId,
        agentVersionContentDigest: version.contentDigest,
        materializationDigest: deployment.materializationDigest,
        authorityId: deployment.authorityId,
        runtimeGeneration: version.runtimeGeneration,
        policySnapshotId: version.policySnapshotId,
        workspaceBindingId: deployment.workspaceBindingId,
      });
    }),
  );
}
