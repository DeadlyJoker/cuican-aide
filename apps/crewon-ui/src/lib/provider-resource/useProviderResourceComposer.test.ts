import { describe, expect, it } from "vitest";

import type { ResourceRef } from "@crewon/app-server-protocol/platform/v2/ResourceRef";
import type { ProviderResourceSnapshot } from "./providerResourceSession";

import {
  executionBindingIdForResource,
  providerConversationResources,
  providerExecutionAgentResources,
} from "./useProviderResourceComposer";

describe("providerConversationResources", () => {
  it("exposes only Provider resource kinds backed by the current server dispatcher", () => {
    const resources: ResourceRef[] = [
      resource("agent"),
      resource("skill"),
      resource("mcpServer"),
      resource("mcpTool"),
      resource("knowledgeBase"),
      resource("workflow"),
    ];

    expect(providerConversationResources(resources)).toEqual([
      resource("mcpTool"),
      resource("knowledgeBase"),
    ]);
  });

  it("exposes only Provider-managed remote Agents as execution targets", () => {
    const resources = [resource("agent"), resource("knowledgeBase")];
    const snapshot = {
      provider: {
        resourceCapabilities: [
          {
            resourceType: "agent",
            mode: "providerManaged",
            executionLocation: "provider",
          },
        ],
      },
    } as ProviderResourceSnapshot;

    expect(providerExecutionAgentResources(resources, snapshot)).toEqual([
      resource("agent"),
    ]);
    expect(
      providerExecutionAgentResources(resources, {
        ...snapshot,
        provider: snapshot.provider
          ? { ...snapshot.provider, resourceCapabilities: [] }
          : null,
      }),
    ).toEqual([]);
  });

  it("uses only an Agent binding as the Thread execution binding", () => {
    expect(
      executionBindingIdForResource(resource("agent"), "resource-binding-1"),
    ).toBe("resource-binding-1");
    expect(
      executionBindingIdForResource(
        resource("knowledgeBase"),
        "resource-binding-2",
      ),
    ).toBeNull();
  });
});

function resource(resourceType: ResourceRef["resourceType"]): ResourceRef {
  return {
    providerId: "agent-platform",
    resourceId: `resource-${resourceType}`,
    revision: "revision-1",
    resourceType,
  };
}
