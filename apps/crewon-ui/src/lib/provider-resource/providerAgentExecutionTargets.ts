import type { ResourceRef } from "@crewon-platform-protocol/v2/ResourceRef";

import type { ExecutionTargetOption } from "../scene/sceneCatalog";

const providerAgentTargetPrefix = "provider-agent:";

export function providerAgentExecutionTargetOptions(
  resources: ResourceRef[],
): ExecutionTargetOption[] {
  return resources
    .filter((resource) => resource.resourceType === "agent")
    .map((resource) => ({
      detail: `${resource.providerId} · revision ${resource.revision}`,
      kind: "agent" as const,
      label: `${resource.resourceId} · 在线 Agent`,
      strategy: "single" as const,
      value: providerAgentTargetValue(resource),
    }));
}

export function providerAgentResourceForTarget(
  resources: ResourceRef[],
  target: string,
): ResourceRef | null {
  if (!target.startsWith(providerAgentTargetPrefix)) {
    return null;
  }
  return (
    resources.find((resource) => providerAgentTargetValue(resource) === target) ??
    null
  );
}

function providerAgentTargetValue(resource: ResourceRef): string {
  return `${providerAgentTargetPrefix}${encodeURIComponent(
    [resource.providerId, resource.resourceId, resource.revision].join("\u0000"),
  )}`;
}
